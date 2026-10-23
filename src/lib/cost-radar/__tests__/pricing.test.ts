import { describe, it, expect } from 'vitest';
import table from '../prices.ap-northeast-2.json';
import { PRICE_AS_OF } from '../price-as-of';
import {
  HOURS_PER_MONTH, priceAsOf, priceEc2, priceEbs, priceSnapshot, pricePublicIp,
  priceNat, priceLb, priceVpcEndpoint, priceRds, priceElastiCache,
} from '../pricing';

const R = 'ap-northeast-2';
const two = (n: number) => Math.round(n * 100) / 100;

describe('priceEc2', () => {
  it('ec2LinuxSharedIsHourlyTimes730', () => {
    const r = priceEc2({ instanceType: 't4g.xlarge', platformDetails: 'Linux/UNIX', tenancy: 'default', region: R });
    expect(r.monthly).not.toBeNull();
    expect(two(r.monthly as number)).toBe(two((table.ec2 as Record<string, number>)['t4g.xlarge'] * 730));
  });
  it('unknownInstanceTypeIsUnpriced', () => {
    expect(priceEc2({ instanceType: 'zz9.huge', platformDetails: 'Linux/UNIX', tenancy: 'default', region: R }))
      .toEqual({ monthly: null, reason: 'unknown-type' });
  });
  it('windowsIsUnpriced', () => {
    expect(priceEc2({ instanceType: 't4g.xlarge', platformDetails: 'Windows', tenancy: 'default', region: R }))
      .toEqual({ monthly: null, reason: 'non-linux' });
  });
  it('dedicatedIsUnpriced', () => {
    expect(priceEc2({ instanceType: 't4g.xlarge', platformDetails: 'Linux/UNIX', tenancy: 'dedicated', region: R }))
      .toEqual({ monthly: null, reason: 'dedicated' });
  });
});

describe('otherRegionIsUnpriced', () => {
  const US = 'us-east-1';
  const other = { monthly: null, reason: 'other-region' };
  it('every price function rejects another region', () => {
    expect(priceEc2({ instanceType: 't4g.xlarge', platformDetails: 'Linux/UNIX', tenancy: 'default', region: US })).toEqual(other);
    expect(priceEbs({ volumeType: 'gp3', sizeGb: 10, region: US })).toEqual(other);
    expect(priceSnapshot({ sizeGb: 10, region: US })).toEqual(other);
    expect(pricePublicIp({ region: US })).toEqual(other);
    expect(priceNat({ region: US })).toEqual(other);
    expect(priceLb({ type: 'application', region: US })).toEqual(other);
    expect(priceVpcEndpoint({ azCount: 2, region: US })).toEqual(other);
    expect(priceRds({ engine: 'postgres', instanceClass: 'db.t4g.medium', multiAz: false, storageType: 'gp3', allocatedGb: 20, region: US })).toEqual(other);
    expect(priceElastiCache({ nodeType: 'cache.t4g.small', nodes: 1, region: US })).toEqual(other);
  });
});

describe('priceEbs', () => {
  it('gp3ExtraIopsAndThroughputAreAdded', () => {
    const r = priceEbs({ volumeType: 'gp3', sizeGb: 100, iops: 4000, throughput: 250, region: R });
    const e = table.ebs;
    expect(r.monthly).toBeCloseTo(100 * e.gbMonth.gp3 + 1000 * e.gp3IopsMonth + 125 * e.gp3ThroughputMbpsMonth, 6);
  });
  it('gp3 at baseline adds nothing', () => {
    const r = priceEbs({ volumeType: 'gp3', sizeGb: 100, iops: 3000, throughput: 125, region: R });
    expect(r.monthly).toBeCloseTo(100 * table.ebs.gbMonth.gp3, 6);
  });
  it('io2 adds provisioned IOPS', () => {
    const r = priceEbs({ volumeType: 'io2', sizeGb: 100, iops: 5000, region: R });
    expect(r.monthly).toBeCloseTo(100 * table.ebs.gbMonth.io2 + 5000 * table.ebs.ioIopsMonth.io2, 6);
  });
  it('gp2 is size times rate; unknown type is unpriced', () => {
    expect(priceEbs({ volumeType: 'gp2', sizeGb: 50, region: R }).monthly).toBeCloseTo(50 * table.ebs.gbMonth.gp2, 6);
    expect(priceEbs({ volumeType: 'zzz', sizeGb: 50, region: R })).toEqual({ monthly: null, reason: 'unknown-type' });
  });
});

describe('fixed-price resources', () => {
  it('snapshotUsesVolumeSize', () => {
    expect(priceSnapshot({ sizeGb: 200, region: R }).monthly).toBeCloseTo(200 * table.snapshotGbMonth, 6);
  });
  it('public ip, nat, lb are hourly times 730', () => {
    expect(pricePublicIp({ region: R }).monthly).toBeCloseTo(table.publicIpv4Hour * 730, 6);
    expect(priceNat({ region: R }).monthly).toBeCloseTo(table.natHour * 730, 6);
    expect(priceLb({ type: 'application', region: R }).monthly).toBeCloseTo(table.lbHour.application * 730, 6);
    expect(priceLb({ type: 'network', region: R }).monthly).toBeCloseTo(table.lbHour.network * 730, 6);
  });
  it('vpcEndpointMultipliesAz', () => {
    expect(priceVpcEndpoint({ azCount: 2, region: R }).monthly).toBeCloseTo(2 * table.vpcEndpointHour * 730, 6);
  });
});

describe('priceRds', () => {
  const base = { engine: 'postgres', instanceClass: 'db.t4g.medium', storageType: 'gp3', allocatedGb: 0, region: R };
  it('rdsMultiAzDoubles', () => {
    const s = priceRds({ ...base, multiAz: false }).monthly as number;
    const m = priceRds({ ...base, multiAz: true }).monthly as number;
    expect(s).toBeCloseTo(table.rds.instances.postgresql['db.t4g.medium'][0] * 730, 6);
    expect(m / s).toBeCloseTo(2, 1);
  });
  it('adds storage per GB-month (multi-AZ storage rate when multi-AZ)', () => {
    const s = priceRds({ ...base, multiAz: false, allocatedGb: 100 }).monthly as number;
    const i = table.rds.instances.postgresql['db.t4g.medium'][0] * 730;
    expect(s).toBeCloseTo(i + 100 * table.rds.storageGbMonth.gp3[0], 6);
  });
  it('maps steampipe engine names; aurora has no separate storage', () => {
    expect(priceRds({ ...base, engine: 'aurora-postgresql', instanceClass: 'db.r6g.large', multiAz: false, storageType: 'aurora', allocatedGb: 1 }).monthly)
      .toBeCloseTo(0.313 * 730, 4);
    expect(priceRds({ ...base, engine: 'mysql', multiAz: false }).monthly).not.toBeNull();
    expect(priceRds({ ...base, engine: 'mariadb', multiAz: false }).monthly).not.toBeNull();
  });
  it('stopped instance pays storage only (aurora stopped = 0)', () => {
    expect(priceRds({ ...base, multiAz: false, allocatedGb: 100, stopped: true }).monthly).toBeCloseTo(100 * table.rds.storageGbMonth.gp3[0], 6);
    expect(priceRds({ ...base, multiAz: true, allocatedGb: 100, stopped: true }).monthly).toBeCloseTo(100 * table.rds.storageGbMonth.gp3[1], 6);
    expect(priceRds({ ...base, engine: 'aurora-postgresql', instanceClass: 'db.r6g.large', multiAz: false, storageType: 'aurora', allocatedGb: 1, stopped: true }).monthly).toBe(0);
  });
  it('unknown engine or class is unpriced', () => {
    expect(priceRds({ ...base, engine: 'oracle-ee', multiAz: false })).toEqual({ monthly: null, reason: 'unknown-type' });
    expect(priceRds({ ...base, instanceClass: 'db.zz9.huge', multiAz: false })).toEqual({ monthly: null, reason: 'unknown-type' });
  });
});

describe('priceElastiCache', () => {
  it('multiplies nodes', () => {
    const h = (table.elasticache as Record<string, number>)['cache.t4g.small'];
    expect(priceElastiCache({ nodeType: 'cache.t4g.small', nodes: 3, region: R }).monthly).toBeCloseTo(3 * h * 730, 6);
    expect(priceElastiCache({ nodeType: 'cache.zz9.huge', nodes: 1, region: R })).toEqual({ monthly: null, reason: 'unknown-type' });
  });
});

describe('meta', () => {
  it('exposes constants', () => {
    expect(HOURS_PER_MONTH).toBe(730);
    expect(priceAsOf()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('the client-side PRICE_AS_OF constant matches the price table', () => {
    expect(PRICE_AS_OF).toBe(table.asOf);
    expect(priceAsOf()).toBe(PRICE_AS_OF);
  });
});
