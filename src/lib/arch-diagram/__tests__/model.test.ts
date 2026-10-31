import { describe, it, expect } from 'vitest';
import { allResources, buildModel } from '../model';
import { bigRows, DEMO_VPC } from './fixtures';

const build = (over = {}) => buildModel(bigRows(), { vpc: DEMO_VPC, region: 'ap-northeast-2', ...over });
const subnet = (m: ReturnType<typeof build>, id: string) => m.azs.flatMap(a => [...a.public, ...a.private]).find(s => s.id === id)!;

describe('buildModel', () => {
  it('finds a VPC by id or name, and names a missing one', () => {
    expect(buildModel(bigRows(), { vpc: 'demo-vpc' }).vpc.id).toBe(DEMO_VPC);
    expect(() => buildModel(bigRows(), { vpc: 'nope' })).toThrow(expect.objectContaining({ name: 'VpcNotFound' }));
  });
  it('splits tiers by route table and hides empty subnets unless asked', () => {
    const m = build();
    expect(m.azs.map(a => a.name)).toEqual(['ap-northeast-2a', 'ap-northeast-2c']);
    expect(m.azs[0].public.map(s => s.name)).toEqual(['PublicA']);
    expect(m.azs[0].private.map(s => s.name)).toEqual(['AppA', 'DbA']);
    expect(m.hiddenEmpty).toBe(1);
    expect(subnet(m, 'subnet-empty')).toBeUndefined();
    const all = build({ includeEmpty: true });
    expect(all.hiddenEmpty).toBe(0);
    expect(subnet(all, 'subnet-empty').tier).toBe('private');
  });
  it('excludes subnets by id or name, and drops edges that lost an end', () => {
    const m = build({ excludeSubnets: ['subnet-app-a', 'demo/DbA'] });
    expect(subnet(m, 'subnet-app-a')).toBeUndefined();
    expect(subnet(m, 'subnet-db-a')).toBeUndefined();
    const ids = new Set(allResources(m).map(r => r.id));
    for (const e of m.edges) {
      if (!e.from.startsWith('subnet:')) expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
  it('folds an ASG into one icon per subnet and fades stopped instances', () => {
    const m = build();
    const app = subnet(m, 'subnet-app-a').resources;
    expect(app.filter(r => r.group)).toEqual([expect.objectContaining({ name: 'web-asg', count: 2, kind: 'ec2' })]);
    expect(subnet(m, 'subnet-app-c').resources.find(r => r.name === 'api-2')).toMatchObject({ faded: true });
    expect(allResources(m).some(r => r.name === 'gone')).toBe(false);
  });
  it('draws only the relations the data proves', () => {
    const m = build();
    const has = (from: string, to: string) => m.edges.some(e => e.from === from && e.to === to);
    expect(has('internet', 'igw-demo')).toBe(true);
    expect(has('igw-demo', 'arn:alb')).toBe(true);
    expect(has('igw-demo', 'arn:nlb')).toBe(false);
    expect(has('igw-demo', 'i-bastion0a')).toBe(true);
    expect(has('arn:alb', 'group:subnet-app-a|web-asg')).toBe(true);
    expect(has('arn:nlb', 'i-api00000a')).toBe(true);
    expect(has('subnet:subnet-app-a', 'nat-a')).toBe(true);
    expect(has('subnet:subnet-app-c', 'nat-c')).toBe(true);
    expect(has('subnet:subnet-pub-a', 'nat-a')).toBe(false);
    expect(has('nat-a', 'igw-demo')).toBe(false);
    expect(subnet(m, 'subnet-app-c').also.map(r => r.name)).toEqual(['demo-worker']);
    expect(has('cf:E1', 'arn:alb')).toBe(true);
    expect(has('internet', 'cf:E1')).toBe(true);
    expect(m.edges.filter(e => e.from === 'arn:alb').length).toBe(2);
  });
  it('places RDS by subnet group, with a linked standby, and ignores foreign MSK', () => {
    const m = build();
    expect(subnet(m, 'subnet-db-a').resources[0]).toMatchObject({ kind: 'rds', name: 'demo-mysql' });
    expect(subnet(m, 'subnet-db-c').resources.map(r => r.name)).toContain('demo-mysql standby');
    expect(m.edges).toContainEqual({ from: 'rds:demo-mysql', to: 'rds:demo-mysql:standby', dashed: true, label: 'Multi-AZ' });
    expect(allResources(m).some(r => r.kind === 'msk')).toBe(false);
  });
  it('separates front-door services from account-wide counts and can hide the latter', () => {
    const m = build();
    expect(m.edgeServices.map(r => r.id)).toEqual(['cf:E1']);
    expect(m.services.map(r => [r.kind, r.count])).toEqual([['route53', 1], ['cloudfront', 1], ['s3', 2]]);
    expect(build({ includeServices: false }).services).toEqual([]);
  });
  it('tolerates missing optional sources and numbers every resource once', () => {
    const r = bigRows();
    delete r.rds; delete r.lambda; delete r.cloudfront; delete r.s3;
    const m = buildModel(r, { vpc: DEMO_VPC, skipped: ['rds'] });
    expect(m.skipped).toEqual(['rds']);
    const ns = allResources(m).map(x => x.n);
    expect(ns).toEqual(ns.map((_, i) => i + 1));
  });
  it('reads public and private from the default route only', () => {
    const r = bigRows();
    r.routeTables[1].routes = [
      { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-a', State: 'active' },
      { DestinationIpv6CidrBlock: '::/0', GatewayId: 'igw-demo', State: 'active' },
      { DestinationCidrBlock: '52.95.0.0/16', GatewayId: 'igw-demo', State: 'active' },
    ];
    r.routeTables[2].routes = [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-demo', State: 'blackhole' }];
    const m = buildModel(r, { vpc: DEMO_VPC });
    expect(subnet(m, 'subnet-app-a').tier).toBe('private');
    expect(m.edges.some(e => e.from === 'subnet:subnet-app-a' && e.to === 'nat-a')).toBe(true);
    expect(subnet(m, 'subnet-app-c').tier).toBe('private');
    expect(m.edges.some(e => e.from === 'subnet:subnet-app-c')).toBe(false);
  });
  it('refuses a VPC name shared by two VPCs instead of merging them', () => {
    const r = bigRows();
    r.vpcSubnets.push({ vpc_id: 'vpc-other', vpc_name: 'demo-vpc', subnet_id: 'subnet-x', availability_zone: 'ap-northeast-2a' });
    expect(() => buildModel(r, { vpc: 'demo-vpc' })).toThrow(expect.objectContaining({ name: 'VpcAmbiguous' }));
  });
  it('places only what the data proves', () => {
    const r = bigRows();
    r.rds![0].subnets = [{ SubnetIdentifier: 'subnet-db-c' }];
    r.targetGroups[0].target_health_descriptions = [{ Target: { Id: '10.0.10.77' } }, { Target: { Id: 'i-web00000a' }, TargetHealth: { State: 'draining' } }];
    r.elasticache![0].availability_zone = 'ap-northeast-2z';
    const m = buildModel(r, { vpc: DEMO_VPC });
    expect(m.attachments.map(x => x.kind)).toEqual(expect.arrayContaining(['rds', 'elasticache']));
    expect(subnet(m, 'subnet-db-c')?.resources.some(x => x.kind === 'rds') ?? false).toBe(false);
    expect(m.edges.some(e => e.from === 'arn:alb' && e.to !== 'igw-demo')).toBe(false);
  });
  it('fades only stopped things and skips unusable NAT and TGW states', () => {
    const r = bigRows();
    r.ec2[1].instance_state = 'pending';
    r.ec2[1].asg_name = null;
    r.nat[0].state = 'failed';
    r.tgw = [{ resource_id: DEMO_VPC, resource_type: 'vpc', transit_gateway_id: 'tgw-1', state: 'deleted' }];
    r.rds![0].status = 'backing-up';
    const m = buildModel(r, { vpc: DEMO_VPC });
    const all = allResources(m);
    expect(all.find(x => x.id === 'i-web00000a')).toMatchObject({ faded: false, detail: 't3.medium · pending' });
    expect(all.some(x => x.id === 'nat-a' || x.kind === 'tgw')).toBe(false);
    expect(all.find(x => x.id === 'rds:demo-mysql')!.faded).toBe(false);
  });
  it('keeps account-wide counts to the VPC account, reads the VPC region, and dedupes subnets', () => {
    const r = bigRows();
    r.vpcSubnets = r.vpcSubnets.map(s => ({ ...s, region: 'us-east-1' }));
    r.vpcSubnets.push({ ...r.vpcSubnets[0] });
    r.s3 = [{ account_id: '111122223333', name: 'a' }, { account_id: '999999999999', name: 'b' }];
    const m = buildModel(r, { vpc: DEMO_VPC, region: 'ap-northeast-2', includeEmpty: true });
    expect(m.vpc.region).toBe('us-east-1');
    expect(m.services.find(x => x.kind === 's3')!.count).toBe(1);
    expect(m.azs.flatMap(a => [...a.public, ...a.private]).length).toBe(7);
  });
});
