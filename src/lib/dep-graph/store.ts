// In-memory PGlite graph store: nodes/edges tables + recursive-CTE walks.
// 메모리 PGlite 그래프 저장소 — 빌드마다 새로 적재하고 포인터만 바꿔 끼운다.
import { PGlite } from '@electric-sql/pglite';
import type { BuildStats, EdgeType, GraphData, GraphEdge, GraphNode, Neighborhood, NodeType, WalkNode, WalkResult } from './types';

export const WALK_CAP = 300;
// Per-side budget in a neighborhood; a side's unused budget goes to the other side.
// 주변 그래프의 한쪽 예산 — 남는 예산은 반대쪽이 쓴다.
export const SIDE_CAP = 150;
const SEARCH_MAX = 20;
const HUBS_DEFAULT = 10;
const HUBS_MAX = 100;

export interface GraphStore {
  stats(): BuildStats;
  data(): GraphData;
  node(arn: string): Promise<GraphNode | null>;
  nodeById(id: string, type?: NodeType): Promise<GraphNode | null>;
  search(q: string, opts?: { limit?: number; accountId?: string; type?: NodeType }): Promise<GraphNode[]>;
  hubs(opts?: { limit?: number; accountId?: string }): Promise<Array<GraphNode & { dependents: number }>>;
  impact(arn: string, depth?: number, opts?: WalkOptions): Promise<WalkResult>;
  dependencies(arn: string, depth?: number, opts?: WalkOptions): Promise<WalkResult>;
  neighborhood(arn: string, depth?: number): Promise<Neighborhood | null>;
  close(): Promise<void>;
}

/** Only follow these edge types (all when omitted). / 이 간선 종류만 따라간다(없으면 전부). */
export interface WalkOptions { edgeTypes?: EdgeType[] }

/** Integer within 1..max, otherwise the default. / 1..max 정수가 아니면 기본값. */
export function clampDepth(v: unknown, def: number, max: number): number {
  const n = toInt(v);
  return n !== null && n >= 1 && n <= max ? n : def;
}

/** Positive integer capped at max, otherwise the default. / 양의 정수면 max까지 자르고, 아니면 기본값. */
export function clampLimit(v: unknown, def: number, max: number): number {
  const n = toInt(v);
  return n !== null && n >= 1 ? Math.min(n, max) : def;
}

// Integers, or digit-only strings such as query params.
// 정수, 또는 숫자만 있는 문자열(쿼리 파라미터).
function toInt(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

const SCHEMA = `
create table nodes(arn text primary key, type text not null, id text not null, name text not null,
  account_id text not null, region text not null, attrs jsonb not null default '{}');
create table edges(src_arn text not null, dst_arn text not null, type text not null,
  primary key (src_arn, dst_arn, type));
create index on edges(dst_arn); create index on edges(src_arn);
`;

const INSERT_NODES = `insert into nodes select * from json_to_recordset($1::json)
  as x(arn text, type text, id text, name text, account_id text, region text, attrs jsonb) on conflict (arn) do nothing`;
const INSERT_EDGES = `insert into edges select * from json_to_recordset($1::json)
  as x(src_arn text, dst_arn text, type text) on conflict do nothing`;

// impact follows edges in reverse (dst → src); dependencies swaps the ends.
// impact는 간선을 거꾸로, dependencies는 정방향으로 따라간다.
function walkSql(from: 'src_arn' | 'dst_arn', to: 'src_arn' | 'dst_arn'): string {
  return `with recursive walk(arn, depth) as (
    select $1::text, 0
    union
    select e.${from}, w.depth + 1 from edges e join walk w on e.${to} = w.arn
    where w.depth < $2 and ($3::text[] is null or e.type = any($3))
  )
  select n.*, min(w.depth) as depth from walk w join nodes n on n.arn = w.arn
  where w.arn <> $1 group by n.arn order by depth, n.type, n.name, n.arn limit ${WALK_CAP + 1}`;
}
const IMPACT_SQL = walkSql('src_arn', 'dst_arn');
const DEPENDENCIES_SQL = walkSql('dst_arn', 'src_arn');

type NodeRow = { arn: string; type: string; id: string; name: string; account_id: string; region: string; attrs: unknown };

function toNode(r: NodeRow): GraphNode {
  const attrs = r.attrs && typeof r.attrs === 'object' ? (r.attrs as Record<string, unknown>) : {};
  return { arn: r.arn, type: r.type as NodeType, id: r.id, name: r.name, accountId: r.account_id, region: r.region, attrs };
}

// LIKE pattern with %, _ and \ escaped, wrapped in %…%.
// LIKE 특수문자를 이스케이프한 부분 일치 패턴.
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function createGraphStore(data: GraphData, stats: BuildStats): Promise<GraphStore> {
  const db = await PGlite.create();
  try {
    await db.exec(SCHEMA);
    const known = new Set(data.nodes.map((n) => n.arn));
    const nodeRows = data.nodes.map((n) => ({ arn: n.arn, type: n.type, id: n.id, name: n.name, account_id: n.accountId, region: n.region, attrs: n.attrs ?? {} }));
    // Edges whose ends are not nodes are dropped before insert.
    // 끝이 노드에 없는 간선은 적재 전에 버린다.
    const edgeRows = data.edges.filter((e) => known.has(e.src) && known.has(e.dst)).map((e) => ({ src_arn: e.src, dst_arn: e.dst, type: e.type }));
    if (nodeRows.length) await db.query(INSERT_NODES, [JSON.stringify(nodeRows)]);
    if (edgeRows.length) await db.query(INSERT_EDGES, [JSON.stringify(edgeRows)]);
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }

  let closed = false;
  const inflight = new Set<Promise<unknown>>();

  // Every query goes through here so a closed store rejects deterministically.
  // 닫힌 저장소는 새 질의를 바로 거절하고, 진행 중인 질의는 끝난 뒤 닫는다.
  async function q<T>(sql: string, params: unknown[]): Promise<T[]> {
    if (closed) throw new Error('GraphStore is closed');
    const p = db.query<T>(sql, params);
    inflight.add(p);
    try {
      return (await p).rows;
    } finally {
      inflight.delete(p);
    }
  }

  async function walk(sql: string, arn: string, depth: number, opts?: WalkOptions): Promise<WalkResult> {
    const types = opts?.edgeTypes && opts.edgeTypes.length ? opts.edgeTypes : null;
    const rows = await q<NodeRow & { depth: number }>(sql, [arn, depth, types]);
    const nodes: WalkNode[] = rows.slice(0, WALK_CAP).map((r) => ({ ...toNode(r), depth: Number(r.depth) }));
    return { nodes, truncated: rows.length > WALK_CAP };
  }

  async function node(arn: string): Promise<GraphNode | null> {
    const rows = await q<NodeRow>('select * from nodes where arn = $1', [arn]);
    return rows[0] ? toNode(rows[0]) : null;
  }

  return {
    stats: () => stats,
    data: () => data,
    node,

    async nodeById(id, type) {
      const rows = await q<NodeRow>(
        'select * from nodes where id = $1 and ($2::text is null or type = $2) order by type, arn limit 1',
        [id, type ?? null],
      );
      return rows[0] ? toNode(rows[0]) : null;
    },

    async search(text, opts = {}) {
      const term = text.trim();
      if (!term) return [];
      const limit = clampLimit(opts.limit, SEARCH_MAX, SEARCH_MAX);
      const rows = await q<NodeRow>(
        `select * from nodes
         where (name ilike $1 escape '\\' or id ilike $1 escape '\\' or arn ilike $1 escape '\\')
           and ($3::text is null or account_id = $3)
           and ($5::text is null or type = $5)
         order by case when lower(id) = lower($2) or lower(name) = lower($2) then 0 else 1 end, name, arn
         limit $4`,
        [likePattern(term), term, opts.accountId ?? null, limit, opts.type ?? null],
      );
      return rows.map(toNode);
    },

    async hubs(opts = {}) {
      const limit = clampLimit(opts.limit, HUBS_DEFAULT, HUBS_MAX);
      const rows = await q<NodeRow & { dependents: number }>(
        `select n.*, count(*)::int as dependents from edges e join nodes n on n.arn = e.dst_arn
         where ($2::text is null or n.account_id = $2)
         group by n.arn order by dependents desc, n.name, n.arn limit $1`,
        [limit, opts.accountId ?? null],
      );
      return rows.map((r) => ({ ...toNode(r), dependents: Number(r.dependents) }));
    },

    impact: (arn, depth, opts) => walk(IMPACT_SQL, arn, clampDepth(depth, 3, 6), opts),
    dependencies: (arn, depth, opts) => walk(DEPENDENCIES_SQL, arn, clampDepth(depth, 3, 6), opts),

    async neighborhood(arn, depth) {
      const center = await node(arn);
      if (!center) return null;
      const d = clampDepth(depth, 2, 3);
      const up = await walk(IMPACT_SQL, arn, d);
      const down = await walk(DEPENDENCIES_SQL, arn, d);
      // Smaller depth wins; a tie stays dependent.
      // 양쪽에서 찾으면 더 얕은 쪽, 같으면 dependent.
      const side = new Map<string, { n: WalkNode; side: 'dependent' | 'dependency' }>();
      for (const n of up.nodes) side.set(n.arn, { n, side: 'dependent' });
      for (const n of down.nodes) {
        const prev = side.get(n.arn);
        if (!prev || n.depth < prev.n.depth) side.set(n.arn, { n, side: 'dependency' });
      }
      // Each side by depth (stable sort keeps walk order).
      // 쪽마다 깊이 순(안정 정렬이라 walk 순서 유지).
      const all = Array.from(side.values());
      const byDepth = (a: { n: WalkNode }, b: { n: WalkNode }) => a.n.depth - b.n.depth;
      const dependents = all.filter((x) => x.side === 'dependent').sort(byDepth);
      const dependencies = all.filter((x) => x.side === 'dependency').sort(byDepth);
      // Up to SIDE_CAP per side; a side's unused budget goes to the other; total ≤ WALK_CAP.
      // 쪽마다 SIDE_CAP까지, 남는 예산은 반대쪽으로 — 합계는 WALK_CAP 이하(중심 제외).
      const upKeep = Math.min(dependents.length, Math.max(SIDE_CAP, WALK_CAP - dependencies.length));
      const downKeep = Math.min(dependencies.length, WALK_CAP - upKeep);
      const nodes: Neighborhood['nodes'] = [
        { ...center, depth: 0, side: 'center' },
        ...dependents.slice(0, upKeep).map((x) => ({ ...x.n, side: x.side })),
        ...dependencies.slice(0, downKeep).map((x) => ({ ...x.n, side: x.side })),
      ];
      const ids = JSON.stringify(nodes.map((n) => n.arn));
      const edgeRows = await q<{ src_arn: string; dst_arn: string; type: string }>(
        `with ids as (select json_array_elements_text($1::json) as arn)
         select src_arn, dst_arn, type from edges
         where src_arn in (select arn from ids) and dst_arn in (select arn from ids)
         order by src_arn, dst_arn, type`,
        [ids],
      );
      const edges: GraphEdge[] = edgeRows.map((r) => ({ src: r.src_arn, dst: r.dst_arn, type: r.type as GraphEdge['type'] }));
      const cut = upKeep < dependents.length || downKeep < dependencies.length;
      return { center, nodes, edges, truncated: up.truncated || down.truncated || cut };
    },

    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(Array.from(inflight));
      await db.close();
    },
  };
}

interface HolderState { current: GraphStore | null }
declare global {
  // eslint-disable-next-line no-var
  var __awsopsDepGraph: HolderState | undefined;
}

function holder(): HolderState {
  return (globalThis.__awsopsDepGraph ??= { current: null });
}

export function getCurrentStore(): GraphStore | null {
  return holder().current;
}

/**
 * Swap the pointer, then close the previous store after closeDelayMs so in-flight requests can finish.
 * 포인터 교체 후, 진행 중인 요청이 끝나도록 closeDelayMs 뒤에 이전 저장소를 닫는다(오류는 삼킨다).
 */
export function setCurrentStore(next: GraphStore, closeDelayMs = 60_000): void {
  const h = holder();
  const prev = h.current;
  h.current = next;
  if (!prev || prev === next) return;
  const t = setTimeout(() => { void prev.close().catch(() => undefined); }, closeDelayMs);
  t.unref?.();
}
