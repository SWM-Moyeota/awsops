import { describe, it, expect } from 'vitest';
import { buildNodes, buildIndex } from '../nodes';
import { EdgeSink } from '../sink';
import { computeEdges } from '../extract/compute';
import type { Rows } from '../types';

const A = '111111111111';
const R = 'ap-northeast-2';
const b = { account_id: A, region: R };
const arn = (s: string) => `arn:aws:ec2:${R}:${A}:${s}`;
const roleArn = `arn:aws:iam::${A}:role/r1`;
const profArn = `arn:aws:iam::${A}:instance-profile/p1`;

function run(rows: Rows) {
  const ix = buildIndex(buildNodes(rows));
  const sink = new EdgeSink();
  computeEdges(rows, ix, sink);
  return sink.result();
}
const has = (edges: { src: string; dst: string; type: string }[], src: string, dst: string, type: string) =>
  edges.some(e => e.src === src && e.dst === dst && e.type === type);

const base: Rows = {
  subnet: [{ subnet_arn: arn('subnet/subnet-1'), subnet_id: 'subnet-1', ...b }],
  sg: [{ arn: arn('security-group/sg-1'), group_id: 'sg-1', ...b }],
  role: [{ arn: roleArn, name: 'r1', instance_profile_arns: [profArn], ...b }],
  instance: [{ arn: arn('instance/i-1'), instance_id: 'i-1', subnet_id: 'subnet-1', security_groups: [{ GroupId: 'sg-1' }], iam_instance_profile_arn: profArn, ...b }],
  ebs: [{ arn: arn('volume/vol-1'), volume_id: 'vol-1', attachments: [{ InstanceId: 'i-1' }], ...b }],
  lambda: [{ arn: `arn:aws:lambda:${R}:${A}:function:fn`, name: 'fn', role: roleArn, vpc_subnet_ids: ['subnet-1'], vpc_security_group_ids: ['sg-1'], ...b }],
  eni: [{ partition: 'aws', network_interface_id: 'eni-1', attached_instance_id: 'i-1', ...b }],
};

describe('computeEdges', () => {
  const { edges, dropped } = run(base);
  const i = arn('instance/i-1');
  const fn = `arn:aws:lambda:${R}:${A}:function:fn`;
  it('instance edges', () => {
    expect(has(edges, i, arn('subnet/subnet-1'), 'in_subnet')).toBe(true);
    expect(has(edges, i, arn('security-group/sg-1'), 'uses_sg')).toBe(true);
    expect(has(edges, i, roleArn, 'uses_role')).toBe(true);
    expect(has(edges, i, arn('volume/vol-1'), 'uses_volume')).toBe(true);
  });
  it('lambda edges', () => {
    expect(has(edges, fn, roleArn, 'uses_role')).toBe(true);
    expect(has(edges, fn, arn('subnet/subnet-1'), 'in_subnet')).toBe(true);
    expect(has(edges, fn, arn('security-group/sg-1'), 'uses_sg')).toBe(true);
  });
  it('nothing dropped', () => expect(dropped).toBe(0));
  it('JSON-string security_groups still produce uses_sg', () => {
    const r = run({ ...base, instance: [{ ...(base.instance![0]), security_groups: '[{"GroupId":"sg-1"}]' }] });
    expect(has(r.edges, i, arn('security-group/sg-1'), 'uses_sg')).toBe(true);
  });
  it('null JSONB and empty refs add nothing', () => {
    const r = run({ ...base, instance: [{ arn: i, instance_id: 'i-1', security_groups: null, subnet_id: null, iam_instance_profile_arn: null, ...b }],
      lambda: [{ arn: fn, name: 'fn', role: null, vpc_subnet_ids: null, vpc_security_group_ids: null, ...b }], ebs: [] });
    expect(r.edges.filter(e => e.src === i || e.src === fn)).toHaveLength(0);
    expect(r.dropped).toBe(0);
  });
  it('same lambda name in two regions links each region\'s own node', () => {
    const R2 = 'us-east-1';
    const fn2 = `arn:aws:lambda:${R2}:${A}:function:fn`;
    const sub2 = `arn:aws:ec2:${R2}:${A}:subnet/subnet-9`;
    const r = run({
      ...base,
      subnet: [...base.subnet!, { subnet_arn: sub2, subnet_id: 'subnet-9', account_id: A, region: R2 }],
      lambda: [
        { arn: fn, name: 'fn', vpc_subnet_ids: ['subnet-1'], ...b },
        { arn: fn2, name: 'fn', vpc_subnet_ids: ['subnet-9'], account_id: A, region: R2 },
      ],
    });
    expect(has(r.edges, fn, arn('subnet/subnet-1'), 'in_subnet')).toBe(true);
    expect(has(r.edges, fn2, sub2, 'in_subnet')).toBe(true);
    expect(has(r.edges, fn2, arn('subnet/subnet-1'), 'in_subnet')).toBe(false);
  });
  it('unresolvable profile or role counts as dropped', () => {
    const r = run({ ...base, instance: [{ arn: i, instance_id: 'i-1', iam_instance_profile_arn: 'arn:other', ...b }], lambda: [{ arn: fn, name: 'fn', role: 'arn:nope', ...b }] });
    expect(r.dropped).toBe(2);
  });
});
