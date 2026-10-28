import { describe, it, expect } from 'vitest';
import { buildNodes, buildIndex } from '../nodes';
import { EdgeSink } from '../sink';
import { deliveryEdges } from '../extract/delivery';
import type { Rows } from '../types';

const A = '111111111111';
const R = 'ap-northeast-2';
const b = { account_id: A, region: R };
const arn = (s: string) => `arn:aws:ec2:${R}:${A}:${s}`;
const lbArn = `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/app/my-alb/abc123`;
const tgArn = `arn:aws:elasticloadbalancing:${R}:${A}:targetgroup/tg1/def456`;
const tgLam = `arn:aws:elasticloadbalancing:${R}:${A}:targetgroup/tglam/def457`;
const fnArn = `arn:aws:lambda:${R}:${A}:function:fn`;

const rows: Rows = {
  vpc: [{ arn: arn('vpc/vpc-1'), vpc_id: 'vpc-1', ...b }],
  subnet: [
    { subnet_arn: arn('subnet/subnet-1'), subnet_id: 'subnet-1', ...b },
    { subnet_arn: arn('subnet/subnet-2'), subnet_id: 'subnet-2', ...b },
    { subnet_arn: arn('subnet/subnet-3'), subnet_id: 'subnet-3', ...b },
  ],
  sg: [{ arn: arn('security-group/sg-1'), group_id: 'sg-1', ...b }],
  instance: [{ arn: arn('instance/i-1'), instance_id: 'i-1', ...b }],
  alb: [{ arn: lbArn, name: 'my-alb', dns_name: 'My-ALB-1.ap-northeast-2.elb.amazonaws.com', availability_zones: [{ SubnetId: 'subnet-1' }], security_groups: ['sg-1'], ...b }],
  clb: [{ arn: `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/clb1`, name: 'clb1', subnets: ['subnet-2'], security_groups: ['sg-1'], ...b }],
  tg: [
    { target_group_arn: tgArn, target_group_name: 'tg1', target_type: 'instance', vpc_id: 'vpc-1', load_balancer_arns: [lbArn], target_health_descriptions: [{ Target: { Id: 'i-1' } }], ...b },
    { target_group_arn: tgLam, target_group_name: 'tglam', target_type: 'lambda', vpc_id: null, load_balancer_arns: [], target_health_descriptions: [{ Target: { Id: fnArn } }], ...b },
  ],
  lambda: [{ arn: fnArn, name: 'fn', ...b }],
  rds: [{ arn: `arn:aws:rds:${R}:${A}:db:db1`, db_instance_identifier: 'db1', subnets: [{ SubnetIdentifier: 'subnet-3' }], vpc_security_groups: [{ VpcSecurityGroupId: 'sg-1' }], ...b }],
  s3: [
    { arn: 'arn:aws:s3:::b', name: 'b', event_notification_configuration: { LambdaFunctionConfigurations: [{ LambdaFunctionArn: fnArn }] }, ...b },
    { arn: 'arn:aws:s3:::web', name: 'web', ...b },
  ],
  cloudfront: [{
    arn: `arn:aws:cloudfront::${A}:distribution/E1`, id: 'E1', partition: 'aws', ...b,
    origins: [
      { DomainName: 'b.s3.ap-northeast-2.amazonaws.com' },
      { DomainName: 'web.s3-website-ap-northeast-2.amazonaws.com' },
      { DomainName: 'MY-ALB-1.ap-northeast-2.elb.amazonaws.com' },
      { DomainName: 'custom.example.com' },
    ],
  }],
};

function run(r: Rows) {
  const ix = buildIndex(buildNodes(r));
  const sink = new EdgeSink();
  deliveryEdges(r, ix, sink);
  return sink.result();
}
const has = (edges: { src: string; dst: string; type: string }[], src: string, dst: string, type: string) =>
  edges.some(e => e.src === src && e.dst === dst && e.type === type);

describe('deliveryEdges', () => {
  const { edges, dropped } = run(rows);
  const clb = `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/clb1`;
  it('lb edges', () => {
    expect(has(edges, lbArn, arn('subnet/subnet-1'), 'in_subnet')).toBe(true);
    expect(has(edges, clb, arn('subnet/subnet-2'), 'in_subnet')).toBe(true);
    expect(has(edges, lbArn, arn('security-group/sg-1'), 'uses_sg')).toBe(true);
    expect(has(edges, clb, arn('security-group/sg-1'), 'uses_sg')).toBe(true);
    expect(has(edges, lbArn, tgArn, 'forwards_to')).toBe(true);
  });
  it('tg edges', () => {
    expect(has(edges, tgArn, arn('instance/i-1'), 'targets')).toBe(true);
    expect(has(edges, tgLam, fnArn, 'targets')).toBe(true);
    expect(has(edges, tgArn, arn('vpc/vpc-1'), 'in_vpc')).toBe(true);
  });
  it('rds edges', () => {
    const db = `arn:aws:rds:${R}:${A}:db:db1`;
    expect(has(edges, db, arn('subnet/subnet-3'), 'in_subnet')).toBe(true);
    expect(has(edges, db, arn('security-group/sg-1'), 'uses_sg')).toBe(true);
  });
  it('s3 notifies lambda', () => expect(has(edges, 'arn:aws:s3:::b', fnArn, 'notifies')).toBe(true));
  it('cloudfront origins', () => {
    const cf = `arn:aws:cloudfront::${A}:distribution/E1`;
    expect(has(edges, cf, 'arn:aws:s3:::b', 'origin')).toBe(true);
    expect(has(edges, cf, 'arn:aws:s3:::web', 'origin')).toBe(true);
    expect(has(edges, cf, lbArn, 'origin')).toBe(true);
    expect(edges.filter(e => e.src === cf).length).toBe(3);
  });
  it('custom origin and ip targets are not dropped', () => expect(dropped).toBe(0));
  it('survives null / wrong shapes', () => {
    const bad: Rows = { alb: [{ arn: lbArn, name: 'x', availability_zones: null, security_groups: 'x', ...b }], tg: [{ target_group_arn: tgArn, target_group_name: 't', target_type: 'instance', load_balancer_arns: null, target_health_descriptions: null, ...b }], cloudfront: [{ arn: 'a', id: 'E', origins: null, ...b }], s3: [{ arn: 'arn:aws:s3:::z', name: 'z', event_notification_configuration: null, ...b }] };
    expect(() => run(bad)).not.toThrow();
  });
});
