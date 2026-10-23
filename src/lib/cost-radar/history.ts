// Daily cost history — pure record/trend logic plus atomic file IO.
// 일별 비용 이력 — 순수 기록/추세 로직 + 원자적 파일 입출력.
import type { Estimate, RawInventory, Trend } from './types';
import { buildEstimate, collectionFailed } from './estimate';
import { readJson, writeJsonAtomic } from './store';

export type HistoryEntry = {
  accountId: string;
  day: string;
  monthly: number;
  categories: Record<string, number>;
  /** Some table failed when this was recorded; replaceable the same day, never a trend baseline. / 일부 조회 실패. */
  partial?: boolean;
};
export type HistoryFile = { entries: HistoryEntry[] };

const FILE = 'history.json';
const KEEP_DAYS = 90;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

/** KST calendar day (YYYY-MM-DD) of an instant. / KST 기준 날짜. */
function kstDay(d: Date): string {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
}

/** True only for a complete (non-partial) entry of that KST day. / 그날의 완전한 기록이 있을 때만 true. */
export function hasEntryForDay(hist: HistoryFile, accountId: string, now: Date): boolean {
  const day = kstDay(now);
  return hist.entries.some((e) => e.accountId === accountId && e.day === day && !e.partial);
}

/**
 * One entry per account per KST day; prunes entries older than 90 days. An estimate with warnings is stored
 * as partial; a partial entry is replaced by any later record that day, a complete one is never replaced.
 * 계정·일 당 1건, 90일 초과 삭제. 경고가 있으면 partial로 저장하고, partial은 같은 날 다시 기록되면 교체,
 * 완전한 기록은 교체하지 않는다.
 */
export function recordEstimate(hist: HistoryFile, e: Estimate, now: Date): HistoryFile {
  const cutoff = kstDay(new Date(now.getTime() - KEEP_DAYS * DAY_MS));
  const day = kstDay(now);
  const kept = hist.entries.filter((x) => x.day >= cutoff);
  if (hasEntryForDay({ entries: kept }, e.accountId, now)) return { entries: kept };
  const entries = kept.filter((x) => !(x.accountId === e.accountId && x.day === day));
  const categories: Record<string, number> = {};
  for (const c of e.categories) categories[c.id] = c.monthly;
  const entry: HistoryEntry = { accountId: e.accountId, day, monthly: e.monthly, categories };
  if (e.warnings.length > 0) entry.partial = true;
  entries.push(entry);
  return { entries };
}

/**
 * Live per-account monthly totals vs the entries exactly 7 KST days earlier (summed for "All").
 * Null when any account lacks a baseline, a baseline is partial, or the baseline sum is 0.
 * 실시간 계정별 월 추정액과 정확히 7일 전(KST) 기록 비교. 기준 기록이 없거나 partial이거나 합이 0이면 null.
 */
export function trendFor(hist: HistoryFile, current: Record<string, number>, now: Date): Trend | null {
  const ids = Object.keys(current);
  if (ids.length === 0) return null;
  const prevDay = kstDay(new Date(now.getTime() - 7 * DAY_MS));
  let cur = 0;
  let prev = 0;
  for (const id of ids) {
    const p = hist.entries.find((x) => x.accountId === id && x.day === prevDay);
    if (!p || p.partial) return null;
    cur += current[id];
    prev += p.monthly;
  }
  if (prev === 0) return null;
  return { previousMonthly: prev, changePercent: Math.round(((cur - prev) / prev) * 100) };
}

export async function readHistory(): Promise<HistoryFile> {
  const h = await readJson<HistoryFile>(FILE, { entries: [] });
  return Array.isArray(h?.entries) ? h : { entries: [] };
}

export async function writeHistory(h: HistoryFile): Promise<void> {
  await writeJsonAtomic(FILE, h);
}

export interface DailyDeps {
  collectInventory: (accountId: string) => Promise<RawInventory>;
  accountIds: string[];
}

let dailyInFlight: Promise<void> | null = null;

/** Test hook. / 테스트용. */
export function resetDailyState(): void {
  dailyInFlight = null;
}

/**
 * Record today's (KST) estimate for every configured account that lacks a complete one, one account at a time.
 * Never throws; overlapping calls share one run; an account whose every category failed is not written.
 * 오늘(KST) 완전한 이력이 없는 계정만 한 계정씩 수집·기록. 예외 없음, 중복 실행 방지, 전 카테고리 실패 계정은 기록 안 함.
 */
export function recordDailyIfMissing(now: Date = new Date(), deps?: DailyDeps): Promise<void> {
  if (dailyInFlight) return dailyInFlight;
  const run = (async () => {
    try {
      const d = deps ?? (await defaultDailyDeps());
      let hist = await readHistory();
      let wrote = false;
      for (const id of d.accountIds) {
        if (hasEntryForDay(hist, id, now)) continue;
        try {
          const inv = await d.collectInventory(id);
          if (collectionFailed(inv)) continue;
          hist = recordEstimate(hist, buildEstimate([inv], id), now);
          wrote = true;
        } catch {
          // one account failing must not stop the others / 한 계정 실패가 다른 계정을 막지 않음
        }
      }
      if (wrote) await writeHistory(hist);
    } catch {
      // never throws / 예외 없음
    }
  })().finally(() => { dailyInFlight = null; });
  dailyInFlight = run;
  return run;
}

async function defaultDailyDeps(): Promise<DailyDeps> {
  const [{ getConfig }, { collectInventory }] = await Promise.all([import('@/lib/app-config'), import('./collect')]);
  return { collectInventory, accountIds: (getConfig().accounts || []).map((a) => a.accountId) };
}
