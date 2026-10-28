// Graph build: Steampipe rows -> extractGraph -> store + JSON snapshot.
// 그래프 빌드: Steampipe 행 → 추출 → 저장소 교체 + JSON 스냅샷.
import { promises as fs } from 'fs';
import path from 'path';
import { batchQuery } from '@/lib/steampipe';
import { GRAPH_QUERIES } from './queries';
import { extractGraph } from './extract';
import { createGraphStore, getCurrentStore, setCurrentStore, type GraphStore } from './store';
import type { GraphSnapshot } from '@/lib/root-cause/types';
import type { BuildStats, GraphData, NodeType, QueryName, Row, Rows } from './types';

export type BatchRunner = (q: Record<string, string>) => Promise<Record<string, { rows: unknown[]; error?: string }>>;

export const SNAPSHOT_PATH = path.join(process.cwd(), 'data/graph/latest.json');

/** Per-build snapshots kept for root-cause graph merging. / 장애 원인 분석용 빌드별 스냅샷 폴더. */
export const HISTORY_DIR = path.join(process.cwd(), 'data/graph/history');
/** How many history files to keep (about 3 hours). / 남기는 이력 개수(약 3시간). */
export const HISTORY_KEEP = 12;

const defaultRun: BatchRunner = (q) => batchQuery(q);

/** After a failed build, ensureGraph waits this long before trying again. / 빌드 실패 뒤 ensureGraph 재시도 대기. */
export const REBUILD_COOLDOWN_MS = 60_000;

interface BuildLock { inflight: Promise<unknown> | null; lastFailureAt: number | null }
declare global {
  // eslint-disable-next-line no-var
  var __awsopsDepGraphBuild: BuildLock | undefined;
}

function lock(): BuildLock {
  return (globalThis.__awsopsDepGraphBuild ??= { inflight: null, lastFailureAt: null });
}

/**
 * One build (or snapshot load) at a time for the whole process: a second caller gets the same promise.
 * A rejection records lastFailureAt (used by ensureGraph's cooldown) and is passed on to callers.
 * 프로세스 전체에서 빌드(스냅샷 적재 포함)는 한 번에 하나 — 두 번째 호출은 같은 promise를 받는다.
 */
export function runBuildOnce(fn: () => Promise<unknown>): Promise<unknown> {
  const l = lock();
  if (l.inflight) return l.inflight;
  const p: Promise<unknown> = Promise.resolve()
    .then(fn)
    .catch((e) => { l.lastFailureAt = Date.now(); throw e; })
    .finally(() => { if (l.inflight === p) l.inflight = null; });
  l.inflight = p;
  return p;
}

/** Run all graph queries; failed ones become warnings. / 실패한 쿼리는 경고로만 남긴다. */
export async function collectRows(run: BatchRunner = defaultRun): Promise<{ rows: Rows; warnings: string[] }> {
  const res = await run(GRAPH_QUERIES);
  const rows: Rows = {};
  const warnings: string[] = [];
  for (const name of Object.keys(GRAPH_QUERIES) as QueryName[]) {
    const r = res[name];
    if (!r || r.error) { warnings.push(name); continue; }
    rows[name] = Array.isArray(r.rows) ? (r.rows as Row[]) : [];
  }
  return { rows, warnings };
}

export function statsFor(data: GraphData, warnings: string[], now: Date = new Date()): BuildStats {
  const nodeCounts: Partial<Record<NodeType, number>> = {};
  for (const n of data.nodes) nodeCounts[n.type] = (nodeCounts[n.type] ?? 0) + 1;
  return { builtAt: now.toISOString(), nodeCounts, edgeCount: data.edges.length, dropped: data.dropped, warnings };
}

async function writeSnapshot(file: string, stats: BuildStats, data: GraphData): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, stats, data }));
  await fs.rename(tmp, file);
}

/** Write one history file, then prune to the newest HISTORY_KEEP; never throws. / 이력 파일을 쓰고 최근 12개만 남긴다(실패해도 던지지 않음). */
async function writeHistory(dir: string, stats: BuildStats, data: GraphData): Promise<void> {
  try {
    await writeSnapshot(path.join(dir, `${stats.builtAt.replace(/[:.]/g, '-')}.json`), stats, data);
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    for (const n of names.slice(0, Math.max(0, names.length - HISTORY_KEEP))) await fs.rm(path.join(dir, n), { force: true });
  } catch (e) {
    console.error('[dep-graph] history failed:', e instanceof Error ? e.name : 'Error');
  }
}

/** History snapshots, oldest first; unreadable files skipped, [] if the folder is missing. / 이력을 오래된 순으로 읽는다(깨진 파일은 건너뜀). */
export async function listHistory(dir: string = HISTORY_DIR): Promise<GraphSnapshot[]> {
  let names: string[];
  try { names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out: GraphSnapshot[] = [];
  for (const n of names) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'));
      if (!j || j.version !== 1 || typeof j.stats?.builtAt !== 'string' || !Array.isArray(j.data?.nodes) || !Array.isArray(j.data?.edges)) continue;
      out.push({ builtAt: j.stats.builtAt, data: j.data as GraphData });
    } catch { /* skip / 건너뜀 */ }
  }
  return out.sort((a, b) => a.builtAt.localeCompare(b.builtAt));
}

export async function rebuildGraph(deps: { run?: BatchRunner; snapshotPath?: string; historyDir?: string; now?: Date } = {}): Promise<BuildStats> {
  const { rows, warnings } = await collectRows(deps.run);
  // Every query failed (Steampipe down): keep the previous graph instead of swapping in an empty one.
  // 모든 쿼리가 실패하면(Steampipe 중단) 빈 그래프로 바꾸지 않고 이전 그래프를 유지한다.
  if (warnings.length === Object.keys(GRAPH_QUERIES).length) {
    const err = new Error('all graph queries failed');
    err.name = 'GraphSourceUnavailable';
    throw err;
  }
  const data = extractGraph(rows);
  const stats = statsFor(data, warnings, deps.now);
  const store = await createGraphStore(data, stats);
  // A newer graph is already live (should not happen under the lock): keep it, skip the snapshot.
  // 더 새 그래프가 이미 있으면(잠금 아래에선 없어야 함) 그대로 두고 스냅샷도 쓰지 않는다.
  if (!setCurrentStore(store)) return stats;
  try {
    await writeSnapshot(deps.snapshotPath ?? SNAPSHOT_PATH, stats, data);
  } catch (e) {
    // Snapshot is best-effort; the live store is already swapped in.
    // 스냅샷은 부가 기능 — 저장소는 이미 교체됐다.
    console.error('[dep-graph] snapshot failed:', e instanceof Error ? e.name : 'Error');
    return stats;
  }
  // A custom snapshotPath without historyDir means no history (tests, tools). / snapshotPath만 바꾸면 이력은 쓰지 않는다.
  const hist = deps.historyDir ?? (deps.snapshotPath ? null : HISTORY_DIR);
  if (hist) await writeHistory(hist, stats, data);
  return stats;
}

/** True when the snapshot became the current store (false if missing, malformed or older). / 스냅샷이 현재 저장소가 됐으면 true. */
export async function loadSnapshot(file: string = SNAPSHOT_PATH): Promise<boolean> {
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!j || j.version !== 1 || !j.stats || !j.data || !Array.isArray(j.data.nodes) || !Array.isArray(j.data.edges)) return false;
    return setCurrentStore(await createGraphStore(j.data as GraphData, j.stats as BuildStats));
  } catch {
    return false;
  }
}

/**
 * Current store, else snapshot, else kick off one rebuild and return null. Both go through runBuildOnce;
 * while a build is in flight it returns null at once, and for 60 s after a failed build it does not start one.
 * 현재 → 스냅샷 → 빌드 시작 후 null. 둘 다 runBuildOnce를 거친다. 빌드 중이면 바로 null, 실패 뒤 60초는 다시 시작하지 않는다.
 */
export async function ensureGraph(deps: { snapshotPath?: string; rebuild?: () => Promise<unknown> } = {}): Promise<GraphStore | null> {
  const cur = getCurrentStore();
  if (cur) return cur;
  const l = lock();
  if (l.inflight) return null;
  await runBuildOnce(() => loadSnapshot(deps.snapshotPath)).catch(() => false);
  const loaded = getCurrentStore();
  if (loaded) return loaded;
  if (l.inflight) return null;
  if (l.lastFailureAt !== null && Date.now() - l.lastFailureAt < REBUILD_COOLDOWN_MS) return null;
  const start = deps.rebuild ?? (() => rebuildGraph({ snapshotPath: deps.snapshotPath }));
  runBuildOnce(start).catch((e) => console.error('[dep-graph] build failed:', e instanceof Error ? e.name : 'Error'));
  return null;
}
