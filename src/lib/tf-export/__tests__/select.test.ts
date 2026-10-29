import { describe, it, expect } from 'vitest';
import { selectResources, importIdFor, TF_TYPE } from '../select';
import type { GraphData, GraphNode, NodeType, EdgeType } from '@/lib/dep-graph/types';

const R = 'ap-northeast-2';
function n(arn: string, type: NodeType, name: string, o: { tags?: Record<string, string>; region?: string; acc?: string; attrs?: Record<string, unknown>; id?: string } = {}): GraphNode {
  return { arn, type, id: o.id ?? arn, name, accountId: o.acc ?? '111', region: o.region ?? R, attrs: { ...(o.tags ? { tags: o.tags } : {}), ...(o.attrs ?? {}) } };
}
const e = (src: string, dst: string, type: EdgeType = 'uses_sg') => ({ src, dst, type });
const g = (nodes: GraphNode[], edges: ReturnType<typeof e>[] = []): GraphData => ({ nodes, edges, dropped: 0 });
const T = { key: 'p', value: 'x' };
const tag = { kind: 'tag' as const, ...T };
const tg = { p: 'x' };
const run = (data: GraphData, seed: any = tag, listeners?: any) =>
  selectResources({ accountId: '111', seed, data, region: R, listeners });

describe('selectResources exclusions', () => {
  it('drops eni and clb as unsupported', async () => {
    const d = g([n('i', 'instance', 'i', { tags: tg }), n('en', 'eni', 'en', { tags: tg }), n('c', 'lb', 'c', { tags: tg, attrs: { lbType: 'classic' } })]);
    const r = await run(d);
    expect(r.items.map(i => i.nodeArn)).toEqual(['i']);
    expect(r.excluded.filter(x => x.reason === 'unsupported').map(x => x.nodeArn).sort()).toEqual(['c', 'en']);
  });
  it('marks EBS attached to an instance', async () => {
    const d = g([n('i', 'instance', 'i', { tags: tg }), n('v', 'ebs', 'v', { tags: tg }), n('v2', 'ebs', 'v2', { tags: tg })], [e('i', 'v', 'uses_volume')]);
    const r = await run(d);
    expect(r.excluded).toEqual([{ nodeArn: 'v', name: 'v', nodeType: 'ebs', reason: 'attached-to-instance' }]);
    expect(r.items.map(i => i.nodeArn).sort()).toEqual(['i', 'v2']);
  });
  it('marks service-linked roles', async () => {
    const d = g([n('r1', 'role', 'a', { tags: tg, attrs: { path: '/aws-service-role/x/' } }), n('r2', 'role', 'b', { tags: tg, attrs: { path: '/' } })]);
    const r = await run(d);
    expect(r.excluded[0].reason).toBe('service-role');
    expect(r.items.map(i => i.nodeArn)).toEqual(['r2']);
  });
  it('marks other region except role/cloudfront', async () => {
    const d = g([n('s', 'subnet', 's', { tags: tg, region: 'us-east-1' }), n('ro', 'role', 'ro', { tags: tg, region: '' }), n('cf', 'cloudfront', 'cf', { tags: tg, region: 'us-east-1' })]);
    const r = await run(d);
    expect(r.excluded).toEqual([{ nodeArn: 's', name: 's', nodeType: 'subnet', reason: 'other-region' }]);
    expect(r.items.length).toBe(2);
  });
  it('marks shared and managed', async () => {
    const d = g([n('i', 'instance', 'i', { tags: tg }), n('sg', 'sg', 'sg'), n('o', 'instance', 'o'), n('me', 'eni', 'me', { attrs: { requesterManaged: true } })],
      [e('i', 'sg'), e('o', 'sg'), e('me', 'i', 'uses_eni')]);
    const r = await run(d);
    expect(r.excluded.find(x => x.nodeArn === 'sg')?.reason).toBe('shared');
    expect(r.excluded.find(x => x.nodeArn === 'me')?.reason).toBe('managed');
  });
  it('arns seed: same account only', async () => {
    const d = g([n('a', 'subnet', 'a'), n('b', 'subnet', 'b', { acc: '222' })]);
    const r = await run(d, { kind: 'arns', arns: ['a', 'b', 'zz'] });
    expect(r.items.map(i => i.nodeArn)).toEqual(['a']);
    expect(r.excluded).toEqual([]);
  });
});

describe('cap, order, listeners', () => {
  it('orders by type and caps at 60', async () => {
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 40; i++) nodes.push(n(`s${i}`, 'subnet', `s${i}`, { tags: tg }));
    for (let i = 0; i < 30; i++) nodes.push(n(`b${i}`, 's3', `b${i}`, { tags: tg, id: `b${i}` }));
    nodes.push(n('v', 'vpc', 'v', { tags: tg }));
    const r = await run(g(nodes));
    expect(r.items.length).toBe(60);
    expect(r.items[0].tfType).toBe('aws_vpc');
    expect(r.items[0].address).toBe('aws_vpc.r1');
    expect(r.items[1].address).toBe('aws_subnet.r2');
    expect(r.excluded.length).toBe(11);
    expect(r.excluded.every(x => x.reason === 'over-limit' && x.nodeType === 's3')).toBe(true);
  });
  it('appends listeners of included ALB/NLB only', async () => {
    const d = g([
      n('lb1', 'lb', 'a', { tags: tg, attrs: { lbType: 'application' } }),
      n('lb2', 'lb', 'c', { tags: tg, attrs: { lbType: 'classic' } }),
      n('t', 'tg', 't', { tags: tg }),
    ]);
    let asked: string[] = [];
    const r = await run(d, tag, async (arns: string[]) => { asked = arns; return [{ arn: 'l1', lbArn: 'lb1', port: 443, protocol: 'HTTPS' }]; });
    expect(asked).toEqual(['lb1']);
    expect(r.items.map(i => i.tfType)).toEqual(['aws_lb_target_group', 'aws_lb', 'aws_lb_listener']);
    const l = r.items[2];
    expect(l).toMatchObject({ address: 'aws_lb_listener.r3', importId: 'l1', nodeType: 'listener', nodeArn: 'l1' });
  });
  it('does not call listeners when no lb', async () => {
    let called = false;
    await run(g([n('i', 'instance', 'i', { tags: tg })]), tag, async () => { called = true; return []; });
    expect(called).toBe(false);
  });
});

describe('importIdFor', () => {
  const mk = (type: NodeType) => n(`arn-${type}`, type, `name-${type}`, { id: `id-${type}` });
  it('maps per type', () => {
    expect(importIdFor(mk('lb'))).toBe('arn-lb');
    expect(importIdFor(mk('tg'))).toBe('arn-tg');
    for (const t of ['role', 'lambda', 's3', 'vpc', 'subnet', 'sg', 'instance', 'rds', 'nat', 'eip', 'ebs', 'cloudfront'] as NodeType[]) expect(importIdFor(mk(t))).toBe(`id-${t}`);
  });
  it('TF_TYPE', () => {
    expect(TF_TYPE.eni).toBeNull();
    expect(TF_TYPE.eip).toBe('aws_eip');
  });
});
