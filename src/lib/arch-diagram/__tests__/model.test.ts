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
});
