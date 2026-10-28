import { describe, it, expect } from 'vitest';
import { buildNodes, buildIndex } from '../nodes';
import { EdgeSink } from '../sink';
import { iamEdges, policyResourceArns } from '../extract/iam';
import type { Rows } from '../types';

const A = '111111111111';
const R = 'ap-northeast-2';
const b = { account_id: A, region: R };
const roleArn = `arn:aws:iam::${A}:role/r1`;
const polArn = `arn:aws:iam::${A}:policy/p1`;
const fnArn = `arn:aws:lambda:${R}:${A}:function:fn`;

describe('policyResourceArns', () => {
  it('string Resource in object Statement', () =>
    expect(policyResourceArns({ Statement: { Effect: 'Allow', Resource: 'arn:aws:s3:::b/*' } })).toEqual(['arn:aws:s3:::b/*']));
  it('array Resource in array Statement', () =>
    expect(policyResourceArns({ Statement: [{ Effect: 'Allow', Resource: ['a', 'b'] }, { Effect: 'Allow', Resource: 'c' }] })).toEqual(['a', 'b', 'c']));
  it('excludes Deny and NotResource', () => {
    expect(policyResourceArns({ Statement: [{ Effect: 'Deny', Resource: 'x' }, { Effect: 'Allow', NotResource: 'y' }] })).toEqual([]);
  });
  it('bad shapes give []', () => {
    expect(policyResourceArns(null)).toEqual([]);
    expect(policyResourceArns('x')).toEqual([]);
    expect(policyResourceArns({ Statement: 5 })).toEqual([]);
    expect(policyResourceArns({ Statement: [null, { Effect: 'Allow', Resource: [1, 'ok'] }] })).toEqual(['ok']);
  });
});

describe('iamEdges', () => {
  const rows: Rows = {
    s3: [{ arn: 'arn:aws:s3:::b', name: 'b', ...b }, { arn: 'arn:aws:s3:::c', name: 'c', ...b }],
    lambda: [{ arn: fnArn, name: 'fn', ...b }],
    instance: [{ arn: `arn:aws:ec2:${R}:${A}:instance/i-1`, instance_id: 'i-1', ...b }],
    role: [{ arn: roleArn, name: 'r1', ...b }],
    rolePolicy: [{
      arn: roleArn, attached_policy_arns: [polArn, 'arn:aws:iam::aws:policy/Managed'], ...b,
      inline_policies_std: [{ PolicyName: 'in', PolicyDocument: { Statement: [
        { Effect: 'Allow', Resource: ['arn:aws:s3:::b/*', 'arn:aws:ec2:*:*:instance/*', fnArn] },
        { Effect: 'Deny', Resource: 'arn:aws:s3:::c' },
      ] } }],
    }],
    policy: [
      { arn: polArn, policy_std: { Statement: { Effect: 'Allow', Resource: 'arn:aws:s3:::c' } }, ...b },
      { arn: 'arn:aws:iam::1:policy/unattached', policy_std: { Statement: { Effect: 'Allow', Resource: `arn:aws:ec2:${R}:${A}:instance/i-1` } }, ...b },
      { arn: 'arn:aws:iam::1:policy/nul', policy_std: null, ...b },
    ],
  };
  const ix = buildIndex(buildNodes(rows));
  const sink = new EdgeSink();
  iamEdges(rows, ix, sink);
  const { edges, dropped } = sink.result();
  it('inline S3 prefix, exact ARN, attached policy', () => {
    expect(edges.some(e => e.src === roleArn && e.dst === 'arn:aws:s3:::b' && e.type === 'can_access')).toBe(true);
    expect(edges.some(e => e.src === roleArn && e.dst === fnArn && e.type === 'can_access')).toBe(true);
    expect(edges.some(e => e.src === roleArn && e.dst === 'arn:aws:s3:::c')).toBe(true);
  });
  it('wildcards, unattached policies add nothing; nothing dropped', () => {
    expect(edges.length).toBe(3);
    expect(dropped).toBe(0);
  });
  it('rolePolicy rows without a role node add nothing', () => {
    const r: Rows = {
      s3: [{ arn: 'arn:aws:s3:::b', name: 'b', ...b }],
      rolePolicy: [{ arn: roleArn, inline_policies_std: [{ PolicyDocument: { Statement: { Effect: 'Allow', Resource: 'arn:aws:s3:::b' } } }], ...b }],
    };
    const s = new EdgeSink();
    iamEdges(r, buildIndex(buildNodes(r)), s);
    expect(s.result()).toEqual({ edges: [], dropped: 0 });
  });
  it('survives bad shapes', () => {
    const bad: Rows = {
      role: [{ arn: roleArn, name: 'r', ...b }, { arn: 'r2', name: 'r2', ...b }],
      rolePolicy: [{ arn: roleArn, inline_policies_std: 'x', attached_policy_arns: null, ...b }, { arn: 'r2', inline_policies_std: [null, { PolicyDocument: null }], ...b }, null as never],
    };
    const s = new EdgeSink();
    expect(() => iamEdges(bad, buildIndex(buildNodes(bad)), s)).not.toThrow();
  });
});
