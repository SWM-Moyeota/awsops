// Cost Radar response builder + 5-min cache + creators id parsing (route files may only export handlers).
// 비용 레이더 응답 조립 + 5분 캐시 + creators ID 파싱 (route 파일은 핸들러만 export 가능).
import NodeCache from 'node-cache';
import { collectInventory as defaultCollect } from './collect';
import { buildEstimate, ALL_SCOPE } from './estimate';
import { recommend, summarizeSavings } from './recommend';
import { readHistory as defaultReadHistory, trendFor, type HistoryFile } from './history';
import type { RadarResponse, RawInventory } from './types';

export const MAX_CREATOR_IDS = 50;
const CACHE_TTL_S = 300;

export class RadarInputError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RadarInputError';
  }
}

export interface RadarDeps {
  collectInventory: (accountId: string) => Promise<RawInventory>;
  accounts: { accountId: string; alias: string }[];
  readHistory: () => Promise<HistoryFile>;
  now: Date;
}

/** Resolve the scope into configured 12-digit ids; throws RadarInputError (400) otherwise. / 범위를 계정 ID 목록으로 변환. */
function resolveIds(accountId: string, accounts: RadarDeps['accounts']): string[] {
  if (accountId === ALL_SCOPE) return accounts.map((a) => a.accountId);
  if (!/^\d{12}$/.test(accountId) || !accounts.some((a) => a.accountId === accountId)) {
    throw new RadarInputError('invalid accountId');
  }
  return [accountId];
}

export async function buildRadarResponse(accountId: string, deps: RadarDeps): Promise<RadarResponse> {
  const ids = resolveIds(accountId, deps.accounts);
  const [invs, hist] = await Promise.all([
    Promise.all(ids.map((id) => deps.collectInventory(id))),
    deps.readHistory(),
  ]);
  const estimate = buildEstimate(invs, accountId);
  const recommendations = recommend(invs, deps.now);
  const savings = summarizeSavings(recommendations, estimate.monthly, deps.now);
  const trend = trendFor(hist, ids, deps.now);
  return {
    estimate,
    recommendations,
    savings,
    trend,
    accounts: deps.accounts.map((a) => ({ accountId: a.accountId, alias: a.alias })),
  };
}

const cache = new NodeCache({ stdTTL: CACHE_TTL_S, checkperiod: 60, useClones: false });
const inflight = new Map<string, Promise<RadarResponse>>();

export function resetRadarCache(): void {
  cache.flushAll();
  inflight.clear();
}

/** Cached for 5 minutes per accountId; failures are never cached. / 5분 캐시, 실패는 캐시하지 않음. */
export async function getRadarResponse(accountId: string, deps: RadarDeps): Promise<RadarResponse> {
  resolveIds(accountId, deps.accounts); // validate before touching the cache
  const hit = cache.get<RadarResponse>(accountId);
  if (hit) return hit;
  const running = inflight.get(accountId);
  if (running) return running;
  const p = buildRadarResponse(accountId, deps)
    .then((r) => {
      cache.set(accountId, r);
      return r;
    })
    .finally(() => { inflight.delete(accountId); });
  inflight.set(accountId, p);
  return p;
}

/** Production deps from app config. / 운영 의존성. */
export async function defaultDeps(): Promise<RadarDeps> {
  const { getConfig } = await import('@/lib/app-config');
  const accounts = (getConfig().accounts || []).map((a) => ({ accountId: a.accountId, alias: a.alias }));
  return { collectInventory: defaultCollect, accounts, readHistory: defaultReadHistory, now: new Date() };
}

const ID_RE = /^\d{12}:[a-z0-9-]+:[A-Za-z0-9:/._-]+$/;

/** Parse `account:region:resourceId,...`; the resource id may itself contain colons (ARNs). */
export function parseCreatorIds(
  raw: string | null,
  configuredIds: string[],
): { accountId: string; region: string; resourceId: string }[] {
  if (!raw) throw new RadarInputError('ids is required');
  const parts = raw.split(',').filter((s) => s.length > 0);
  if (parts.length === 0) throw new RadarInputError('ids is required');
  if (parts.length > MAX_CREATOR_IDS) throw new RadarInputError(`at most ${MAX_CREATOR_IDS} ids`);
  return parts.map((p) => {
    if (!ID_RE.test(p)) throw new RadarInputError('malformed id');
    const i = p.indexOf(':');
    const j = p.indexOf(':', i + 1);
    const accountId = p.slice(0, i);
    if (!configuredIds.includes(accountId)) throw new RadarInputError('unknown account');
    return { accountId, region: p.slice(i + 1, j), resourceId: p.slice(j + 1) };
  });
}
