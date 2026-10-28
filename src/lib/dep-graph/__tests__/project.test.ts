import { describe, it, expect } from 'vitest';
import { previewProject } from '../project';
import type { GraphData, GraphNode, NodeType, EdgeType } from '../types';

function n(arn: string, type: NodeType, name: string, tags?: Record<string, string>, accountId = '111'): GraphNode {
  return { arn, type, id: arn, name, accountId, region: 'r', attrs: tags ? { tags } : {} };
}
const e = (src: string, dst: string, type: EdgeType = 'uses_sg') => ({ src, dst, type });
const g = (nodes: GraphNode[], edges: ReturnType<typeof e>[]): GraphData => ({ nodes, edges, dropped: 0 });

const base = g(
  [n('a', 'instance', 'moyeota-a'), n('sg', 'sg', 'moyeota-sg'), n('o', 'instance', 'other'), n('s', 'subnet', 's')],
  [e('a', 'sg'), e('o', 'sg'), e('a', 's', 'in_subnet'), e('o', 's', 'in_subnet')],
);

describe('previewProject', () => {
  it('prefix seed: members, blockers, shared, order', () => {
    const p = previewProject(base, { kind: 'prefix', prefix: 'moyeota-' });
    expect(p.seedCount).toBe(2);
    expect(p.members.map(m => m.arn).sort()).toEqual(['a', 'sg']);
    expect(p.blockers.map(b => [b.node.arn, b.uses])).toEqual([['o', ['sg']]]);
    expect(p.shared.map(s => s.arn)).toEqual(['s']);
    expect(p.order).toEqual([{ step: 1, arns: ['a'], cycle: false }, { step: 2, arns: ['sg'], cycle: false }]);
  });
  it('exclusively owned dependency joins members after the instance', () => {
    const d = g([n('a', 'instance', 'moyeota-a'), n('v', 'ebs', 'vol')], [e('a', 'v', 'uses_volume')]);
    const p = previewProject(d, { kind: 'prefix', prefix: 'moyeota-' });
    expect(p.members.map(m => m.arn).sort()).toEqual(['a', 'v']);
    expect(p.order.map(o => o.arns)).toEqual([['a'], ['v']]);
  });
  it('vpc seed orders instance, subnet, vpc', () => {
    const d = g([n('v', 'vpc', 'vpc'), n('s', 'subnet', 's'), n('i', 'instance', 'i')], [e('s', 'v', 'in_vpc'), e('i', 's', 'in_subnet')]);
    const p = previewProject(d, { kind: 'vpc', arn: 'v' });
    expect(p.order.map(o => o.arns)).toEqual([['i'], ['s'], ['v']]);
    expect(previewProject(d, { kind: 'vpc', arn: 'zzz' }).members).toEqual([]);
  });
  it('cycle gives one step', () => {
    const d = g([n('A', 'sg', 'p-A'), n('B', 'sg', 'p-B')], [e('A', 'B', 'allows_from'), e('B', 'A', 'allows_from')]);
    const p = previewProject(d, { kind: 'prefix', prefix: 'p-' });
    expect(p.order).toEqual([{ step: 1, arns: ['A', 'B'], cycle: true }]);
  });
  it('tag seed matches only tagged nodes; missing tags tolerated', () => {
    const d = g([n('a', 'instance', 'a', { Project: 'x' }), n('b', 'instance', 'b', { Project: 'y' }), n('c', 'instance', 'c')], []);
    const p = previewProject(d, { kind: 'tag', key: 'Project', value: 'x' });
    expect(p.members.map(m => m.arn)).toEqual(['a']);
  });
  it('accountId filters seeds', () => {
    const d = g([n('a', 'instance', 'p-a', undefined, '111'), n('b', 'instance', 'p-b', undefined, '222')], []);
    const p = previewProject(d, { kind: 'prefix', prefix: 'p-' }, { accountId: '222' });
    expect(p.members.map(m => m.arn)).toEqual(['b']);
  });
  it('empty seed gives empty preview', () => {
    const p = previewProject(base, { kind: 'prefix', prefix: 'nope' });
    expect(p).toEqual({ seedCount: 0, members: [], order: [], blockers: [], shared: [] });
  });
});
