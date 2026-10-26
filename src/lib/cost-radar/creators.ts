// Resource creator lookup via CloudTrail LookupEvents (paced, cached, never throws).
// CloudTrail LookupEvents로 리소스 생성자 조회 (속도 제한, 캐시, 예외 없음).
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import type { Event } from '@aws-sdk/client-cloudtrail';
import { cloudTrailSlot, accountCredentials, resetCloudTrailAccess } from '@/lib/cloudtrail-access';
import type { CreatorInfo } from './types';
import { readJson, writeJsonAtomic } from './store';

const CACHE_FILE = 'creators.json';
const MAX_PAGES = 5;
const RETRY_UNKNOWN_MS = 24 * 3_600_000;
const CREATE_EVENTS = new Set(['RunInstances', 'CreateVolume', 'CreateSnapshot', 'AllocateAddress', 'CreateLoadBalancer', 'CreateTargetGroup']);

/**
 * The create event expected for this id shape (other events merely mention the resource, e.g. RunInstances for a volume);
 * unknown shape -> any create event. / ID 형태에 맞는 생성 이벤트만 인정 (모르는 형태는 모든 생성 이벤트).
 */
export function expectedEvents(resourceId: string): Set<string> {
  if (resourceId.startsWith('vol-')) return new Set(['CreateVolume']);
  if (resourceId.startsWith('eipalloc-')) return new Set(['AllocateAddress']);
  if (resourceId.startsWith('i-')) return new Set(['RunInstances']);
  if (resourceId.startsWith('snap-')) return new Set(['CreateSnapshot']);
  if (resourceId.includes(':loadbalancer/')) return new Set(['CreateLoadBalancer']);
  if (resourceId.includes(':targetgroup/')) return new Set(['CreateTargetGroup']);
  return CREATE_EVENTS;
}

type Item = { resourceId: string; accountId: string; region: string };
type CacheEntry = CreatorInfo & { checkedAt: string };
type Cache = Record<string, CacheEntry>;
type Opts = { now?: Date };

const unknown = (resourceId: string): CreatorInfo => ({ resourceId, user: null, eventTime: null, status: 'unknown' });

function userOf(ev: Event): string | null {
  if (ev.Username) return ev.Username;
  try {
    const arn: string | undefined = JSON.parse(ev.CloudTrailEvent ?? '{}')?.userIdentity?.arn;
    return arn ? arn.split('/').pop() || null : null;
  } catch {
    return null;
  }
}

// Process-wide state: per-account queue, in-flight de-dup, serialised cache writes.
// 프로세스 전역 상태: 계정별 큐/마지막 호출 시각(속도 제한), 진행 중 조회 중복 제거, 직렬화된 캐시 쓰기.
const accountQueue = new Map<string, Promise<unknown>>();
const inflight = new Map<string, Promise<CreatorInfo>>();
let cacheChain: Promise<unknown> = Promise.resolve();

/** Test hook: clear process-wide state. / 테스트용 전역 상태 초기화. */
export function resetCreatorState(): void {
  resetCloudTrailAccess(); accountQueue.clear(); inflight.clear(); cacheChain = Promise.resolve();
}

const isFresh = (c: CacheEntry | undefined, now: Date): c is CacheEntry =>
  !!c && (c.status === 'found' || now.getTime() - new Date(c.checkedAt).getTime() < RETRY_UNKNOWN_MS);

/** Merge one entry into the file: re-read, never downgrade found→unknown, serialised. / 재읽기 후 병합, found 강등 금지, 직렬화. */
function saveEntry(k: string, entry: CacheEntry): Promise<void> {
  const run = async () => {
    try {
      const cur = await readJson<Cache>(CACHE_FILE, {});
      if (cur[k]?.status === 'found' && entry.status === 'unknown') return;
      cur[k] = entry;
      await writeJsonAtomic(CACHE_FILE, cur);
    } catch (e) {
      console.error('[cost-radar] creators cache write failed:', e instanceof Error ? e.name : 'Error');
    }
  };
  cacheChain = cacheChain.then(run, run);
  return cacheChain as Promise<void>;
}

async function lookupOne(it: Item, now: Date): Promise<CreatorInfo> {
  const k = `${it.accountId}:${it.resourceId}`;
  // Re-check the cache inside the queue: an earlier call may have filled it meanwhile.
  const cached = (await readJson<Cache>(CACHE_FILE, {}))[k];
  if (isFresh(cached, now)) return { resourceId: cached.resourceId, user: cached.user, eventTime: cached.eventTime, status: cached.status };
  let info = unknown(it.resourceId);
  try {
    const creds = await accountCredentials(it.accountId, 'awsops-cost-radar');
    const client = new CloudTrailClient({ region: it.region, ...(creds ? { credentials: creds } : {}) });
    info = await findCreator(client, it.accountId, it.region, it.resourceId);
  } catch (e) {
    console.error('[cost-radar] creator lookup failed:', e instanceof Error ? e.name : 'Error');
  }
  await saveEntry(k, { ...info, checkedAt: now.toISOString() });
  return info;
}

function lookupShared(it: Item, now: Date): Promise<CreatorInfo> {
  const k = `${it.accountId}:${it.resourceId}`;
  const hit = inflight.get(k);
  if (hit) return hit;
  const prev = accountQueue.get(it.accountId) ?? Promise.resolve();
  const p = prev.then(() => lookupOne(it, now), () => lookupOne(it, now));
  accountQueue.set(it.accountId, p.catch(() => undefined));
  inflight.set(k, p);
  const done = () => { if (inflight.get(k) === p) inflight.delete(k); };
  p.then(done, done);
  return p;
}

async function findCreator(client: CloudTrailClient, accountId: string, region: string, resourceId: string): Promise<CreatorInfo> {
  const wanted = expectedEvents(resourceId);
  let best: Event | undefined;
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    await cloudTrailSlot(accountId, region);
    const res = await client.send(new LookupEventsCommand({
      LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: resourceId }],
      MaxResults: 50,
      NextToken: token,
    }));
    for (const ev of res.Events ?? []) {
      if (!ev.EventName || !wanted.has(ev.EventName) || !ev.EventTime) continue;
      if (!best || new Date(ev.EventTime) < new Date(best.EventTime!)) best = ev;
    }
    token = res.NextToken;
    if (!token) break;
  }
  if (!best) return unknown(resourceId);
  return { resourceId, user: userOf(best), eventTime: new Date(best.EventTime!).toISOString(), status: 'found' };
}

export async function lookupCreators(items: Item[], opts: Opts = {}): Promise<CreatorInfo[]> {
  const now = opts.now ?? new Date();
  const cache = await readJson<Cache>(CACHE_FILE, {});
  return Promise.all(items.map((it) => {
    const c = cache[`${it.accountId}:${it.resourceId}`];
    if (isFresh(c, now)) return Promise.resolve<CreatorInfo>({ resourceId: c.resourceId, user: c.user, eventTime: c.eventTime, status: c.status });
    return lookupShared(it, now).catch(() => unknown(it.resourceId));
  }));
}
