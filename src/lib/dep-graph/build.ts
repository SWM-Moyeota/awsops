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
  const data = extractGraph(rows);
  const stats = statsFor(data, warnings, deps.now);
  const store = await createGraphStore(data, stats);
  setCurrentStore(store);
  try {
    await writeSnapshot(deps.snapshotPath ?? SNAPSHOT_PATH, stats, data);
  } catch (e) {
    // Snapshot is best-effort; the live store is already swapped in.
    // 스냅샷은 부가 기능 — 저장소는 이미 교체됐다.
    console.error('[dep-graph] snapshot failed:', e instanceof Error ? e.name : 'Error');
  }
  return stats;
}

export async function loadSnapshot(file: string = SNAPSHOT_PATH): Promise<boolean> {
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!j || j.version !== 1 || !j.stats || !j.data || !Array.isArray(j.data.nodes) || !Array.isArray(j.data.edges)) return false;
    setCurrentStore(await createGraphStore(j.data as GraphData, j.stats as BuildStats));
    return true;
  } catch {
    return false;
  }
}

let inflight: Promise<unknown> | null = null;

/** Current store, else snapshot, else kick off one rebuild and return null. / 현재 → 스냅샷 → 빌드 시작 후 null. */
export async function ensureGraph(deps: { snapshotPath?: string; rebuild?: () => Promise<unknown> } = {}): Promise<GraphStore | null> {
  const cur = getCurrentStore();
  if (cur) return cur;
  if (await loadSnapshot(deps.snapshotPath)) return getCurrentStore();
  if (!inflight) {
    const start = deps.rebuild ?? (() => rebuildGraph({ snapshotPath: deps.snapshotPath }));
    inflight = Promise.resolve()
      .then(start)
      .catch((e) => console.error('[dep-graph] build failed:', e instanceof Error ? e.name : 'Error'))
      .finally(() => { inflight = null; });
  }
  return null;
}
