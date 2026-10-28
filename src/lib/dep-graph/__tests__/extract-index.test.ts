import { describe, it, expect } from 'vitest';
import { extractGraph } from '../extract';
import type { EdgeType, NodeType, Rows } from '../types';

const A = '111111111111';
const R = 'ap-northeast-2';
const b = { account_id: A, region: R };
const arn = (s: string) => `arn:aws:ec2:${R}:${A}:${s}`;
const lbArn = `arn:aws:elasticloadbalancing:${R}:${A}:loadbalancer/app/my-alb/abc123`;
const roleArn = `arn:aws:iam::${A}:role/r1`;
const profArn = `arn:aws:iam::${A}:instance-profile/p1`;
const fnArn = `arn:aws:lambda:${R}:${A}:function:fn`;

const rows: Rows = {
  vpc: [{ arn: arn('vpc/vpc-1'), vpc_id: 'vpc-1', ...b }],
  subnet: [{ subnet_arn: arn('subnet/subnet-1'), subnet_id: 'subnet-1', vpc_id: 'vpc-1', ...b }],
  eni: [{ partition: 'aws', network_interface_id: 'eni-1', subnet_id: 'subnet-1', attached_instance_id: 'i-1', groups: [{ GroupId: 'sg-1' }], ...b }],
  instance: [{ arn: arn('instance/i-1'), instance_id: 'i-1', subnet_id: 'subnet-1', iam_instance_profile_arn: profArn, ...b }],
  sg: [{ arn: arn('security-group/sg-1'), group_id: 'sg-1', vpc_id: 'vpc-1', ...b }, { arn: arn('security-group/sg-2'), group_id: 'sg-2', vpc_id: 'vpc-1', ...b }],
  sgRule: [{ group_id: 'sg-1', is_egress: false, referenced_group_id: 'sg-2', ...b }],
  alb: [{ arn: lbArn, name: 'my-alb', dns_name: 'my-alb.elb.amazonaws.com', availability_zones: [{ SubnetId: 'subnet-1' }], ...b }],
  tg: [{ target_group_arn: `arn:aws:elasticloadbalancing:${R}:${A}:targetgroup/tg1/d`, target_group_name: 'tg1', target_type: 'instance', load_balancer_arns: [lbArn], target_health_descriptions: [{ Target: { Id: 'i-1' } }], ...b }],
  rds: [{ arn: `arn:aws:rds:${R}:${A}:db:db1`, db_instance_identifier: 'db1', subnets: [{ SubnetIdentifier: 'subnet-1' }], ...b }],
  lambda: [{ arn: fnArn, name: 'fn', role: roleArn, ...b }],
  role: [{ arn: roleArn, name: 'r1', instance_profile_arns: [profArn], ...b }],
  rolePolicy: [{ arn: roleArn, inline_policies_std: [{ PolicyDocument: { Statement: { Effect: 'Allow', Resource: 'arn:aws:s3:::b/*' } } }], ...b }],
  nat: [{ arn: arn('natgateway/nat-1'), nat_gateway_id: 'nat-1', subnet_id: 'subnet-1', nat_gateway_addresses: [{ NetworkInterfaceId: 'eni-1', AllocationId: 'eipalloc-1' }], ...b }],
  eip: [{ arn: arn('elastic-ip/eipalloc-1'), allocation_id: 'eipalloc-1', network_interface_id: 'eni-1', ...b }],
  ebs: [{ arn: arn('volume/vol-1'), volume_id: 'vol-1', attachments: [{ InstanceId: 'i-1' }], ...b }],
  s3: [{ arn: 'arn:aws:s3:::b', name: 'b', event_notification_configuration: { LambdaFunctionConfigurations: [{ LambdaFunctionArn: fnArn }] }, ...b }],
  cloudfront: [{ arn: `arn:aws:cloudfront::${A}:distribution/E1`, id: 'E1', origins: [{ DomainName: 'b.s3.amazonaws.com' }], ...b }],
};

const NODE_TYPES: NodeType[] = ['vpc','subnet','eni','instance','sg','lb','tg','rds','lambda','role','nat','eip','ebs','s3','cloudfront'];
const EDGE_TYPES: EdgeType[] = ['in_vpc','in_subnet','uses_sg','allows_from','uses_role','uses_volume','uses_eni','uses_eip','forwards_to','targets','can_access','notifies','origin'];

describe('extractGraph', () => {
  const g = extractGraph(rows);
  it('has nodes of all 15 types', () => {
    const types = new Set(g.nodes.map(n => n.type));
    for (const t of NODE_TYPES) expect(types.has(t), t).toBe(true);
  });
  it('has edges of every EdgeType', () => {
    const types = new Set(g.edges.map(e => e.type));
    for (const t of EDGE_TYPES) expect(types.has(t), t).toBe(true);
  });
  it('empty rows give empty graph', () => {
    expect(extractGraph({})).toEqual({ nodes: [], edges: [], dropped: 0 });
  });
});
