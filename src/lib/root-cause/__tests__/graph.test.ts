import { describe, it, expect } from 'vitest';
import { mergeGraphs, resolveRefs, proximity, findNode } from '../graph';
import type { GraphData, GraphNode, NodeType } from '@/lib/dep-graph/types';
import type { GraphSnapshot } from '../types';

const A = '111111111111';
const node = (type: NodeType, id: string, acct = A, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ arn: `arn:aws:x:r:${acct}:${type}/${id}`, type, id, name: id, accountId: acct, region: 'r', attrs: {}, ...extra });
const g = (nodes: GraphNode[], edges: Array<[GraphNode, GraphNode]>): GraphData =>
  ({ nodes, edges: edges.map(([s, d]) => ({ src: s.arn, dst: d.arn, type: 'uses_sg' as const })), dropped: 0 });
const snap = (min: number, data: GraphData): GraphSnapshot => ({ builtAt: new Date(Date.UTC(2026, 9, 29, 0, min)).toISOString(), data });
const T = (min: number) => new Date(Date.UTC(2026, 9, 29, 0, min));

const lb = node('lb', 'alb'), tg = node('tg', 'tg'), i = node('instance', 'i-1'), eni = node('eni', 'eni-1'), sg = node('sg', 'sg-1');

describe('mergeGraphs', () => {
  it('takes window snapshots plus the latest one before the window', () => {
    const s0 = snap(0, g([lb], [])), s1 = snap(10, g([tg], [])), s2 = snap(20, g([i], [])), s3 = snap(30, g([eni], [])), s4 = snap(50, g([sg], []));
    const m = mergeGraphs([s0, s1, s2, s3, s4], T(15), T(40), null);
    expect(m.count).toBe(3);
    expect(m.from).toBe(s1.builtAt);
    expect(m.to).toBe(s3.builtAt);
    expect(m.data.nodes.map((n) => n.id).sort()).toEqual(['eni-1', 'i-1', 'tg']);
  });
  it('keeps an edge present only in the older snapshot; later attrs win', () => {
    const old = snap(0, g([i, sg], [[i, sg]]));
    const newer = snap(10, g([{ ...i, name: 'renamed' }, sg], []));
    const m = mergeGraphs([old, newer], T(5), T(20), null);
    expect(m.data.edges).toHaveLength(1);
    expect(m.data.nodes.find((n) => n.id === 'i-1')?.name).toBe('renamed');
  });
  it('falls back to current, then to empty', () => {
    const cur = g([lb], []);
    expect(mergeGraphs([], T(0), T(10), cur)).toEqual({ data: cur, from: null, to: null, count: 0 });
    expect(mergeGraphs([], T(0), T(10), null).data.nodes).toEqual([]);
  });
});

describe('resolveRefs', () => {
  const other = node('sg', 'default', '222222222222');
  const mine = node('sg', 'default');
  const data = g([mine, other, lb], []);
  it('ignores the same id in another account', () => {
    expect(resolveRefs([{ type: 'sg', id: 'default' }], A, data)).toEqual([mine]);
    expect(resolveRefs([{ type: null, id: 'default' }], A, data)).toEqual([mine]);
  });
  it('arn first; foreign arn does not match; ambiguous id is skipped', () => {
    expect(resolveRefs([{ type: null, arn: lb.arn }], A, data)).toEqual([lb]);
    expect(resolveRefs([{ type: null, arn: other.arn }], A, data)).toEqual([]);
    const dup = g([node('sg', 'x'), node('lb', 'x')], []);
    expect(resolveRefs([{ type: null, id: 'x' }], A, dup)).toEqual([]);
  });
  it('uses the ARN account for roles', () => {
    const role = node('role', 'r1', 'wrong', { arn: `arn:aws:iam::${A}:role/r1` });
    expect(resolveRefs([{ type: 'role', id: 'r1' }], A, g([role], []))).toEqual([role]);
  });
});

describe('proximity', () => {
  const chain = g([lb, tg, i, eni, sg], [[lb, tg], [tg, i], [i, eni], [eni, sg]]);
  it('ALB to sg is 4 hops with 5 path entries', () => {
    const p = proximity(lb.arn, [sg], 1, chain);
    expect(p.distance).toBe(4);
    expect(p.path).toEqual(['alb(lb)', 'tg(tg)', 'i-1(instance)', 'eni-1(eni)', 'sg-1(sg)']);
    expect(p.matchedArn).toBe(sg.arn);
  });
  it('distance 0 and nearest candidate wins', () => {
    expect(proximity(lb.arn, [lb], 1, chain).distance).toBe(0);
    expect(proximity(lb.arn, [sg, tg], 2, chain).distance).toBe(1);
  });
  it('beyond 4 hops is unconnected', () => {
    const far = node('sg', 'far');
    const d = g([...chain.nodes, far], [[lb, tg], [tg, i], [i, eni], [eni, sg], [sg, far]]);
    expect(proximity(lb.arn, [far], 1, d)).toEqual({ distance: 'unconnected', path: [], matchedArn: null });
  });
  it('does not pass through a subnet', () => {
    const sub = node('subnet', 's');
    const d = g([i, sub, sg], [[i, sub], [sg, sub]]);
    expect(proximity(i.arn, [sg], 1, d).distance).toBe('unconnected');
    expect(proximity(i.arn, [sub], 1, d).distance).toBe(1);
  });
  it('hub with 16 edges is an endpoint only', () => {
    const hub = node('role', 'hub');
    const leaves = Array.from({ length: 15 }, (_, k) => node('lambda', `l${k}`));
    const d = g([hub, i, sg, ...leaves], [[i, hub], [sg, hub], ...leaves.map((l): [GraphNode, GraphNode] => [l, hub])]);
    expect(proximity(i.arn, [sg], 1, d).distance).toBe('unconnected');
    expect(proximity(i.arn, [hub], 1, d).distance).toBe(1);
  });
  it('no-target and not-in-graph', () => {
    expect(proximity(null, [sg], 1, chain).distance).toBe('no-target');
    expect(proximity(lb.arn, [], 3, chain).distance).toBe('not-in-graph');
  });
});

describe('findNode', () => {
  it('current first, then newest history', () => {
    const old = snap(0, g([{ ...sg, name: 'old' }], [])), newer = snap(10, g([{ ...sg, name: 'new' }], []));
    expect(findNode(lb.arn, g([lb], []), [old, newer])).toEqual(lb);
    expect(findNode(sg.arn, null, [old, newer])?.name).toBe('new');
    expect(findNode('nope', null, [old])).toBeNull();
  });
});
