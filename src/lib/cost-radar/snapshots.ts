// Daily per-resource cost snapshots (data/cost-radar/snapshots/YYYY-MM-DD.json), kept 40 KST days.
// 일별 리소스 단위 비용 스냅샷 (40일 보관).
import fs from 'node:fs';
import path from 'node:path';
import type { DailySnapshot, Estimate, SnapshotResource } from './types';
import { costRadarDir, readJson, writeJsonAtomic } from './store';

const SUBDIR = 'snapshots';
const KEEP_DAYS = 40;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** KST calendar day (YYYY-MM-DD) of an instant. / KST 기준 날짜. */
export function kstDay(d: Date): string {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
}

const fileOf = (day: string): string => `${SUBDIR}/${day}.json`;

/** Priced resources with monthly > 0. / 월 비용이 0보다 큰 리소스만. */
export function toSnapshotResources(e: Estimate): SnapshotResource[] {
  return e.resources
    .filter((r) => typeof r.monthly === 'number' && r.monthly > 0)
    .map((r) => ({ id: r.id, name: r.name, category: r.category, monthly: r.monthly as number, detail: r.detail }));
}

let chain: Promise<unknown> = Promise.resolve();

/** Merge one account into the day's file, keeping other accounts; serialized + atomic. / 직렬화·원자적 병합 쓰기. */
export function writeSnapshotAccount(day: string, accountId: string, resources: SnapshotResource[]): Promise<void> {
  if (!DAY_RE.test(day)) return Promise.reject(new Error('InvalidDay'));
  const run = chain.then(async () => {
    const cur = await readSnapshot(day);
    const snap: DailySnapshot = { day, accounts: { ...(cur?.accounts ?? {}), [accountId]: resources } };
    await writeJsonAtomic(fileOf(day), snap);
  });
  chain = run.catch(() => {});
  return run;
}

export async function readSnapshot(day: string): Promise<DailySnapshot | null> {
  if (!DAY_RE.test(day)) return null;
  const s = await readJson<DailySnapshot | null>(fileOf(day), null);
  return s && typeof s === 'object' && s.accounts && typeof s.accounts === 'object' ? s : null;
}

/** Available snapshot days, ascending. / 오름차순 날짜 목록. */
export async function listSnapshotDays(): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(path.join(costRadarDir(), SUBDIR));
    return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 10)).sort();
  } catch {
    return [];
  }
}

/** Remove snapshot files older than 40 KST days. / 40일 지난 파일 삭제. */
export async function pruneSnapshots(now: Date): Promise<void> {
  const cutoff = kstDay(new Date(now.getTime() - KEEP_DAYS * DAY_MS));
  for (const day of await listSnapshotDays()) {
    if (day < cutoff) await fs.promises.rm(path.join(costRadarDir(), fileOf(day)), { force: true }).catch(() => {});
  }
}
