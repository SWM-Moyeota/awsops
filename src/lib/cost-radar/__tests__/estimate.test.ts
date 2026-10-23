import { describe, it, expect } from 'vitest';
import { buildEstimate } from '../estimate';
import type { RawInventory } from '../types';

const R = 'ap-northeast-2';
const empty = (accountId = '111111111111'): RawInventory => ({
  accountId, instances: [], volumes: [], snapshots: [], eips: [], nats: [], albs: [], nlbs: [],
  endpoints: [], rds: [], elasticache: [], targetGroups: [], errors: {},
});
const ec2 = (id: string, state: string, extra = {}) => ({
  instance_id: id, instance_type: 't4g.xlarge', instance_state: state, platform_details: 'Linux/UNIX',
  placement_tenancy: 'default', tags: { Name: `web-${id}` }, account_id: '111111111111', region: R, ...extra,
});

describe('buildEstimate', () => {
  it('runningEc2AndNatAndAlbAreSummedPerCategory', () => {
    const inv = empty();
    inv.instances = [ec2('i-1', 'running'), ec2('i-2', 'running')];
    inv.nats = [{ nat_gateway_id: 'nat-1', state: 'available', tags: null, account_id: '111111111111', region: R }];
    inv.albs = [{ arn: 'arn:alb', name: 'my-alb', state_code: 'active', tags: {}, account_id: '111111111111', region: R }];
    const e = buildEstimate([inv], '111111111111');
    expect(e.categories.map(c => c.id).sort()).toEqual(['ec2', 'loadbalancer', 'nat']);
    const ec2Cat = e.categories.find(c => c.id === 'ec2')!;
    expect(ec2Cat.count).toBe(2);
    const sum = e.categories.reduce((s, c) => s + c.monthly, 0);
    expect(e.monthly).toBeCloseTo(sum, 6);
    expect(e.hourly).toBeCloseTo(e.monthly / 730, 6);
    expect(e.categories[0].monthly).toBeGreaterThanOrEqual(e.categories[1].monthly);
    expect(e.resources.find(r => r.id === 'i-1')!.name).toBe('web-i-1');
    expect(e.resources.find(r => r.id === 'nat-1')!.name).toBe('nat-1');
  });

  it('stoppedEc2CostsZeroButItsVolumesCount', () => {
    const inv = empty();
    inv.instances = [ec2('i-1', 'stopped')];
    inv.volumes = [{ volume_id: 'vol-1', volume_type: 'gp3', size: 100, iops: 3000, throughput: 125, state: 'in-use', tags: {}, account_id: '111111111111', region: R }];
    const e = buildEstimate([inv], '111111111111');
    expect(e.categories.find(c => c.id === 'ec2')).toBeUndefined();
    expect(e.categories.find(c => c.id === 'storage')!.monthly).toBeGreaterThan(0);
  });

  it('emptyAccountHasZeroTotalsAndNoNaN', () => {
    const e = buildEstimate([empty()], '111111111111');
    expect(e.monthly).toBe(0);
    expect(e.hourly).toBe(0);
    expect(e.categories).toEqual([]);
  });

  it('stringAndNullNumericsNeverProduceNaN', () => {
    const inv = empty();
    inv.volumes = [
      { volume_id: 'v1', volume_type: 'gp3', size: '50', iops: '4000', throughput: null, state: 'available', tags: null, account_id: '111111111111', region: R },
      { volume_id: 'v2', volume_type: 'gp3', size: null, iops: undefined, throughput: 'abc', state: 'available', tags: null, account_id: '111111111111', region: R },
    ];
    inv.rds = [{ db_instance_identifier: 'db', class: 'db.t3.medium', engine: 'postgres', multi_az: false, allocated_storage: '20', storage_type: 'gp2', iops: null, tags: null, account_id: '111111111111', region: R }];
    inv.elasticache = [{ cache_cluster_id: 'c', cache_node_type: 'cache.t3.micro', num_cache_nodes: null, engine: 'redis', tags: null, account_id: '111111111111', region: R }];
    const e = buildEstimate([inv], '111111111111');
    expect(Number.isFinite(e.monthly)).toBe(true);
    for (const r of [...e.resources, ...e.unpriced]) expect(r.monthly === null || Number.isFinite(r.monthly)).toBe(true);
    for (const c of e.categories) { expect(Number.isFinite(c.monthly)).toBe(true); expect(Number.isFinite(c.percent)).toBe(true); }
    expect(e.resources.find(r => r.id === 'v2')!.monthly).toBe(0);
  });

  it('tableErrorYieldsPartialEstimateWithWarning', () => {
    const inv = empty();
    inv.instances = [ec2('i-1', 'running')];
    inv.errors = { elasticache: 'AccessDenied' };
    const e = buildEstimate([inv], '111111111111');
    expect(e.monthly).toBeGreaterThan(0);
    expect(e.warnings).toEqual([expect.objectContaining({ category: 'elasticache' })]);
  });

  it('allScopeMergesAccountsAndKeepsAccountIds', () => {
    const a = empty('111111111111'); a.instances = [ec2('i-1', 'running', { account_id: '111111111111' })];
    const b = empty('222222222222'); b.instances = [ec2('i-2', 'running', { account_id: '222222222222' })];
    const e = buildEstimate([a, b], '__all__');
    expect(e.accountId).toBe('__all__');
    expect(e.resources.map(r => r.accountId).sort()).toEqual(['111111111111', '222222222222']);
    expect(e.categories[0].percent).toBe(100);
  });

  it('unpricedResourcesAreListedNotSummed', () => {
    const inv = empty();
    inv.instances = [ec2('i-win', 'running', { platform_details: 'Windows' })];
    const e = buildEstimate([inv], '111111111111');
    expect(e.monthly).toBe(0);
    expect(e.unpriced).toHaveLength(1);
    expect(e.unpriced[0].unpricedReason).toBe('non-linux');
    expect(e.resources).toHaveLength(0);
  });
});
