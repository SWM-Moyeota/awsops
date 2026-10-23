// Resource creator lookup via CloudTrail LookupEvents (paced, cached, never throws).
// CloudTrail LookupEvents로 리소스 생성자 조회 (속도 제한, 캐시, 예외 없음).
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import type { Event } from '@aws-sdk/client-cloudtrail';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getConfig } from '@/lib/app-config';
import type { CreatorInfo } from './types';
import { readJson, writeJsonAtomic } from './store';

const CACHE_FILE = 'creators.json';
const ROLE = 'AWSopsReadOnlyRole';
const STS_REGION = 'ap-northeast-2';
const PACE_MS = 1000;
const MAX_PAGES = 5;
const RETRY_UNKNOWN_MS = 24 * 3_600_000;
const CREATE_EVENTS = new Set(['RunInstances', 'CreateVolume', 'CreateSnapshot', 'AllocateAddress', 'CreateLoadBalancer', 'CreateTargetGroup']);

type Item = { resourceId: string; accountId: string; region: string };
type CacheEntry = CreatorInfo & { checkedAt: string };
type Cache = Record<string, CacheEntry>;
type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
type Opts = { now?: Date };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const unknown = (resourceId: string): CreatorInfo => ({ resourceId, user: null, eventTime: null, status: 'unknown' });

// AssumeRole credentials per account, reused until 1 min before expiry. / 만료 1분 전까지 재사용.
const credCache = new Map<string, { creds: Creds; expires: number }>();

/** Test hook: drop cached AssumeRole credentials. / 테스트용 자격증명 캐시 초기화. */
export function resetCredentialCache(): void { credCache.clear(); }

async function credsFor(accountId: string, nowMs: number): Promise<Creds | undefined> {
  const cfg = getConfig();
  const acct = cfg.accounts?.find((a) => a.accountId === accountId);
  if (!acct || acct.isHost) return undefined; // default credential chain / 기본 자격증명
  const hit = credCache.get(accountId);
  if (hit && hit.expires - 60_000 > nowMs) return hit.creds;
  const res = await new STSClient({ region: STS_REGION }).send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${accountId}:role/${ROLE}`,
    RoleSessionName: 'awsops-cost-radar',
    DurationSeconds: 900,
    ...(cfg.crossAccountExternalId ? { ExternalId: cfg.crossAccountExternalId } : {}),
  }));
  const c = res.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('NoCredentials');
  const creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  credCache.set(accountId, { creds, expires: c.Expiration ? new Date(c.Expiration).getTime() : nowMs + 900_000 });
  return creds;
}

function userOf(ev: Event): string | null {
  if (ev.Username) return ev.Username;
  try {
    const arn: string | undefined = JSON.parse(ev.CloudTrailEvent ?? '{}')?.userIdentity?.arn;
    return arn ? arn.split('/').pop() || null : null;
  } catch {
    return null;
  }
}

async function findCreator(client: CloudTrailClient, resourceId: string): Promise<CreatorInfo> {
  let best: Event | undefined;
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.send(new LookupEventsCommand({
      LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: resourceId }],
      MaxResults: 50,
      NextToken: token,
    }));
    for (const ev of res.Events ?? []) {
      if (!ev.EventName || !CREATE_EVENTS.has(ev.EventName) || !ev.EventTime) continue;
      if (!best || new Date(ev.EventTime) < new Date(best.EventTime!)) best = ev;
    }
    token = res.NextToken;
    if (!token) break;
    await sleep(PACE_MS);
  }
  if (!best) return unknown(resourceId);
  return { resourceId, user: userOf(best), eventTime: new Date(best.EventTime!).toISOString(), status: 'found' };
}

export async function lookupCreators(items: Item[], opts: Opts = {}): Promise<CreatorInfo[]> {
  const now = opts.now ?? new Date();
  const cache = await readJson<Cache>(CACHE_FILE, {});
  const key = (i: Item) => `${i.accountId}:${i.resourceId}`;
  const out = new Map<string, CreatorInfo>();
  const todo = new Map<string, Item[]>(); // accountId → items needing lookup

  for (const it of items) {
    const c = cache[key(it)];
    const fresh = c && (c.status === 'found' || now.getTime() - new Date(c.checkedAt).getTime() < RETRY_UNKNOWN_MS);
    if (fresh) { out.set(key(it), { resourceId: c.resourceId, user: c.user, eventTime: c.eventTime, status: c.status }); continue; }
    if (out.has(key(it)) || todo.get(it.accountId)?.some((x) => key(x) === key(it))) continue;
    todo.set(it.accountId, [...(todo.get(it.accountId) ?? []), it]);
  }

  // Accounts in parallel, sequential (paced) within an account. / 계정 병렬, 계정 내 순차.
  await Promise.all(Array.from(todo.entries()).map(async ([accountId, list]) => {
    let creds: Creds | undefined;
    let credError = false;
    try { creds = await credsFor(accountId, now.getTime()); } catch (e) {
      credError = true;
      console.error('[cost-radar] creator lookup AssumeRole failed:', e instanceof Error ? e.name : 'Error');
    }
    let first = true;
    for (const it of list) {
      let info = unknown(it.resourceId);
      if (!credError) {
        if (!first) await sleep(PACE_MS);
        first = false;
        try {
          const client = new CloudTrailClient({ region: it.region, ...(creds ? { credentials: creds } : {}) });
          info = await findCreator(client, it.resourceId);
        } catch (e) {
          console.error('[cost-radar] creator lookup failed:', e instanceof Error ? e.name : 'Error');
        }
      }
      out.set(key(it), info);
      cache[key(it)] = { ...info, checkedAt: now.toISOString() };
    }
  }));

  if (todo.size > 0) {
    try { await writeJsonAtomic(CACHE_FILE, cache); } catch (e) {
      console.error('[cost-radar] creators cache write failed:', e instanceof Error ? e.name : 'Error');
    }
  }
  return items.map((i) => out.get(key(i)) ?? unknown(i.resourceId));
}
