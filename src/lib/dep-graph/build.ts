// Graph build: Steampipe rows -> extractGraph -> store + JSON snapshot.
// 그래프 빌드: Steampipe 행 → 추출 → 저장소 교체 + JSON 스냅샷.
import { promises as fs } from 'fs';
import path from 'path';
import { batchQuery } from '@/lib/steampipe';
import { GRAPH_QUERIES } from './queries';
import { extractGraph } from './extract';
import { createGraphStore, getCurrentStore, setCurrentStore, type GraphStore } from './store';
import type { BuildStats, GraphData, NodeType, QueryName, Row, Rows } from './types';

export type BatchRunner = (q: Record<string, string>) => Promise<Record<string, { rows: unknown[]; error?: string }>>;

export const SNAPSHOT_PATH = path.join(process.cwd(), 'data/graph/latest.json');

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

export async function rebuildGraph(deps: { run?: BatchRunner; snapshotPath?: string; now?: Date } = {}): Promise<BuildStats> {
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
  }
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
