import { describe, it, expect } from 'vitest';
import { recommend, summarizeSavings, parseStateTransitionTime } from '../recommend';
import { priceEc2, priceEbs } from '../pricing';
import type { RawInventory, Recommendation, Row } from '../types';

const R = 'ap-northeast-2';
const A = '111111111111';
const NOW = new Date('2026-10-24T03:00:00Z');
const two = (n: number) => Math.round(n * 100) / 100;

function inv(p: Partial<RawInventory> = {}): RawInventory {
  return {
    accountId: A, instances: [], volumes: [], snapshots: [], eips: [], nats: [], albs: [], nlbs: [],
    endpoints: [], rds: [], elasticache: [], targetGroups: [], errors: {}, ...p,
  };
}
const by = (recs: Recommendation[], rule: string) => recs.filter(r => r.rule === rule);

const instance = (o: Row = {}): Row => ({
  instance_id: 'i-1', instance_type: 't4g.xlarge', instance_state: 'running',
  state_transition_time: 'User initiated (2026-10-01 12:00:00 GMT)', platform_details: 'Linux/UNIX',
  placement_tenancy: 'default', tags: null, account_id: A, region: R, ...o,
});
const volume = (o: Row = {}): Row => ({
  volume_id: 'vol-1', volume_type: 'gp3', size: '100', iops: 3000, throughput: 125, state: 'in-use',
  attachments: [], tags: null, account_id: A, region: R, ...o,
});
const tg = (o: Row = {}): Row => ({
  target_group_arn: 'arn:tg1', target_group_name: 'tg1', load_balancer_arns: [], target_health_descriptions: [],
  tags: null, account_id: A, region: R, ...o,
});
const lb = (o: Row = {}): Row => ({ arn: 'arn:lb1', name: 'lb1', state_code: 'active', tags: null, account_id: A, region: R, ...o });

describe('parseStateTransitionTime', () => {
  it('parsesGmtTimestamp', () => {
    expect(parseStateTransitionTime('User initiated (2026-10-23 12:58:30 GMT)')?.toISOString()).toBe('2026-10-23T12:58:30.000Z');
  });
  it('parsesIsoTransitionTime', () => {
    expect(parseStateTransitionTime('2026-10-02T10:51:56Z')?.toISOString()).toBe('2026-10-02T10:51:56.000Z');
    expect(parseStateTransitionTime('2026-10-02T10:51:56.123Z')?.toISOString()).toBe('2026-10-02T10:51:56.123Z');
    expect(parseStateTransitionTime('2026-10-02T19:51:56+09:00')?.toISOString()).toBe('2026-10-02T10:51:56.000Z');
  });
  it('parsesDateObjectTransitionTime', () => {
    const d = new Date('2026-10-02T10:51:56Z');
    const out = parseStateTransitionTime(d);
    expect(out?.toISOString()).toBe('2026-10-02T10:51:56.000Z');
    expect(out).not.toBe(d);
    expect(parseStateTransitionTime(new Date('nope'))).toBeNull();
  });
  it('outOfRangeUserInitiatedIsNull', () => {
    expect(parseStateTransitionTime('User initiated (2026-13-23 12:58:30 GMT)')).toBeNull();
    expect(parseStateTransitionTime('User initiated (2026-02-30 12:58:30 GMT)')).toBeNull();
    expect(parseStateTransitionTime('User initiated (2026-10-23 25:58:30 GMT)')).toBeNull();
  });
  it('unparseableTransitionTimeIsSkipped', () => {
    for (const s of ['', null, undefined, 'weird']) expect(parseStateTransitionTime(s as string)).toBeNull();
    const recs = recommend([inv({ instances: [instance({ instance_state: 'stopped', state_transition_time: 'weird' }), instance({ instance_id: 'i-2', instance_state: 'stopped', state_transition_time: null })] })], NOW);
    expect(by(recs, 'long-stopped-ec2')).toHaveLength(0);
  });
});

describe('unused-eip', () => {
  it('unassociatedEipIsRecommended', () => {
    const recs = recommend([inv({ eips: [{ allocation_id: 'eipalloc-1', association_id: null, public_ip: '1.2.3.4', tags: null, account_id: A, region: R }] })], NOW);
    const r = by(recs, 'unused-eip');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe(`unused-eip:${A}:eipalloc-1`);
    expect(r[0].params.publicIp).toBe('1.2.3.4');
    expect(r[0].monthlySaving).toBeGreaterThan(0);
    expect(r[0].cliCommand).toBe(`aws ec2 release-address --allocation-id eipalloc-1 --region ${R}`);
    expect(r[0].consoleUrl).toContain(R);
  });
  it('associatedEipNotRecommended', () => {
    const recs = recommend([inv({ eips: [{ allocation_id: 'eipalloc-1', association_id: 'eipassoc-1', public_ip: '1.2.3.4', tags: null, account_id: A, region: R }] })], NOW);
    expect(by(recs, 'unused-eip')).toHaveLength(0);
  });
});

describe('unattached-ebs', () => {
  it('availableVolumeIsRecommended', () => {
    const recs = recommend([inv({ volumes: [volume({ state: 'available' })] })], NOW);
    const r = by(recs, 'unattached-ebs');
    expect(r).toHaveLength(1);
    const price = priceEbs({ volumeType: 'gp3', sizeGb: 100, iops: 3000, throughput: 125, region: R }).monthly as number;
    expect(r[0].monthlySaving).toBeCloseTo(price, 2);
    expect(r[0].cliCommand).toContain('aws ec2 delete-volume --volume-id vol-1');
  });
  it('snapshotFirstThenDelete', () => {
    const [r] = by(recommend([inv({ volumes: [volume({ state: 'available' })] })], NOW), 'unattached-ebs');
    expect(r.cliCommand.split('\n')).toEqual([
      `aws ec2 create-snapshot --volume-id vol-1 --description "backup before delete" --region ${R}`,
      `aws ec2 delete-volume --volume-id vol-1 --region ${R}`,
    ]);
  });
  it('inUseVolumeNotRecommended', () => {
    expect(by(recommend([inv({ volumes: [volume()] })], NOW), 'unattached-ebs')).toHaveLength(0);
  });
});

describe('long-stopped-ec2', () => {
  const vol = volume({ volume_id: 'vol-9', volume_type: 'gp3', size: 50, attachments: [{ InstanceId: 'i-1' }] });
  it('longStoppedFiresForDateObjectRow', () => {
    const recs = recommend([inv({ instances: [instance({ instance_state: 'stopped', state_transition_time: new Date('2026-10-02T10:51:56Z') })] })], NOW);
    const r = by(recs, 'long-stopped-ec2');
    expect(r).toHaveLength(1);
    expect(r[0].params.days).toBe(22);
  });
  it('longStoppedUsesTransitionDate', () => {
    const recs = recommend([inv({ instances: [instance({ instance_state: 'stopped' })], volumes: [vol] })], NOW);
    const r = by(recs, 'long-stopped-ec2');
    expect(r).toHaveLength(1);
    expect(r[0].params.days).toBe(23);
    const price = priceEbs({ volumeType: 'gp3', sizeGb: 50, iops: 3000, throughput: 125, region: R }).monthly as number;
    expect(r[0].monthlySaving).toBeCloseTo(price, 2);
    expect(r[0].cliCommand).toContain('aws ec2 terminate-instances --instance-ids i-1');
  });
  it('amiFirstThenTerminate', () => {
    const [r] = by(recommend([inv({ instances: [instance({ instance_state: 'stopped' })], volumes: [vol] })], NOW), 'long-stopped-ec2');
    expect(r.cliCommand.split('\n')).toEqual([
      `aws ec2 create-image --instance-id i-1 --name "i-1-backup" --region ${R}`,
      `aws ec2 terminate-instances --instance-ids i-1 --region ${R}`,
    ]);
  });
  it('recentlyStoppedNotRecommended', () => {
    const recs = recommend([inv({ instances: [instance({ instance_state: 'stopped', state_transition_time: 'User initiated (2026-10-21 01:00:00 GMT)' })] })], NOW);
    expect(by(recs, 'long-stopped-ec2')).toHaveLength(0);
  });
  it('runningInstanceNotLongStopped', () => {
    expect(by(recommend([inv({ instances: [instance()] })], NOW), 'long-stopped-ec2')).toHaveLength(0);
  });
  it('ebsOnLongStoppedInstanceCountedOnlyUnderInstance', () => {
    const gp2 = volume({ volume_id: 'vol-g', volume_type: 'gp2', size: 100, attachments: [{ InstanceId: 'i-1' }] });
    const recs = recommend([inv({ instances: [instance({ instance_state: 'stopped' })], volumes: [gp2] })], NOW);
    expect(by(recs, 'long-stopped-ec2')[0].countedInTotal).toBe(true);
    const g = by(recs, 'gp2-to-gp3');
    expect(g).toHaveLength(1);
    expect(g[0].countedInTotal).toBe(false);
  });
});

describe('old-snapshot', () => {
  const snap = (o: Row = {}): Row => ({ snapshot_id: 'snap-1', volume_id: 'vol-1', volume_size: 100, start_time: '2026-07-01T00:00:00Z', owner_id: A, tags: null, account_id: A, region: R, ...o });
  it('oldSnapshotIsRecommended', () => {
    const r = by(recommend([inv({ snapshots: [snap()] })], NOW), 'old-snapshot');
    expect(r).toHaveLength(1);
    expect(r[0].monthlySaving).toBeCloseTo(100 * 0.05, 2);
    expect(r[0].params.days).toBeGreaterThanOrEqual(90);
    expect(r[0].cliCommand).toContain('aws ec2 delete-snapshot --snapshot-id snap-1');
  });
  it('snapshotStartTimeAsDateObject', () => {
    const r = by(recommend([inv({ snapshots: [snap({ start_time: new Date('2026-07-01T00:00:00Z') })] })], NOW), 'old-snapshot');
    expect(r).toHaveLength(1);
    expect(by(recommend([inv({ snapshots: [snap({ start_time: new Date('garbage') }), snap({ snapshot_id: 'snap-2', start_time: null })] })], NOW), 'old-snapshot')).toHaveLength(0);
  });
  it('recentSnapshotNotRecommended', () => {
    expect(by(recommend([inv({ snapshots: [snap({ start_time: '2026-09-20T00:00:00Z' })] })], NOW), 'old-snapshot')).toHaveLength(0);
  });
  it('foreignOwnerSnapshotIgnored', () => {
    expect(by(recommend([inv({ snapshots: [snap({ owner_id: '999999999999' })] })], NOW), 'old-snapshot')).toHaveLength(0);
  });
});

describe('empty target groups and load balancers', () => {
  it('emptyTargetGroupIsListedWithZeroSaving', () => {
    const r = by(recommend([inv({ targetGroups: [tg()] })], NOW), 'empty-tg');
    expect(r).toHaveLength(1);
    expect(r[0].monthlySaving).toBe(0);
    expect(r[0].countedInTotal).toBe(true);
    expect(r[0].cliCommand).toContain('aws elbv2 delete-target-group --target-group-arn arn:tg1');
  });
  it('targetGroupWithTargetsNotRecommended', () => {
    const recs = recommend([inv({ targetGroups: [tg({ target_health_descriptions: [{ Target: { Id: 'i-1' } }] })] })], NOW);
    expect(by(recs, 'empty-tg')).toHaveLength(0);
  });
  it('managedEmptyTargetGroupHasNoteAndIsNotCounted', () => {
    for (const key of ['aws:ecs:serviceName', 'elbv2.k8s.aws/cluster', 'aws:autoscaling:groupName']) {
      const r = by(recommend([inv({ targetGroups: [tg({ tags: { [key]: 'x' } })] })], NOW), 'empty-tg');
      expect(r[0].note).toBe('maybe-scaled-to-zero');
      expect(r[0].countedInTotal).toBe(false);
    }
  });
  it('lbWithAllEmptyTargetGroupsIsRecommended', () => {
    const recs = recommend([inv({ albs: [lb()], targetGroups: [tg({ load_balancer_arns: ['arn:lb1'] })] })], NOW);
    const r = by(recs, 'empty-lb');
    expect(r).toHaveLength(1);
    expect(r[0].monthlySaving).toBeGreaterThan(0);
    expect(r[0].cliCommand).toContain('aws elbv2 delete-load-balancer --load-balancer-arn arn:lb1');
  });
  it('lbWithOneBusyTargetGroupNotRecommended', () => {
    const recs = recommend([inv({ albs: [lb()], targetGroups: [
      tg({ load_balancer_arns: ['arn:lb1'] }),
      tg({ target_group_arn: 'arn:tg2', load_balancer_arns: ['arn:lb1'], target_health_descriptions: [{ Target: { Id: 'i-1' } }] }),
    ] })], NOW);
    expect(by(recs, 'empty-lb')).toHaveLength(0);
  });
  it('lbWithoutTargetGroupsIsRecommended', () => {
    expect(by(recommend([inv({ nlbs: [lb({ arn: 'arn:nlb' })] })], NOW), 'empty-lb')).toHaveLength(1);
  });
  it('unparseableLbLinkSuppressesEveryEmptyLbInTheAccount', () => {
    for (const bad of [null, 'not-json', '{"a":1}']) {
      const recs = recommend([inv({ albs: [lb(), lb({ arn: 'arn:lb2', name: 'lb2' })], targetGroups: [
        tg({ load_balancer_arns: ['arn:lb1'] }),
        tg({ target_group_arn: 'arn:tg2', load_balancer_arns: bad }),
      ] })], NOW);
      expect(by(recs, 'empty-lb')).toHaveLength(0);
      expect(by(recs, 'empty-tg')).toHaveLength(2); // TG rule itself still applies / TG 규칙은 그대로
    }
    // other accounts are unaffected / 다른 계정은 영향 없음
    const B = '222222222222';
    const recs = recommend([
      inv({ targetGroups: [tg({ load_balancer_arns: null })] }),
      inv({ accountId: B, albs: [lb({ account_id: B })] }),
    ], NOW);
    expect(by(recs, 'empty-lb').map(r => r.accountId)).toEqual([B]);
  });
  it('targetGroupQueryErrorSkipsTgAndLbRules', () => {
    const recs = recommend([inv({ albs: [lb()], targetGroups: [tg()], errors: { 'target-groups': 'denied' } })], NOW);
    expect(by(recs, 'empty-tg')).toHaveLength(0);
    expect(by(recs, 'empty-lb')).toHaveLength(0);
  });
});

describe('office-hours', () => {
  it('officeHoursSavingFactor', () => {
    const r = by(recommend([inv({ instances: [instance()] })], NOW), 'office-hours');
    expect(r).toHaveLength(1);
    const monthly = priceEc2({ instanceType: 't4g.xlarge', platformDetails: 'Linux/UNIX', tenancy: 'default', region: R }).monthly as number;
    expect(r[0].monthlySaving).toBeCloseTo(two(monthly * (1 - 50 / 168)), 2);
    expect(r[0].resourceId).toBe('i-1');
    expect(r[0].cliCommand).toBe('');
    expect(r[0].countedInTotal).toBe(true);
    expect(r[0].note).toBeUndefined();
  });
  it('managedInstanceIsListedButNotCounted', () => {
    for (const key of ['aws:autoscaling:groupName', 'eks:cluster-name', 'kubernetes.io/cluster/prod', 'aws:ecs:clusterName']) {
      const [r] = by(recommend([inv({ instances: [instance({ tags: { [key]: 'owned', Name: 'node' } })] })], NOW), 'office-hours');
      expect(r.note).toBe('managed-instance');
      expect(r.countedInTotal).toBe(false);
      expect(r.monthlySaving).toBeGreaterThan(0);
    }
  });
  it('unpricedOrStoppedInstanceHasNoOfficeHours', () => {
    const recs = recommend([inv({ instances: [instance({ platform_details: 'Windows' }), instance({ instance_id: 'i-2', instance_state: 'stopped' })] })], NOW);
    expect(by(recs, 'office-hours')).toHaveLength(0);
  });
});

describe('gp2-to-gp3', () => {
  it('gp2IsRecommendedAtTwentyPercent', () => {
    const r = by(recommend([inv({ volumes: [volume({ volume_type: 'gp2' })] })], NOW), 'gp2-to-gp3');
    expect(r).toHaveLength(1);
    const price = priceEbs({ volumeType: 'gp2', sizeGb: 100, region: R }).monthly as number;
    expect(r[0].monthlySaving).toBeCloseTo(two(price * 0.2), 2);
    expect(r[0].cliCommand).toContain('--volume-type gp3');
  });
  it('gp3NotRecommended', () => {
    expect(by(recommend([inv({ volumes: [volume()] })], NOW), 'gp2-to-gp3')).toHaveLength(0);
  });
});

describe('dedupe', () => {
  it('dedupeKeepsLargerSavingPerResource', () => {
    const recs = recommend([inv({ volumes: [volume({ volume_type: 'gp2', state: 'available' })] })], NOW);
    const un = by(recs, 'unattached-ebs')[0];
    const g = by(recs, 'gp2-to-gp3')[0];
    expect(un.countedInTotal).toBe(true);
    expect(g.countedInTotal).toBe(false);
    expect(recs).toHaveLength(2);
    expect(new Set(recs.map(r => r.id)).size).toBe(2);
  });
});

describe('summarizeSavings', () => {
  const rec = (s: number, counted: boolean): Recommendation => ({
    id: 'x' + s, rule: 'unused-eip', resourceId: 'x' + s, accountId: A, region: R, params: {}, monthlySaving: s,
    countedInTotal: counted, cliCommand: '', consoleUrl: '', tags: {},
  });
  it('sumsOnlyCounted', () => {
    expect(summarizeSavings([rec(10, true), rec(5, false), rec(2.5, true)], 100, NOW).monthly).toBeCloseTo(12.5, 2);
  });
  it('yearEndUsesFractionalMonths', () => {
    // KST today 2026-10-24; Dec 31 is 68 days later (difference of calendar dates).
    const months = 68 / 30.4;
    const s = summarizeSavings([rec(112, true)], 268, NOW);
    expect(s.monthly).toBe(112);
    expect(s.yearEndCurrent).toBeCloseTo(268 * months, 1);
    expect(s.yearEndAfter).toBeCloseTo((268 - 112) * months, 1);
  });
  it('yearEndUsesKstDate', () => {
    // 2026-10-23T20:00Z is already 10-24 in KST.
    const a = summarizeSavings([], 100, new Date('2026-10-23T20:00:00Z'));
    const b = summarizeSavings([], 100, new Date('2026-10-23T10:00:00Z'));
    expect(a.yearEndCurrent).toBeCloseTo(100 * 68 / 30.4, 1);
    expect(b.yearEndCurrent).toBeCloseTo(100 * 69 / 30.4, 1);
  });
});
