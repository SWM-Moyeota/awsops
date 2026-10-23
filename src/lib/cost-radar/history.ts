// Daily cost history — pure record/trend logic plus atomic file IO.
// 일별 비용 이력 — 순수 기록/추세 로직 + 원자적 파일 입출력.
import type { Estimate, RawInventory, Trend } from './types';
import { buildEstimate } from './estimate';
import { readJson, writeJsonAtomic } from './store';

export type HistoryFile = {
  entries: { accountId: string; day: string; monthly: number; categories: Record<string, number> }[];
};

const FILE = 'history.json';
const KEEP_DAYS = 90;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

/** KST calendar day (YYYY-MM-DD) of an instant. / KST 기준 날짜. */
function kstDay(d: Date): string {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
}

export function hasEntryForDay(hist: HistoryFile, accountId: string, now: Date): boolean {
  const day = kstDay(now);
  return hist.entries.some((e) => e.accountId === accountId && e.day === day);
}

/** One entry per account per KST day (first wins); prunes entries older than 90 days. / 계정·일 당 1건, 90일 초과 삭제. */
export function recordEstimate(hist: HistoryFile, e: Estimate, now: Date): HistoryFile {
  const cutoff = kstDay(new Date(now.getTime() - KEEP_DAYS * DAY_MS));
  const entries = hist.entries.filter((x) => x.day >= cutoff);
  if (!hasEntryForDay({ entries }, e.accountId, now)) {
    const categories: Record<string, number> = {};
    for (const c of e.categories) categories[c.id] = c.monthly;
    entries.push({ accountId: e.accountId, day: kstDay(now), monthly: e.monthly, categories });
  }
  return { entries };
}

/** Today's summed monthly vs the entry exactly 7 days earlier; null if any account lacks either. / 7일 전 대비 증감. */
export function trendFor(hist: HistoryFile, accountIds: string[], now: Date): Trend | null {
  if (accountIds.length === 0) return null;
  const today = kstDay(now);
  const prevDay = kstDay(new Date(now.getTime() - 7 * DAY_MS));
  let cur = 0;
  let prev = 0;
  for (const id of accountIds) {
    const c = hist.entries.find((x) => x.accountId === id && x.day === today);
    const p = hist.entries.find((x) => x.accountId === id && x.day === prevDay);
    if (!c || !p) return null;
    cur += c.monthly;
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

const ALL_CATEGORIES = ['ec2', 'loadbalancer', 'nat', 'vpc-endpoint', 'public-ip', 'storage', 'rds', 'elasticache'];
let dailyInFlight: Promise<void> | null = null;

/** Test hook. / 테스트용. */
export function resetDailyState(): void {
  dailyInFlight = null;
}

/**
 * Record today's (KST) estimate for every configured account that lacks one. Never throws;
 * overlapping calls share one run; nothing is written if every collection failed outright.
 * 오늘(KST) 이력이 없는 계정만 수집·기록. 예외 없음, 중복 실행 방지, 전부 실패 시 쓰기 생략.
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
          if (ALL_CATEGORIES.every((c) => inv.errors[c as keyof typeof inv.errors])) continue;
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
