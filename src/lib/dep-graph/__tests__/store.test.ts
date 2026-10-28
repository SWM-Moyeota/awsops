import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createGraphStore, getCurrentStore, setCurrentStore, clampDepth, clampLimit, WALK_CAP, type GraphStore } from '../store';
import type { BuildStats, GraphData, GraphEdge, GraphNode, NodeType } from '../types';

const A = '111111111111';
const R = 'ap-northeast-2';

function n(type: NodeType, id: string, name = id, attrs: Record<string, unknown> = {}): GraphNode {
  return { arn: `arn:aws:test:${R}:${A}:${type}/${id}`, type, id, name, accountId: A, region: R, attrs };
}
function e(src: GraphNode, dst: GraphNode, type: GraphEdge['type']): GraphEdge {
  return { src: src.arn, dst: dst.arn, type };
}
function stats(data: GraphData): BuildStats {
  return { builtAt: '2026-10-28T00:00:00.000Z', nodeCounts: {}, edgeCount: data.edges.length, dropped: data.dropped, warnings: [] };
}

// Chain lb → tg → instance → subnet → vpc, plus an SG cycle A ↔ B with instance → A.
// 체인 + 보안그룹 순환 픽스처.
const vpc = n('vpc', 'vpc-1', 'main-vpc', { cidr: '10.0.0.0/16' });
const subnet = n('subnet', 'subnet-1');
const instance = n('instance', 'i-1', 'web-1', { tags: { Name: 'web-1' } });
const tg = n('tg', 'tg-1');
const lb = n('lb', 'lb-1');
const sgA = n('sg', 'sg-a');
const sgB = n('sg', 'sg-b');
const pct = n('role', 'role-pct', 'quota-100%');
const plain = n('role', 'role-plain', 'quota-1000');
const chain: GraphData = {
  nodes: [vpc, subnet, instance, tg, lb, sgA, sgB, pct, plain],
  edges: [
    e(lb, tg, 'forwards_to'), e(tg, instance, 'targets'), e(instance, subnet, 'in_subnet'), e(subnet, vpc, 'in_vpc'),
    e(sgA, sgB, 'allows_from'), e(sgB, sgA, 'allows_from'), e(instance, sgA, 'uses_sg'),
    // Dangling edge: dst is not a node → filtered before insert.
    // 끝이 없는 간선 — 적재 전에 걸러진다.
    { src: instance.arn, dst: 'arn:aws:test:missing', type: 'uses_role' },
  ],
  dropped: 0,
};

describe('chain + cycle store', () => {
  let s: GraphStore;
  beforeAll(async () => { s = await createGraphStore(chain, stats(chain)); });
  afterAll(async () => { await s.close(); });

  it('stats and data return what it was built from', () => {
    expect(s.data()).toBe(chain);
    expect(s.stats().edgeCount).toBe(chain.edges.length);
  });

  it('node and nodeById map columns back to camelCase', async () => {
    expect(await s.node(instance.arn)).toEqual(instance);
    expect(await s.node('arn:nope')).toBeNull();
    expect(await s.nodeById('sg-a')).toEqual(sgA);
    expect(await s.nodeById('sg-a', 'vpc')).toBeNull();
    expect(await s.nodeById('vpc-1', 'vpc')).toEqual(vpc);
  });

  it('impact(vpc, 3) stops at tg; depth 4 adds lb', async () => {
    const r3 = await s.impact(vpc.arn, 3);
    expect(r3.truncated).toBe(false);
    expect(r3.nodes.map((x) => [x.id, x.depth])).toEqual([['subnet-1', 1], ['i-1', 2], ['tg-1', 3]]);
    expect(typeof r3.nodes[0].depth).toBe('number');
    expect(r3.nodes[1]).toMatchObject({ accountId: A, region: R, name: 'web-1', attrs: { tags: { Name: 'web-1' } } });
    const r4 = await s.impact(vpc.arn, 4);
    expect(r4.nodes.map((x) => [x.id, x.depth])).toEqual([['subnet-1', 1], ['i-1', 2], ['tg-1', 3], ['lb-1', 4]]);
  });

  it('dependencies(lb, 6) reaches vpc at depth 4', async () => {
    const r = await s.dependencies(lb.arn, 6);
    const byId = Object.fromEntries(r.nodes.map((x) => [x.id, x.depth]));
    expect(byId).toEqual({ 'tg-1': 1, 'i-1': 2, 'subnet-1': 3, 'sg-a': 3, 'sg-b': 4, 'vpc-1': 4 });
  });

  it('SG cycle terminates with minimum depths', async () => {
    const r = await s.impact(sgA.arn, 6);
    const byId = Object.fromEntries(r.nodes.map((x) => [x.id, x.depth]));
    expect(byId).toEqual({ 'sg-b': 1, 'i-1': 1, 'tg-1': 2, 'lb-1': 3 });
    expect(r.nodes.find((x) => x.id === 'sg-a')).toBeUndefined();
  });

  it('unknown arn: walks are empty, neighborhood is null', async () => {
    expect(await s.impact('arn:nope', 3)).toEqual({ nodes: [], truncated: false });
    expect(await s.dependencies('arn:nope', 3)).toEqual({ nodes: [], truncated: false });
    expect(await s.neighborhood('arn:nope', 2)).toBeNull();
  });

  it('neighborhood(instance, 1) has sides and inner edges', async () => {
    const nb = (await s.neighborhood(instance.arn, 1))!;
    expect(nb.center).toEqual(instance);
    expect(nb.truncated).toBe(false);
    const side = Object.fromEntries(nb.nodes.map((x) => [x.id, [x.side, x.depth]]));
    expect(side).toEqual({ 'i-1': ['center', 0], 'tg-1': ['dependent', 1], 'subnet-1': ['dependency', 1], 'sg-a': ['dependency', 1] });
    const keys = nb.edges.map((x) => `${x.src}>${x.dst}`);
    expect(keys).toContain(`${tg.arn}>${instance.arn}`);
    expect(keys).toContain(`${instance.arn}>${subnet.arn}`);
    // Only edges with both ends in the set.
    // 두 끝이 모두 집합 안에 있는 간선만.
    expect(keys).not.toContain(`${subnet.arn}>${vpc.arn}`);
  });

  it('neighborhood tie goes to dependent (cycle A ↔ B)', async () => {
    const nb = (await s.neighborhood(sgA.arn, 1))!;
    expect(nb.nodes.find((x) => x.id === 'sg-b')).toMatchObject({ side: 'dependent', depth: 1 });
    expect(nb.edges).toHaveLength(3); // A→B, B→A, instance→A
  });

  it('edgeTypes filter limits the recursive step', async () => {
    // allows_from is not followed, so sg-b (and what reaches it) drops out.
    // allows_from을 따라가지 않으므로 sg-b는 빠진다.
    const r = await s.impact(sgA.arn, 6, { edgeTypes: ['uses_sg'] });
    expect(r.nodes.map((x) => x.id)).toEqual(['i-1']);
    const d = await s.dependencies(lb.arn, 6, { edgeTypes: ['forwards_to', 'targets'] });
    expect(d.nodes.map((x) => [x.id, x.depth])).toEqual([['tg-1', 1], ['i-1', 2]]);
    // No filter keeps the old behaviour. / 필터가 없으면 그대로.
    expect((await s.impact(sgA.arn, 6, {})).nodes).toHaveLength(4);
  });

  it('search filters by type', async () => {
    expect((await s.search('web', { type: 'instance' })).map((x) => x.id)).toEqual(['i-1']);
    expect(await s.search('web', { type: 'vpc' })).toEqual([]);
  });

  it('search is case-insensitive and escapes LIKE wildcards', async () => {
    expect((await s.search('WEB')).map((x) => x.id)).toEqual(['i-1']);
    const pctHits = await s.search('100%');
    expect(pctHits.map((x) => x.id)).toEqual(['role-pct']);
    expect(await s.search('_')).toEqual([]);
    // Exact id match first.
    // ID가 정확히 같은 것을 먼저.
    expect((await s.search('sg-a'))[0].id).toBe('sg-a');
  });
});

// Star of 350 subnets in one VPC.
// VPC 하나에 서브넷 350개.
const hub = n('vpc', 'vpc-hub', 'hub');
const leaves = Array.from({ length: 350 }, (_, i) => n('subnet', `subnet-${String(i).padStart(3, '0')}`));
// Plus two unconnected nodes for the exact-match-first search check.
// 정확 일치 우선 검색 확인용 노드 두 개.
const aWeb = n('role', 'role-a-web', 'a-web');
const web = n('role', 'role-web', 'web');
const star: GraphData = { nodes: [hub, ...leaves, aWeb, web], edges: leaves.map((l) => e(l, hub, 'in_vpc')), dropped: 0 };

describe('star store', () => {
  let s: GraphStore;
  beforeAll(async () => { s = await createGraphStore(star, stats(star)); });
  afterAll(async () => { await s.close(); });

  it('impact on a hub is capped at 300 with truncated', async () => {
    const r = await s.impact(hub.arn, 1);
    expect(r.nodes).toHaveLength(WALK_CAP);
    expect(r.truncated).toBe(true);
  });

  it('neighborhood is capped too', async () => {
    const nb = (await s.neighborhood(hub.arn, 2))!;
    // One side may use the other side's unused budget: 300 plus the center.
    // 한쪽이 비면 다른 쪽이 예산을 넘겨받는다 — 300개 + 중심.
    expect(nb.nodes.length).toBeLessThanOrEqual(WALK_CAP + 1);
    expect(nb.truncated).toBe(true);
    expect(nb.nodes[0].side).toBe('center');
  });

  it('neighborhood edges only join nodes in the capped set', async () => {
    const nb = (await s.neighborhood(hub.arn, 2))!;
    expect(nb.nodes).toHaveLength(WALK_CAP + 1);
    const inSet = new Set(nb.nodes.map((x) => x.arn));
    expect(nb.edges).toHaveLength(WALK_CAP); // one leaf → hub edge per returned leaf
    for (const ed of nb.edges) {
      expect(inSet.has(ed.src)).toBe(true);
      expect(inSet.has(ed.dst)).toBe(true);
    }
  });

  it('search puts an exact name match first', async () => {
    const hits = await s.search('web');
    expect(hits.map((x) => x.name)).toEqual(['web', 'a-web']);
  });

  it('hubs limit is clamped to the max', async () => {
    expect(await s.hubs({ limit: 150 })).toHaveLength(1);
    expect(clampLimit(150, 10, 100)).toBe(100);
    expect(clampLimit('5', 10, 100)).toBe(5);
    expect(clampLimit(0, 10, 100)).toBe(10);
    expect(clampLimit(2.5, 10, 100)).toBe(10);
    expect(clampLimit(undefined, 10, 100)).toBe(10);
  });

  it('hubs ranks by incoming edges', async () => {
    const h = await s.hubs();
    expect(h[0]).toMatchObject({ arn: hub.arn, dependents: 350 });
    expect(typeof h[0].dependents).toBe('number');
    expect(h.length).toBe(1);
  });

  it('search returns at most 20', async () => {
    expect(await s.search('subnet')).toHaveLength(20);
    expect(await s.search('subnet', { limit: 5 })).toHaveLength(5);
    expect(await s.search('subnet', { accountId: '999999999999' })).toEqual([]);
  });
});

describe('two-sided neighborhood cap', () => {
  it('both sides over 150 give 150 each and truncated', async () => {
    const c = n('sg', 'sg-center');
    const users = Array.from({ length: 200 }, (_, i) => n('instance', `u-${String(i).padStart(3, '0')}`));
    const used = Array.from({ length: 200 }, (_, i) => n('sg', `d-${String(i).padStart(3, '0')}`));
    const g: GraphData = {
      nodes: [c, ...users, ...used],
      edges: [...users.map((u) => e(u, c, 'uses_sg')), ...used.map((d) => e(c, d, 'allows_from'))],
      dropped: 0,
    };
    const s = await createGraphStore(g, stats(g));
    try {
      const nb = (await s.neighborhood(c.arn, 1))!;
      expect(nb.nodes.filter((x) => x.side === 'dependent')).toHaveLength(150);
      expect(nb.nodes.filter((x) => x.side === 'dependency')).toHaveLength(150);
      expect(nb.nodes).toHaveLength(301);
      expect(nb.truncated).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('a small side hands its unused budget to the other side', async () => {
    const c = n('sg', 'sg-c2');
    const users = Array.from({ length: 250 }, (_, i) => n('instance', `w-${String(i).padStart(3, '0')}`));
    const used = Array.from({ length: 20 }, (_, i) => n('sg', `x-${String(i).padStart(3, '0')}`));
    const g: GraphData = {
      nodes: [c, ...users, ...used],
      edges: [...users.map((u) => e(u, c, 'uses_sg')), ...used.map((d) => e(c, d, 'allows_from'))],
      dropped: 0,
    };
    const s = await createGraphStore(g, stats(g));
    try {
      const nb = (await s.neighborhood(c.arn, 1))!;
      expect(nb.nodes.filter((x) => x.side === 'dependent')).toHaveLength(250);
      expect(nb.nodes.filter((x) => x.side === 'dependency')).toHaveLength(20);
      expect(nb.truncated).toBe(false);
    } finally {
      await s.close();
    }
  });
});

describe('exactly-at-cap star', () => {
  it('300 leaves is not truncated; duplicate ARNs do not fail the load', async () => {
    const h = n('vpc', 'vpc-300');
    const ls = Array.from({ length: WALK_CAP }, (_, i) => n('subnet', `s300-${String(i).padStart(3, '0')}`));
    const g: GraphData = { nodes: [h, ...ls, ls[0]], edges: ls.map((l) => e(l, h, 'in_vpc')), dropped: 0 };
    const s = await createGraphStore(g, stats(g));
    try {
      const r = await s.impact(h.arn, 1);
      expect(r.nodes).toHaveLength(WALK_CAP);
      expect(r.truncated).toBe(false);
    } finally {
      await s.close();
    }
  });
});

describe('clampDepth', () => {
  it('accepts only integers within range', () => {
    expect(clampDepth('7', 3, 6)).toBe(3);
    expect(clampDepth(2, 3, 6)).toBe(2);
    expect(clampDepth(2.5, 3, 6)).toBe(3);
    expect(clampDepth(0, 3, 6)).toBe(3);
    expect(clampDepth(7, 3, 6)).toBe(3);
    expect(clampDepth(undefined, 2, 3)).toBe(2);
    // Digit-only strings (query params) are accepted.
    // 숫자만 있는 문자열(쿼리 파라미터)은 받아들인다.
    expect(clampDepth('2', 3, 6)).toBe(2);
    expect(clampDepth('2.5', 3, 6)).toBe(3);
    expect(clampDepth('', 3, 6)).toBe(3);
    expect(clampDepth(' 2', 3, 6)).toBe(3);
  });
});

describe('current store holder', () => {
  it('refuses to swap in an older build: closes it and keeps the current one', async () => {
    const small: GraphData = { nodes: [vpc], edges: [], dropped: 0 };
    const newer = await createGraphStore(small, { ...stats(small), builtAt: '2026-10-28T02:00:00.000Z' });
    const older = await createGraphStore(small, { ...stats(small), builtAt: '2026-10-28T01:00:00.000Z' });
    expect(setCurrentStore(newer, 0)).toBe(true);
    expect(setCurrentStore(older, 0)).toBe(false);
    expect(getCurrentStore()).toBe(newer);
    await vi.waitFor(async () => { await expect(older.node(vpc.arn)).rejects.toBeTruthy(); });
    expect(await newer.node(vpc.arn)).toEqual(vpc);
    await newer.close();
    (globalThis as { __awsopsDepGraph?: unknown }).__awsopsDepGraph = undefined;
  });

  it('swaps the pointer and closes the previous store', async () => {
    const small: GraphData = { nodes: [vpc], edges: [], dropped: 0 };
    const a = await createGraphStore(small, stats(small));
    const b = await createGraphStore(small, stats(small));
    setCurrentStore(a, 0);
    expect(getCurrentStore()).toBe(a);
    setCurrentStore(b, 0);
    expect(getCurrentStore()).toBe(b);
    // The previous store closes after the delay; a later query on a must reject.
    // 지연 뒤 이전 저장소가 닫혀서 질의가 실패해야 한다.
    await vi.waitFor(async () => {
      await expect(a.node(vpc.arn)).rejects.toBeTruthy();
    });
    await expect(a.node(vpc.arn)).rejects.toBeTruthy();
    expect(await b.node(vpc.arn)).toEqual(vpc);
    await b.close();
  });
});
