// Change timeline ingest: resumable 90-day backfill per tracked event name, then overlapping incremental reads.
// 변경 기록 수집: 이벤트 이름별 재개 가능한 90일 백필 후, 겹치는 구간으로 증분 수집.
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getAccounts, getHostAccount } from '@/lib/app-config';
import { accountCredentials, cloudTrailSlot } from '@/lib/cloudtrail-access';
import { eventNamesFor } from './catalog';
import { toRecords } from './parse';
import { appendRecords, readState, writeState } from './store';
import type { AccountRegionState, ChangeRecord, TrackedRegion } from './types';

export type LookupPage = { events: Array<{ CloudTrailEvent?: string }>; nextToken?: string };
export type LookupFn = (
  accountId: string,
  region: string,
  params: { eventName?: string; start: Date; end: Date; nextToken?: string },
) => Promise<LookupPage>;

const SESSION = 'awsops-change-timeline';
const REGIONS: TrackedRegion[] = ['ap-northeast-2', 'us-east-1'];
const BACKFILL_DAYS = 90;
const OVERLAP_MS = 60 * 60_000;
const DEFAULT_MAX_PAGES = 1000; // per-name safety cap, never expected to hit / 이름별 안전 상한

export const defaultLookup: LookupFn = async (accountId, region, p) => {
  // Credentials first: a cold AssumeRole must not delay the send after the pacer slot.
  // 자격증명을 먼저 받고 슬롯을 잡는다 (AssumeRole 지연이 1초 간격을 깨지 않게).
  const creds = await accountCredentials(accountId, SESSION);
  await cloudTrailSlot(accountId, region);
  const client = new CloudTrailClient({ region, ...(creds ? { credentials: creds } : {}) });
  const res = await client.send(new LookupEventsCommand({
    StartTime: p.start,
    EndTime: p.end,
    MaxResults: 50,
    NextToken: p.nextToken,
    LookupAttributes: p.eventName ? [{ AttributeKey: 'EventName', AttributeValue: p.eventName }] : undefined,
  }));
  return { events: (res.Events ?? []).map((e) => ({ CloudTrailEvent: e.CloudTrailEvent })), nextToken: res.NextToken };
};

async function hostAccountId(): Promise<string | undefined> {
  const h = getHostAccount()?.accountId;
  if (h) return h;
  try {
    const r = await new STSClient({ region: 'ap-northeast-2' }).send(new GetCallerIdentityCommand({}));
    return r.Account;
  } catch (e) {
    console.error('[change-timeline] host account lookup failed:', e instanceof Error ? e.name : 'Error');
    return undefined;
  }
}

async function resolveAccounts(): Promise<string[]> {
  const cfg = getAccounts().map((a) => a.accountId);
  if (cfg.length > 0) return cfg;
  const id = await hostAccountId();
  return id ? [id] : [];
}

function parseEvents(page: LookupPage, accountId: string, names: Set<string>): ChangeRecord[] {
  const out: ChangeRecord[] = [];
  for (const e of page.events) {
    if (!e.CloudTrailEvent) continue;
    try {
      for (const r of toRecords(JSON.parse(e.CloudTrailEvent), accountId)) if (names.has(r.eventName)) out.push(r);
    } catch { /* skip unparseable payload / 파싱 불가 이벤트는 건너뜀 */ }
  }
  return out;
}

export async function ingestOnce(opts: {
  lookup?: LookupFn; now?: Date; accounts?: string[]; maxPagesPerCall?: number;
} = {}): Promise<{ added: number; failed: string[] }> {
  const lookup = opts.lookup ?? defaultLookup;
  const now = opts.now ?? new Date();
  const maxPages = opts.maxPagesPerCall ?? DEFAULT_MAX_PAGES;
  const accounts = opts.accounts ?? (await resolveAccounts());
  const state = await readState();
  let added = 0;
  const failed: string[] = [];

  for (const accountId of accounts) {
    for (const region of REGIONS) {
      const key = `${accountId}:${region}`;
      const st: AccountRegionState = (state.accounts[key] ??= {
        backfillFrom: new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString(),
        backfillDone: [],
      });
      const allNames = eventNamesFor(region);
      const names = new Set(allNames);
      try {
        const from = new Date(st.backfillFrom);
        const backfilledNow = new Set<string>();
        // Page one event name fully (newest first); log the name only if the safety cap is hit.
        // 이름 하나를 끝까지 페이징. 상한에 닿으면 이름만 로그.
        const pageName = async (name: string, start: Date): Promise<void> => {
          let token: string | undefined;
          for (let i = 0; i < maxPages; i++) {
            const page = await lookup(accountId, region, { eventName: name, start, end: now, nextToken: token });
            added += await appendRecords(parseEvents(page, accountId, names));
            token = page.nextToken;
            if (!token) return;
          }
          console.error('[change-timeline] page cap reached for', name);
        };

        for (const name of allNames) {
          if (st.backfillDone.includes(name)) continue;
          // First run for this key: anchor lastTo so names finished earlier are covered by the incremental.
          // 이 키의 첫 실행: lastTo를 고정해 먼저 끝난 이름도 증분이 이어받게 한다.
          st.lastTo ??= now.toISOString();
          await pageName(name, from);
          st.backfillDone.push(name);
          backfilledNow.add(name);
          await writeState(state);
        }

        const start = new Date(new Date(st.lastTo ?? st.backfillFrom).getTime() - OVERLAP_MS);
        for (const name of allNames) {
          if (backfilledNow.has(name)) continue; // already read up to now / 방금 now까지 읽음
          await pageName(name, start);
        }
        st.lastTo = now.toISOString();
        st.lastRunAt = now.toISOString();
        delete st.lastError;
        await writeState(state);
      } catch (e) {
        st.lastError = e instanceof Error ? e.name : 'Error';
        st.lastRunAt = now.toISOString();
        console.error('[change-timeline] ingest failed:', st.lastError);
        if (!failed.includes(accountId)) failed.push(accountId);
        await writeState(state).catch(() => {});
        continue; // next region / 다음 리전
      }
    }
  }
  return { added, failed };
}
