import { describe, it, expect } from 'vitest';
import { buildNodes, buildIndex } from '../nodes';
import { EdgeSink } from '../sink';
import { networkEdges } from '../extract/network';
import type { Rows } from '../types';

const A = '111111111111';
const R = 'ap-northeast-2';
const b = { account_id: A, region: R };
const arn = (s: string) => `arn:aws:ec2:${R}:${A}:${s}`;

function run(rows: Rows) {
  const ix = buildIndex(buildNodes(rows));
  const sink = new EdgeSink();
  networkEdges(rows, ix, sink);
  return sink.result();
}
const has = (edges: { src: string; dst: string; type: string }[], src: string, dst: string, type: string) =>
  edges.some(e => e.src === src && e.dst === dst && e.type === type);

const base: Rows = {
  vpc: [{ arn: arn('vpc/vpc-1'), vpc_id: 'vpc-1', ...b }],
  subnet: [{ subnet_arn: arn('subnet/subnet-1'), subnet_id: 'subnet-1', vpc_id: 'vpc-1', ...b }],
  sg: [
    { arn: arn('security-group/sg-a'), group_id: 'sg-a', group_name: 'a', vpc_id: 'vpc-1', ...b },
    { arn: arn('security-group/sg-b'), group_id: 'sg-b', group_name: 'b', vpc_id: 'vpc-1', ...b },
  ],
  eni: [{ partition: 'aws', network_interface_id: 'eni-1', subnet_id: 'subnet-1', groups: [{ GroupId: 'sg-a' }], attached_instance_id: 'i-1', description: 'ELB app/my-alb/50dc6c495c0c9188', ...b }],
  instance: [{ arn: arn('instance/i-1'), instance_id: 'i-1', ...b }],
  alb: [{ arn: arn('loadbalancer/app/my-alb/50dc6c495c0c9188'), name: 'my-alb', ...b }],
  nat: [{ arn: arn('natgateway/nat-1'), nat_gateway_id: 'nat-1', subnet_id: 'subnet-1', nat_gateway_addresses: [{ NetworkInterfaceId: 'eni-1', AllocationId: 'eipalloc-1' }], ...b }],
  eip: [{ arn: arn('elastic-ip/eipalloc-1'), allocation_id: 'eipalloc-1', public_ip: '1.2.3.4', network_interface_id: 'eni-1', instance_id: 'i-1', ...b }],
};

describe('networkEdges', () => {
  const { edges, dropped } = run({
    ...base,
    sgRule: [
      { group_id: 'sg-a', is_egress: false, referenced_group_id: 'sg-b', ...b },
      { group_id: 'sg-b', is_egress: false, referenced_group_id: 'sg-a', ...b },
      { group_id: 'sg-a', is_egress: true, referenced_group_id: 'sg-b', ...b },
      { group_id: 'sg-a', is_egress: false, referenced_group_id: null, ...b },
    ],
  });
  const e = (s: string, d: string, t: string) => has(edges, s, d, t);

  it('subnet/sg -> vpc', () => {
    expect(e(arn('subnet/subnet-1'), arn('vpc/vpc-1'), 'in_vpc')).toBe(true);
    expect(e(arn('security-group/sg-a'), arn('vpc/vpc-1'), 'in_vpc')).toBe(true);
  });
  it('sg cycle yields both allows_from, egress ignored', () => {
    expect(e(arn('security-group/sg-a'), arn('security-group/sg-b'), 'allows_from')).toBe(true);
    expect(e(arn('security-group/sg-b'), arn('security-group/sg-a'), 'allows_from')).toBe(true);
    expect(edges.filter(x => x.type === 'allows_from')).toHaveLength(2);
  });
  it('eni relations', () => {
    const eni = arn('network-interface/eni-1');
    expect(e(eni, arn('subnet/subnet-1'), 'in_subnet')).toBe(true);
    expect(e(eni, arn('security-group/sg-a'), 'uses_sg')).toBe(true);
    expect(e(arn('instance/i-1'), eni, 'uses_eni')).toBe(true);
  });
  it('ELB description links lb -> eni', () => {
    expect(e(arn('loadbalancer/app/my-alb/50dc6c495c0c9188'), arn('network-interface/eni-1'), 'uses_eni')).toBe(true);
  });
  it('eip with eni and instance links the eni only', () => {
    expect(e(arn('network-interface/eni-1'), arn('elastic-ip/eipalloc-1'), 'uses_eip')).toBe(true);
    expect(e(arn('instance/i-1'), arn('elastic-ip/eipalloc-1'), 'uses_eip')).toBe(false);
  });
  it('nat relations', () => {
    const nat = arn('natgateway/nat-1');
    expect(e(nat, arn('subnet/subnet-1'), 'in_subnet')).toBe(true);
    expect(e(nat, arn('network-interface/eni-1'), 'uses_eni')).toBe(true);
    expect(e(nat, arn('elastic-ip/eipalloc-1'), 'uses_eip')).toBe(true);
  });
  it('nothing dropped for a consistent fixture', () => expect(dropped).toBe(0));

  it('eip with only instance_id links the instance; with neither adds nothing', () => {
    const r = run({ ...base, nat: [], eip: [
      { arn: arn('elastic-ip/e2'), allocation_id: 'e2', instance_id: 'i-1', ...b },
      { arn: arn('elastic-ip/e3'), allocation_id: 'e3', ...b },
    ] });
    expect(has(r.edges, arn('instance/i-1'), arn('elastic-ip/e2'), 'uses_eip')).toBe(true);
    expect(r.edges.filter(x => x.dst === arn('elastic-ip/e3'))).toHaveLength(0);
    expect(r.dropped).toBe(0);
  });
  it('groups: null does not throw or add edges', () => {
    const r = run({ ...base, eni: [{ partition: 'aws', network_interface_id: 'eni-1', groups: null, ...b }] });
    expect(r.edges.filter(x => x.type === 'uses_sg')).toHaveLength(0);
  });
  it('groups as JSON string still works', () => {
    const r = run({ ...base, eni: [{ partition: 'aws', network_interface_id: 'eni-1', groups: '[{"GroupId":"sg-a"}]', ...b }] });
    expect(has(r.edges, arn('network-interface/eni-1'), arn('security-group/sg-a'), 'uses_sg')).toBe(true);
  });
  it('Lambda ENI description links the lambda of the same account and region', () => {
    const R2 = 'us-east-1';
    const fn = `arn:aws:lambda:${R}:${A}:function:my-fn`;
    const fnOther = `arn:aws:lambda:${R2}:${A}:function:my-fn`;
    const desc = 'AWS Lambda VPC ENI-my-fn-1a2b3c4d-1111-2222-3333-444455556666';
    const r = run({
      ...base,
      lambda: [{ arn: fn, name: 'my-fn', ...b }, { arn: fnOther, name: 'my-fn', account_id: A, region: R2 }],
      eni: [
        ...base.eni!,
        { partition: 'aws', network_interface_id: 'eni-l1', description: desc, ...b },
        // No lambda of that name: no edge and not dropped. / 이름이 맞는 람다가 없으면 간선도 dropped도 없다.
        { partition: 'aws', network_interface_id: 'eni-l2', description: 'AWS Lambda VPC ENI-gone-1a2b3c4d-1111-2222-3333-444455556666', ...b },
        // Not a Lambda description. / 람다 설명이 아니면 무시.
        { partition: 'aws', network_interface_id: 'eni-l3', description: 'Lambda VPC ENI-my-fn', ...b },
        // Hyperplane ENIs seen in real data have no uuid suffix. / 실데이터의 Hyperplane ENI는 uuid가 없다.
        { partition: 'aws', network_interface_id: 'eni-l4', description: 'AWS Lambda VPC ENI-my-fn', ...b },
      ],
    });
    expect(has(r.edges, fn, arn('network-interface/eni-l1'), 'uses_eni')).toBe(true);
    expect(has(r.edges, fn, arn('network-interface/eni-l4'), 'uses_eni')).toBe(true);
    expect(r.edges.filter(x => x.src === fnOther)).toHaveLength(0);
    expect(r.edges.filter(x => x.dst === arn('network-interface/eni-l2') || x.dst === arn('network-interface/eni-l3'))).toHaveLength(0);
    expect(r.dropped).toBe(0);
  });
  it('unknown vpc_id counts as dropped', () => {
    const r = run({ subnet: [{ subnet_arn: arn('subnet/s9'), subnet_id: 's9', vpc_id: 'vpc-nope', ...b }] });
    expect(r.edges).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });
});
