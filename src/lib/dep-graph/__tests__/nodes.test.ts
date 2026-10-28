import { describe, it, expect } from 'vitest';
import { buildNodes, buildIndex, eniArn, asArray, str } from '../nodes';
import { EdgeSink } from '../sink';

const A = '111111111111';
const R = 'ap-northeast-2';
const base = { account_id: A, region: R };

describe('buildNodes', () => {
  it('instance with Name tag', () => {
    const n = buildNodes({ instance: [{ arn: `arn:aws:ec2:${R}:${A}:instance/i-1`, instance_id: 'i-1', instance_state: 'running', instance_type: 't3.micro', private_ip_address: '10.0.0.5', tags: { Name: 'web' }, ...base }] });
    expect(n).toEqual([{
      arn: `arn:aws:ec2:${R}:${A}:instance/i-1`, type: 'instance', id: 'i-1', name: 'web', accountId: A, region: R,
      attrs: { state: 'running', instanceType: 't3.micro', privateIp: '10.0.0.5', tags: { Name: 'web' } },
    }]);
  });
  it('vpc', () => {
    const [n] = buildNodes({ vpc: [{ arn: 'arn:v', vpc_id: 'vpc-1', cidr_block: '10.0.0.0/16', is_default: true, ...base }] });
    expect(n).toMatchObject({ type: 'vpc', id: 'vpc-1', name: 'vpc-1', attrs: { cidr: '10.0.0.0/16', isDefault: true } });
  });
  it('subnet', () => {
    const [n] = buildNodes({ subnet: [{ subnet_arn: 'arn:s', subnet_id: 'subnet-1', cidr_block: '10.0.1.0/24', availability_zone: 'ap-northeast-2a', ...base }] });
    expect(n).toMatchObject({ arn: 'arn:s', type: 'subnet', id: 'subnet-1', attrs: { cidr: '10.0.1.0/24', az: 'ap-northeast-2a' } });
  });
  it('eni arn and description fallback', () => {
    expect(eniArn('aws', R, A, 'eni-1')).toBe(`arn:aws:ec2:${R}:${A}:network-interface/eni-1`);
    const [n] = buildNodes({ eni: [{ partition: 'aws', network_interface_id: 'eni-1', description: 'ELB app/x/1', interface_type: 'interface', status: 'in-use', private_ip_address: '10.0.0.9', requester_managed: true, ...base }] });
    expect(n).toMatchObject({ arn: `arn:aws:ec2:${R}:${A}:network-interface/eni-1`, type: 'eni', name: 'ELB app/x/1', attrs: { interfaceType: 'interface', status: 'in-use', privateIp: '10.0.0.9', requesterManaged: true } });
  });
  it('sg', () => {
    const [n] = buildNodes({ sg: [{ arn: 'arn:sg', group_id: 'sg-1', group_name: 'web-sg', vpc_id: 'vpc-1', ...base }] });
    expect(n).toMatchObject({ type: 'sg', id: 'sg-1', name: 'web-sg', attrs: { vpcId: 'vpc-1' } });
  });
  it('alb, nlb, clb', () => {
    const mk = (n: string) => [{ arn: `arn:${n}`, name: n, scheme: 'internal', dns_name: `${n}.x`, ...base }];
    const nodes = buildNodes({ alb: mk('a'), nlb: mk('n'), clb: mk('c') });
    expect(nodes.map(x => x.attrs.lbType)).toEqual(['application', 'network', 'classic']);
    expect(nodes[0]).toMatchObject({ type: 'lb', id: 'a', attrs: { scheme: 'internal', dnsName: 'a.x' } });
  });
  it('tg', () => {
    const [n] = buildNodes({ tg: [{ target_group_arn: 'arn:tg', target_group_name: 'tg1', target_type: 'instance', port: 80, protocol: 'HTTP', ...base }] });
    expect(n).toMatchObject({ arn: 'arn:tg', type: 'tg', id: 'tg1', attrs: { targetType: 'instance', port: 80, protocol: 'HTTP' } });
  });
  it('rds', () => {
    const [n] = buildNodes({ rds: [{ arn: 'arn:rds', db_instance_identifier: 'db1', engine: 'mysql', class: 'db.t3.micro', status: 'available', ...base }] });
    expect(n).toMatchObject({ type: 'rds', id: 'db1', attrs: { engine: 'mysql', class: 'db.t3.micro', status: 'available' } });
  });
  it('lambda never gets tags', () => {
    const [n] = buildNodes({ lambda: [{ arn: 'arn:fn', name: 'fn', runtime: 'nodejs20.x', state: 'Active', tags: { a: 'b' }, ...base }] });
    expect(n.attrs).toEqual({ runtime: 'nodejs20.x', state: 'Active' });
    expect(n.attrs.tags).toBeUndefined();
  });
  it('role', () => {
    const [n] = buildNodes({ role: [{ arn: 'arn:role', name: 'r', path: '/', ...base }] });
    expect(n).toMatchObject({ type: 'role', id: 'r', attrs: { path: '/' } });
  });
  it('nat', () => {
    const [n] = buildNodes({ nat: [{ arn: 'arn:nat', nat_gateway_id: 'nat-1', state: 'available', ...base }] });
    expect(n).toMatchObject({ type: 'nat', id: 'nat-1', attrs: { state: 'available' } });
  });
  it('eip name falls back to public ip', () => {
    const [n] = buildNodes({ eip: [{ arn: 'arn:eip', allocation_id: 'eipalloc-1', public_ip: '1.2.3.4', ...base }] });
    expect(n).toMatchObject({ type: 'eip', id: 'eipalloc-1', name: '1.2.3.4', attrs: { publicIp: '1.2.3.4' } });
  });
  it('ebs', () => {
    const [n] = buildNodes({ ebs: [{ arn: 'arn:ebs', volume_id: 'vol-1', size: 8, volume_type: 'gp3', state: 'in-use', ...base }] });
    expect(n).toMatchObject({ type: 'ebs', id: 'vol-1', attrs: { size: 8, volumeType: 'gp3', state: 'in-use' } });
  });
  it('s3', () => {
    const [n] = buildNodes({ s3: [{ arn: 'arn:aws:s3:::b', name: 'b', ...base }] });
    expect(n).toMatchObject({ type: 's3', id: 'b', name: 'b', accountId: A });
  });
  it('cloudfront name uses first alias else domain', () => {
    const rows = [
      { arn: 'arn:cf1', id: 'E1', domain_name: 'd1.cloudfront.net', aliases: ['www.x.com'], enabled: true, ...base },
      { arn: 'arn:cf2', id: 'E2', domain_name: 'd2.cloudfront.net', aliases: null, enabled: false, ...base },
    ];
    const n = buildNodes({ cloudfront: rows });
    expect(n[0]).toMatchObject({ name: 'www.x.com', attrs: { domainName: 'd1.cloudfront.net', enabled: true } });
    expect(n[1].name).toBe('d2.cloudfront.net');
  });
  it('sgRule, rolePolicy and policy produce no nodes', () => {
    expect(buildNodes({ sgRule: [{ group_id: 'sg-1', ...base }], rolePolicy: [{ arn: 'arn:role', ...base }], policy: [{ arn: 'arn:p', ...base }] })).toEqual([]);
  });
  it('skips rows without id or arn', () => {
    expect(buildNodes({ instance: [{ arn: 'arn:x', ...base }, { instance_id: 'i-2', ...base }] })).toEqual([]);
  });
  it('caps tags at 50 keys and truncates values', () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 60; i++) tags[`k${i}`] = 'x'.repeat(300);
    const [n] = buildNodes({ vpc: [{ arn: 'arn:v', vpc_id: 'vpc-1', tags, ...base }] });
    const t = n.attrs.tags as Record<string, string>;
    expect(Object.keys(t)).toHaveLength(50);
    expect(t.k0).toHaveLength(256);
  });
});

describe('buildIndex', () => {
  it('looks up by arn and by account+id', () => {
    const nodes = buildNodes({ instance: [{ arn: 'arn:i', instance_id: 'i-1', ...base }] });
    const idx = buildIndex(nodes);
    expect(idx.byId(A, 'i-1')).toBe(nodes[0]);
    expect(idx.byArn('arn:i')).toBe(nodes[0]);
    expect(idx.byId(A, 'nope')).toBeUndefined();
    expect(idx.nodes).toBe(nodes);
  });
});

describe('buildIndex ambiguity', () => {
  it('needs a type when ids collide', () => {
    const nodes = buildNodes({
      alb: [{ arn: 'arn:lb', name: 'moyeota-api', ...base }],
      lambda: [{ arn: 'arn:fn', name: 'moyeota-api', ...base }],
    });
    const idx = buildIndex(nodes);
    expect(idx.byId(A, 'moyeota-api')).toBeUndefined();
    expect(idx.byId(A, 'moyeota-api', 'lambda')?.arn).toBe('arn:fn');
    expect(idx.byId(A, 'moyeota-api', 'lb')?.arn).toBe('arn:lb');
    expect(idx.byId(A, 'moyeota-api', 'vpc')).toBeUndefined();
  });
});

describe('helpers', () => {
  it('asArray', () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray({ a: 1 })).toEqual([]);
    expect(asArray([1])).toEqual([1]);
    expect(asArray('[1,2]')).toEqual([1, 2]);
    expect(asArray('not json')).toEqual([]);
    expect(asArray('{"a":1}')).toEqual([]);
  });
  it('str', () => {
    expect(str('a')).toBe('a');
    expect(str('')).toBeUndefined();
    expect(str(5)).toBeUndefined();
  });
});

describe('EdgeSink', () => {
  it('counts an undefined end as dropped', () => {
    const s = new EdgeSink();
    s.add(undefined, 'b', 'in_vpc');
    s.add('a', undefined, 'in_vpc');
    expect(s.result()).toEqual({ edges: [], dropped: 2 });
  });
  it('keeps duplicates once', () => {
    const s = new EdgeSink();
    s.add('a', 'b', 'in_vpc'); s.add('a', 'b', 'in_vpc'); s.add('a', 'b', 'uses_sg');
    expect(s.result().edges).toHaveLength(2);
  });
  it('ignores self loops without counting', () => {
    const s = new EdgeSink();
    s.add('a', 'a', 'allows_from');
    expect(s.result()).toEqual({ edges: [], dropped: 0 });
  });
});
