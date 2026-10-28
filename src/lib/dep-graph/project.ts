// Read-only project cleanup preview: suggests a safe delete order, never deletes.
// 프로젝트 정리 미리보기 — 삭제 순서만 제안하고 실제로 지우지 않는다.
import type { GraphData, GraphNode } from './types';

export type ProjectSeed =
  | { kind: 'tag'; key: string; value: string }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'vpc'; arn: string };

export interface ProjectPreview {
  seedCount: number;
  members: GraphNode[];
  order: Array<{ step: number; arns: string[]; cycle: boolean }>;
  blockers: Array<{ node: GraphNode; uses: string[] }>;
  shared: GraphNode[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byTypeNameArn = (a: GraphNode, b: GraphNode) =>
  cmp(a.type, b.type) || cmp(a.name, b.name) || cmp(a.arn, b.arn);

export function previewProject(data: GraphData, seed: ProjectSeed, opts?: { accountId?: string }): ProjectPreview {
  const byArn = new Map<string, GraphNode>();
  for (const nd of data.nodes) byArn.set(nd.arn, nd);
  const fwd = new Map<string, Set<string>>();
  const rev = new Map<string, Set<string>>();
  for (const ed of data.edges) {
    if (!byArn.has(ed.src) || !byArn.has(ed.dst) || ed.src === ed.dst) continue;
    if (!fwd.has(ed.src)) fwd.set(ed.src, new Set());
    fwd.get(ed.src)!.add(ed.dst);
    if (!rev.has(ed.dst)) rev.set(ed.dst, new Set());
    rev.get(ed.dst)!.add(ed.src);
  }

  // Seed matching. 시드 매칭
  const members = new Set<string>();
  if (seed.kind === 'vpc') {
    if (byArn.has(seed.arn)) {
      members.add(seed.arn);
      const queue = [seed.arn];
      while (queue.length) {
        const cur = queue.pop()!;
        for (const s of rev.get(cur) ?? []) if (!members.has(s)) { members.add(s); queue.push(s); }
      }
    }
  } else {
    for (const nd of data.nodes) {
      if (seed.kind === 'prefix' ? nd.name.startsWith(seed.prefix) : (nd.attrs?.tags as Record<string, unknown> | undefined)?.[seed.key] === seed.value) {
        members.add(nd.arn);
      }
    }
  }
  if (opts?.accountId) for (const a of [...members]) if (byArn.get(a)!.accountId !== opts.accountId) members.delete(a);
  const seedCount = members.size;
  if (seedCount === 0) return { seedCount: 0, members: [], order: [], blockers: [], shared: [] };

  // Closure: absorb dependencies used only by members. 멤버만 쓰는 의존 대상 흡수
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of [...members]) {
      for (const d of fwd.get(m) ?? []) {
        if (members.has(d)) continue;
        if ([...(rev.get(d) ?? [])].every(s => members.has(s))) { members.add(d); changed = true; }
      }
    }
  }

  const shared = new Set<string>();
  const blockerUses = new Map<string, Set<string>>();
  for (const m of members) {
    for (const d of fwd.get(m) ?? []) if (!members.has(d)) shared.add(d);
    for (const s of rev.get(m) ?? []) {
      if (members.has(s)) continue;
      if (!blockerUses.has(s)) blockerUses.set(s, new Set());
      blockerUses.get(s)!.add(m);
    }
  }

  // Tarjan SCC on member-only edges (iterative). 멤버 간선만으로 SCC
  const list = [...members].sort(cmp);
  const index = new Map<string, number>(), low = new Map<string, number>();
  const onStack = new Set<string>(), stack: string[] = [];
  const comp = new Map<string, number>();
  const sccs: string[][] = [];
  let counter = 0;
  for (const root of list) {
    if (index.has(root)) continue;
    const work: Array<{ v: string; it: Iterator<string> }> = [];
    const visit = (v: string) => {
      index.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      work.push({ v, it: [...(fwd.get(v) ?? [])].filter(x => members.has(x)).sort(cmp)[Symbol.iterator]() });
    };
    visit(root);
    while (work.length) {
      const top = work[work.length - 1];
      const nx = top.it.next();
      if (!nx.done) {
        const w = nx.value;
        if (!index.has(w)) visit(w);
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1].v;
          low.set(p, Math.min(low.get(p)!, low.get(top.v)!));
        }
        if (low.get(top.v) === index.get(top.v)) {
          const scc: string[] = [];
          let w: string;
          do { w = stack.pop()!; onStack.delete(w); comp.set(w, sccs.length); scc.push(w); } while (w !== top.v);
          sccs.push(scc.sort(cmp));
        }
      }
    }
  }

  // Kahn on condensation: dependents first. 응축 그래프에서 의존하는 쪽부터
  const indeg = sccs.map(() => 0);
  const out = sccs.map(() => new Set<number>());
  for (const m of members) {
    for (const d of fwd.get(m) ?? []) {
      if (!members.has(d)) continue;
      const a = comp.get(m)!, b = comp.get(d)!;
      if (a !== b && !out[a].has(b)) { out[a].add(b); indeg[b]++; }
    }
  }
  const ready = sccs.map((_, i) => i).filter(i => indeg[i] === 0);
  const order: ProjectPreview['order'] = [];
  while (ready.length) {
    ready.sort((x, y) => cmp(sccs[x][0], sccs[y][0]));
    const i = ready.shift()!;
    order.push({ step: order.length + 1, arns: sccs[i], cycle: sccs[i].length > 1 });
    for (const j of out[i]) if (--indeg[j] === 0) ready.push(j);
  }

  const toNodes = (s: Iterable<string>) => [...s].map(a => byArn.get(a)!).sort(byTypeNameArn);
  return {
    seedCount,
    members: toNodes(members),
    order,
    blockers: toNodes(blockerUses.keys()).map(node => ({ node, uses: [...blockerUses.get(node.arn)!].sort(cmp) })),
    shared: toNodes(shared),
  };
}
