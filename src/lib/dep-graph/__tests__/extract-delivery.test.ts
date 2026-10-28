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
const nlbArn = `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/net/my-nlb/fff111`;
const dbArn = `arn:aws:rds:${R}:${A}:db:db1`;
const eniArnOf = (id: string) => arn(`network-interface/${id}`);

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
  nlb: [{ arn: nlbArn, name: 'my-nlb', dns_name: 'my-nlb.elb.amazonaws.com', availability_zones: [{ SubnetId: 'subnet-2' }], security_groups: null, ...b }],
  clb: [{ arn: `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/clb1`, name: 'clb1', subnets: ['subnet-2'], security_groups: ['sg-1'], ...b }],
  tg: [
    { target_group_arn: tgArn, target_group_name: 'tg1', target_type: 'instance', vpc_id: 'vpc-1', load_balancer_arns: [lbArn], target_health_descriptions: [{ Target: { Id: 'i-1' } }], ...b },
    { target_group_arn: tgLam, target_group_name: 'tglam', target_type: 'lambda', vpc_id: null, load_balancer_arns: [], target_health_descriptions: [{ Target: { Id: fnArn } }], ...b },
  ],
  lambda: [{ arn: fnArn, name: 'fn', ...b }],
  rds: [{ arn: dbArn, db_instance_identifier: 'db1', subnets: [{ SubnetIdentifier: 'subnet-3' }], vpc_security_groups: [{ VpcSecurityGroupId: 'sg-1' }], ...b }],
  // RDS ENIs: r1 matches (subnet + same SG set), r2 has an extra SG, r3 is in another subnet.
  // RDS ENI — r1만 맞고(서브넷 + 같은 SG 집합), r2는 SG가 하나 더, r3는 다른 서브넷.
  eni: [
    { partition: 'aws', network_interface_id: 'eni-r1', description: 'RDSNetworkInterface', subnet_id: 'subnet-3', groups: [{ GroupId: 'sg-1' }], ...b },
    { partition: 'aws', network_interface_id: 'eni-r2', description: 'RDSNetworkInterface', subnet_id: 'subnet-3', groups: [{ GroupId: 'sg-1' }, { GroupId: 'sg-2' }], ...b },
    { partition: 'aws', network_interface_id: 'eni-r3', description: 'RDSNetworkInterface', subnet_id: 'subnet-1', groups: [{ GroupId: 'sg-1' }], ...b },
  ],
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
    expect(has(edges, nlbArn, arn('subnet/subnet-2'), 'in_subnet')).toBe(true);
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
  it('rds -> its own ENI only when subnet and SG set match', () => {
    expect(has(edges, dbArn, eniArnOf('eni-r1'), 'uses_eni')).toBe(true);
    expect(has(edges, dbArn, eniArnOf('eni-r2'), 'uses_eni')).toBe(false);
    expect(has(edges, dbArn, eniArnOf('eni-r3'), 'uses_eni')).toBe(false);
  });
  it('same lb / tg / rds name in two regions links each region\'s own node', () => {
    const R2 = 'us-east-1';
    const b2 = { account_id: A, region: R2 };
    const lb2 = `arn:aws:elasticloadbalancing:${R2}:${A}:loadbalancer/app/my-alb/999`;
    const tg2 = `arn:aws:elasticloadbalancing:${R2}:${A}:targetgroup/tg1/999`;
    const db2 = `arn:aws:rds:${R2}:${A}:db:db1`;
    const sub2 = `arn:aws:ec2:${R2}:${A}:subnet/subnet-9`;
    const r = run({
      ...rows,
      subnet: [...rows.subnet!, { subnet_arn: sub2, subnet_id: 'subnet-9', ...b2 }],
      alb: [...rows.alb!, { arn: lb2, name: 'my-alb', availability_zones: [{ SubnetId: 'subnet-9' }], ...b2 }],
      tg: [...rows.tg!, { target_group_arn: tg2, target_group_name: 'tg1', target_type: 'instance', load_balancer_arns: [lb2], ...b2 }],
      rds: [...rows.rds!, { arn: db2, db_instance_identifier: 'db1', subnets: [{ SubnetIdentifier: 'subnet-9' }], ...b2 }],
    });
    expect(has(r.edges, lbArn, arn('subnet/subnet-1'), 'in_subnet')).toBe(true);
    expect(has(r.edges, lb2, sub2, 'in_subnet')).toBe(true);
    expect(has(r.edges, lbArn, tgArn, 'forwards_to')).toBe(true);
    expect(has(r.edges, lb2, tg2, 'forwards_to')).toBe(true);
    expect(has(r.edges, tgArn, arn('instance/i-1'), 'targets')).toBe(true);
    expect(has(r.edges, dbArn, arn('subnet/subnet-3'), 'in_subnet')).toBe(true);
    expect(has(r.edges, db2, sub2, 'in_subnet')).toBe(true);
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
