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
  params: { eventName?: string; readOnlyFalse?: boolean; start: Date; end: Date; nextToken?: string },
) => Promise<LookupPage>;

const SESSION = 'awsops-change-timeline';
const REGIONS: TrackedRegion[] = ['ap-northeast-2', 'us-east-1'];
const BACKFILL_DAYS = 90;
const OVERLAP_MS = 20 * 60_000;
const DEFAULT_MAX_PAGES = 40;
const BACKFILL_PAGE_SAFETY = 1000;

export const defaultLookup: LookupFn = async (accountId, region, p) => {
  await cloudTrailSlot(accountId, region);
  const creds = await accountCredentials(accountId, SESSION);
  const client = new CloudTrailClient({ region, ...(creds ? { credentials: creds } : {}) });
  const res = await client.send(new LookupEventsCommand({
    StartTime: p.start,
    EndTime: p.end,
    MaxResults: 50,
    NextToken: p.nextToken,
    LookupAttributes: p.eventName
      ? [{ AttributeKey: 'EventName', AttributeValue: p.eventName }]
      : p.readOnlyFalse ? [{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }] : undefined,
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
        for (const name of allNames) {
          if (st.backfillDone.includes(name)) continue;
          let token: string | undefined;
          for (let i = 0; i < BACKFILL_PAGE_SAFETY; i++) {
            const page = await lookup(accountId, region, { eventName: name, start: from, end: now, nextToken: token });
            added += await appendRecords(parseEvents(page, accountId, names));
            token = page.nextToken;
            if (!token) break;
          }
          st.backfillDone.push(name);
          await writeState(state);
        }

        const start = new Date(new Date(st.lastTo ?? st.backfillFrom).getTime() - OVERLAP_MS);
        let token: string | undefined;
        for (let i = 0; i < maxPages; i++) {
          const page = await lookup(accountId, region, { readOnlyFalse: true, start, end: now, nextToken: token });
          added += await appendRecords(parseEvents(page, accountId, names));
          token = page.nextToken;
          if (!token) break;
        }
        st.lastTo = now.toISOString();
        st.lastRunAt = now.toISOString();
        delete st.lastError;
      } catch (e) {
        st.lastError = e instanceof Error ? e.name : 'Error';
        st.lastRunAt = now.toISOString();
        console.error('[change-timeline] ingest failed:', st.lastError);
        if (!failed.includes(accountId)) failed.push(accountId);
        await writeState(state).catch(() => {});
        break; // next account / 다음 계정으로
      }
      await writeState(state);
    }
  }
  return { added, failed };
}
