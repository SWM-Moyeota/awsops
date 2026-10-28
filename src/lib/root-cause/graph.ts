// Root-cause graph helpers: merge history snapshots, resolve event refs, BFS distance.
// 장애 원인 분석 그래프 도구 — 스냅샷 합치기, 이벤트 리소스 찾기, BFS 거리.
import type { GraphData, GraphNode } from '@/lib/dep-graph/types';
import type { GraphSnapshot, MergedGraph, Proximity, ResourceRef } from './types';

const MAX_DEPTH = 4;
const HUB_DEGREE = 15;

/** Merge snapshots in [windowFrom, startedAt] plus the latest one before windowFrom; none -> current. / 창 안 스냅샷 + 창 직전 1개를 합친다. */
export function mergeGraphs(snaps: GraphSnapshot[], windowFrom: Date, startedAt: Date, current: GraphData | null): MergedGraph {
  const from = windowFrom.getTime();
  const to = startedAt.getTime();
  const sorted = [...snaps].sort((a, b) => a.builtAt.localeCompare(b.builtAt));
  const inWindow = sorted.filter((s) => { const t = Date.parse(s.builtAt); return t >= from && t <= to; });
  const before = sorted.filter((s) => Date.parse(s.builtAt) < from).pop();
  const selected = before ? [before, ...inWindow] : inWindow;
  if (selected.length === 0) return { data: current ?? { nodes: [], edges: [], dropped: 0 }, from: null, to: null, count: 0 };
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphData['edges'][number]>();
  let dropped = 0;
  for (const s of selected) {
    for (const n of s.data.nodes) nodes.set(n.arn, n); // later wins / 나중 것이 이긴다
    for (const e of s.data.edges) edges.set(`${e.src}|${e.dst}|${e.type}`, e);
    dropped = Math.max(dropped, s.data.dropped ?? 0);
  }
  return {
    data: { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()), dropped },
    from: selected[0].builtAt,
    to: selected[selected.length - 1].builtAt,
    count: selected.length,
  };
}

// Account of a node: IAM roles carry it in the ARN. / 노드의 계정 — 역할은 ARN 계정 칸.
function nodeAccount(n: GraphNode): string {
  return n.type === 'role' ? (n.arn.split(':')[4] || n.accountId) : n.accountId;
}

/** Match event refs to graph nodes inside one account: arn, then (id,type), then unique id. / 계정 안에서 ARN → (id,type) → 유일한 id 순으로 찾는다. */
export function resolveRefs(refs: ResourceRef[], accountId: string, data: GraphData): GraphNode[] {
  const mine = data.nodes.filter((n) => nodeAccount(n) === accountId);
  const out = new Map<string, GraphNode>();
  for (const r of refs) {
    let hit: GraphNode | undefined;
    if (r.arn) hit = mine.find((n) => n.arn === r.arn);
    if (!hit && r.id) {
      if (r.type) hit = mine.find((n) => n.id === r.id && n.type === r.type);
      else {
        const same = mine.filter((n) => n.id === r.id);
        if (same.length === 1) hit = same[0];
      }
    }
    if (hit) out.set(hit.arn, hit);
  }
  return Array.from(out.values());
}

/** Undirected BFS from the target to the nearest candidate (max 4 hops, no pass-through vpc/subnet/hubs). / 방향 무시 BFS로 가장 가까운 후보까지의 거리. */
export function proximity(targetArn: string | null, candidates: GraphNode[], refCount: number, data: GraphData): Proximity {
  void refCount;
  if (!targetArn) return { distance: 'no-target', path: [], matchedArn: null };
  if (candidates.length === 0) return { distance: 'not-in-graph', path: [], matchedArn: null };
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
  const deg = new Map<string, number>();
  for (const e of data.edges) {
    add(e.src, e.dst); add(e.dst, e.src);
    deg.set(e.src, (deg.get(e.src) ?? 0) + 1); deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1);
  }
  const byArn = new Map(data.nodes.map((n) => [n.arn, n]));
  const cand = new Set(candidates.map((c) => c.arn));
  const label = (arn: string) => { const n = byArn.get(arn); return n ? `${n.name}(${n.type})` : arn; };
  const parent = new Map<string, string | null>([[targetArn, null]]);
  const depth = new Map<string, number>([[targetArn, 0]]);
  const queue = [targetArn];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    if (cand.has(cur)) {
      const path: string[] = [];
      for (let p: string | null | undefined = cur; p; p = parent.get(p)) path.unshift(label(p));
      return { distance: depth.get(cur)!, path, matchedArn: cur };
    }
    const d = depth.get(cur)!;
    if (d >= MAX_DEPTH) continue;
    const n = byArn.get(cur);
    if (cur !== targetArn && (!n || n.type === 'vpc' || n.type === 'subnet' || (deg.get(cur) ?? 0) > HUB_DEGREE)) continue;
    for (const nb of Array.from(adj.get(cur) ?? [])) {
      if (parent.has(nb)) continue;
      parent.set(nb, cur); depth.set(nb, d + 1); queue.push(nb);
    }
  }
  return { distance: 'unconnected', path: [], matchedArn: null };
}

/** Find a node by ARN: current graph first, then newest history. / ARN으로 노드 찾기 — 현재 그래프 먼저, 그다음 최신 이력부터. */
export function findNode(arn: string, current: GraphData | null, history: GraphSnapshot[]): GraphNode | null {
  const c = current?.nodes.find((n) => n.arn === arn);
  if (c) return c;
  const sorted = [...history].sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  for (const s of sorted) { const n = s.data.nodes.find((x) => x.arn === arn); if (n) return n; }
  return null;
}
