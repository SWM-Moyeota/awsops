import { describe, it, expect, vi } from 'vitest';
import { explainChange, type ExplainDeps } from '../explain';
import type { DailySnapshot, Estimate, PricedResource, SnapshotResource, CategoryId } from '../types';
import type { ChangeKind, ChangeRecord, ResourceType } from '@/lib/change-timeline/types';

const A = '111111111111';
const B = '222222222222';
const C = '333333333333';
// 2026-10-27 12:00 KST
const NOW = new Date('2026-10-27T03:00:00Z');
// days=7 -> fromDay 2026-10-20, window starts 2026-10-20T00:00+09:00
const FROM_DAY = '2026-10-20';
const WINDOW_START = new Date('2026-10-19T15:00:00Z');

function live(id: string, monthly: number, over: Partial<PricedResource> = {}): PricedResource {
  return {
    id, name: over.name ?? `n-${id}`, accountId: over.accountId ?? A, region: 'ap-northeast-2',
    category: over.category ?? 'ec2', detail: over.detail ?? 't3.micro', monthly, tags: {}, ...over,
  };
}

function snap(id: string, monthly: number, over: Partial<SnapshotResource> = {}): SnapshotResource {
  return { id, name: `n-${id}`, category: 'ec2' as CategoryId, monthly, detail: 't3.micro', ...over };
}

function estimate(resources: PricedResource[], monthly?: number, accountId = A): Estimate {
  const sum = resources.reduce((s, r) => s + (r.monthly ?? 0), 0);
  return {
    accountId, monthly: monthly ?? sum, hourly: 0, categories: [], resources, unpriced: [], warnings: [],
    priceAsOf: '2026-10-01',
  };
}

let seq = 0;
function rec(kind: ChangeKind, resourceId: string, time: string, over: Partial<ChangeRecord> = {}): ChangeRecord {
  seq += 1;
  return {
    id: `r${seq}`, eventId: `e${seq}`, eventName: 'X', accountId: A, region: 'ap-northeast-2', time, kind,
    resourceType: 'ec2-instance' as ResourceType, resourceId, resourceName: `n-${resourceId}`,
    actor: { kind: 'person', name: 'jiwoo' }, tool: 'console', ...over,
  };
}

function deps(opts: {
  snapshots?: Record<string, DailySnapshot['accounts']>;
  days?: string[];
  records?: ChangeRecord[];
  est?: Estimate;
}): ExplainDeps & { [k: string]: ReturnType<typeof vi.fn> } {
  const snapshots = opts.snapshots ?? {};
  return {
    readSnapshot: vi.fn(async (day: string) => (snapshots[day] ? { day, accounts: snapshots[day] } : null)),
    listSnapshotDays: vi.fn(async () => opts.days ?? Object.keys(snapshots).sort()),
    readRecords: vi.fn(async () => opts.records ?? []),
    liveEstimate: vi.fn(async () => opts.est ?? estimate([])),
  };
}

describe('explainChange — snapshot mode', () => {
  it('addedRemovedChangedWithImpactsAndUnexplained', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [snap('i-1', 10), snap('i-2', 20, { detail: 't3.small' }), snap('vol-3', 5, { category: 'storage', detail: 'gp3 100GB' })] } },
      est: estimate([live('i-1', 10), live('i-2', 35, { detail: 't3.large' }), live('i-4', 40)], 88),
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.mode).toBe('snapshot');
    expect(r.days).toBe(7);
    expect(r.fromDay).toBe(FROM_DAY);
    expect(r.accountId).toBe(A);
    expect(r.baseMonthly).toBe(35);
    expect(r.currentMonthly).toBe(88);
    expect(r.delta).toBe(53);
    expect(r.unexplained).toBe(3);
    expect(r.notes).toEqual([]);
    expect(r.causes.map((c) => [c.kind, c.resourceId, c.impact])).toEqual([
      ['added', 'i-4', 40],
      ['changed', 'i-2', 15],
      ['removed', 'vol-3', -5],
    ]);
    const [added, changed, removed] = r.causes;
    expect(added).toMatchObject({ monthlyBefore: null, monthlyAfter: 40, detailAfter: 't3.micro', name: 'n-i-4', category: 'ec2', accountId: A });
    expect(changed).toMatchObject({ monthlyBefore: 20, monthlyAfter: 35, detailBefore: 't3.small', detailAfter: 't3.large' });
    expect(removed).toMatchObject({ monthlyBefore: 5, monthlyAfter: null, detailBefore: 'gp3 100GB', category: 'storage' });
    expect(d.readSnapshot).toHaveBeenCalledWith(FROM_DAY);
    expect(d.liveEstimate).toHaveBeenCalledWith(A);
    expect(d.readRecords).toHaveBeenCalledWith(WINDOW_START, NOW);
  });

  it('ignores live resources with no price or zero price', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [] } },
      est: estimate([live('i-0', 0), { ...live('i-n', 0), monthly: null }]),
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes).toEqual([]);
  });

  it('unchangedPriceIsNotACause', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [snap('i-1', 10), snap('i-2', 20)] } },
      est: estimate([live('i-1', 10), live('i-2', 20.004)]),
      records: [rec('stop', 'i-1', '2026-10-22T01:00:00Z'), rec('start', 'i-1', '2026-10-23T01:00:00Z')],
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes).toEqual([]);
    expect(r.delta).toBe(0);
    expect(r.unexplained).toBe(0);
  });

  it('nearestBaseDayIsUsedAndNoted', async () => {
    const d = deps({
      snapshots: {
        '2026-10-18': { [A]: [snap('i-1', 99)] },
        '2026-10-22': { [A]: [snap('i-1', 10)] },
        '2026-10-24': { [A]: [snap('i-1', 50)] },
      },
      est: estimate([live('i-1', 10)]),
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.mode).toBe('snapshot');
    expect(r.baseMonthly).toBe(10);
    expect(r.notes).toContain('기준일을 2026-10-22로 맞췄어요');
  });

  it('a snapshot from today is never used as the base', async () => {
    const d = deps({
      snapshots: { '2026-10-18': { [A]: [snap('i-1', 99)] }, '2026-10-27': { [A]: [snap('i-1', 10)] } },
      est: estimate([live('i-1', 10)]),
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.mode).toBe('timeline-only');
  });

  it('accountMissingInBaseIsNoted', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [snap('i-1', 10)], [C]: [snap('i-c', 500)] } },
      est: estimate([live('i-1', 10), live('i-b', 7, { accountId: B })], undefined, '__all__'),
    });
    const r = await explainChange({ accountId: '__all__', days: 7, now: NOW }, d);
    expect(r.mode).toBe('snapshot');
    expect(r.notes).toContain(`기준일에 없던 계정: ${B}`);
    // C is not in the live estimate, so it is not part of the comparison.
    expect(r.baseMonthly).toBe(10);
    expect(r.currentMonthly).toBe(17);
    expect(r.delta).toBe(7);
    expect(r.causes).toHaveLength(1);
    expect(r.causes[0]).toMatchObject({ kind: 'added', accountId: B, resourceId: 'i-b', impact: 7 });
    expect(r.unexplained).toBe(0);
  });

  it('single account missing in the base counts as base 0 and is noted', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [snap('i-1', 10)] } },
      est: estimate([live('i-b', 7, { accountId: B })], undefined, B),
    });
    const r = await explainChange({ accountId: B, days: 7, now: NOW }, d);
    expect(r.baseMonthly).toBe(0);
    expect(r.delta).toBe(7);
    expect(r.notes).toContain(`기준일에 없던 계정: ${B}`);
  });

  it('same id in two accounts is two different resources', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [snap('i-1', 10)], [B]: [] } },
      est: estimate([live('i-1', 10), live('i-1', 10, { accountId: B })], undefined, '__all__'),
    });
    const r = await explainChange({ accountId: '__all__', days: 7, now: NOW }, d);
    expect(r.causes.map((c) => [c.kind, c.accountId])).toEqual([['added', B]]);
  });

  it('sortedByAbsImpactNullsLast', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [snap('i-big', 50)] } },
      est: estimate([live('i-small', 10), live('i-mid', 30)]),
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes.map((c) => c.impact)).toEqual([-50, 30, 10]);
  });

  it('capsAt50', async () => {
    const res = Array.from({ length: 60 }, (_, i) => live(`i-${i}`, i + 1));
    const d = deps({ snapshots: { [FROM_DAY]: { [A]: [] } }, est: estimate(res) });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes).toHaveLength(50);
    expect(r.causes[0].impact).toBe(60);
    expect(r.causes[49].impact).toBe(11);
    // unexplained is computed over every cause, not only the 50 shown
    expect(r.unexplained).toBe(0);
    expect(r.notes.some((n) => n.includes('50'))).toBe(true);
  });
});

describe('explainChange — timeline-only mode', () => {
  it('noSnapshotFallsBackToTimelineMode', async () => {
    const d = deps({
      est: estimate([live('i-4', 40), live('i-2', 20), live('i-old', 5)], 65),
      records: [
        rec('create', 'i-4', '2026-10-24T01:00:00Z'),
        rec('delete', 'vol-3', '2026-10-25T01:00:00Z', { resourceType: 'ebs-volume', resourceName: 'data' }),
        rec('stop', 'i-2', '2026-10-23T01:00:00Z'),
        rec('create', 'i-gone', '2026-10-23T01:00:00Z'),
        rec('delete', 'role-x', '2026-10-23T01:00:00Z', { resourceType: 'iam-role' }),
        rec('create', 'i-old', '2026-10-23T01:00:00Z', { failed: true }),
      ],
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.mode).toBe('timeline-only');
    expect(r.baseMonthly).toBeNull();
    expect(r.delta).toBeNull();
    expect(r.unexplained).toBeNull();
    expect(r.currentMonthly).toBe(65);
    expect(r.fromDay).toBe(FROM_DAY);
    expect(r.notes).toContain('아직 비교할 과거 스냅샷이 없어서 기록 기반으로 추정했어요');
    expect(d.readRecords).toHaveBeenCalledWith(WINDOW_START, NOW);
    expect(r.causes.map((c) => [c.kind, c.resourceId, c.impact, c.action])).toEqual([
      ['added', 'i-4', 40, 'create'],
      ['removed', 'vol-3', null, 'delete'],
      ['changed', 'i-2', null, 'stop'],
    ]);
    expect(r.causes[0]).toMatchObject({ monthlyBefore: null, monthlyAfter: 40, actor: { kind: 'person', name: 'jiwoo' } });
    expect(r.causes[1]).toMatchObject({ name: 'data', category: 'storage', monthlyBefore: null, monthlyAfter: null });
    expect(r.causes[2]).toMatchObject({ monthlyAfter: 20, category: 'ec2' });
  });

  it('a live resource created and then stopped is listed once, as added', async () => {
    const d = deps({
      est: estimate([live('i-4', 40)]),
      records: [rec('create', 'i-4', '2026-10-24T01:00:00Z'), rec('stop', 'i-4', '2026-10-25T01:00:00Z')],
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes.map((c) => [c.kind, c.action])).toEqual([['added', 'create']]);
  });

  it('only records of the selected account are used', async () => {
    const d = deps({
      est: estimate([live('i-4', 40)]),
      records: [rec('create', 'i-4', '2026-10-24T01:00:00Z', { accountId: B }), rec('delete', 'vol-9', '2026-10-24T01:00:00Z', { accountId: B, resourceType: 'ebs-volume' })],
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes).toEqual([]);
  });

  it('records outside the window are ignored', async () => {
    const d = deps({
      est: estimate([live('i-4', 40)]),
      records: [rec('create', 'i-4', '2026-10-19T14:59:59Z')],
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes).toEqual([]);
  });
});

describe('explainChange — attribution', () => {
  it('attributionPicksNewestMatchingKind', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [snap('i-2', 20)] } },
      est: estimate([live('i-2', 35)]),
      records: [
        rec('modify', 'i-2', '2026-10-21T01:00:00Z', { actor: { kind: 'person', name: 'old' } }),
        rec('stop', 'i-2', '2026-10-23T01:00:00Z', { actor: { kind: 'auto', name: 'scheduler', sourceIdentity: 'x' } }),
        rec('create', 'i-2', '2026-10-25T01:00:00Z', { actor: { kind: 'person', name: 'wrongkind' } }),
        rec('modify', 'i-2', '2026-10-26T01:00:00Z', { failed: true, actor: { kind: 'person', name: 'failed' } }),
        rec('modify', 'i-2', '2026-10-26T02:00:00Z', { accountId: B, actor: { kind: 'person', name: 'otheracct' } }),
        rec('modify', 'i-2', '2026-10-01T02:00:00Z', { actor: { kind: 'person', name: 'outside' } }),
      ],
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes).toHaveLength(1);
    expect(r.causes[0].action).toBe('stop');
    expect(r.causes[0].actor).toEqual({ kind: 'auto', name: 'scheduler' });
    expect(r.causes[0].time).toBe('2026-10-23T01:00:00Z');
  });

  it('removed matches delete records, added matches create records', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [snap('vol-3', 5)] } },
      est: estimate([live('i-4', 40)]),
      records: [
        rec('delete', 'vol-3', '2026-10-22T01:00:00Z', { actor: { kind: 'person', name: 'minsu' } }),
        rec('create', 'i-4', '2026-10-22T01:00:00Z', { actor: { kind: 'root', name: 'root' } }),
        rec('start', 'i-4', '2026-10-23T01:00:00Z', { actor: { kind: 'person', name: 'starter' } }),
      ],
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes.map((c) => [c.resourceId, c.action, c.actor?.name])).toEqual([
      ['i-4', 'create', 'root'],
      ['vol-3', 'delete', 'minsu'],
    ]);
  });

  it('noRecordMeansNoActor', async () => {
    const d = deps({ snapshots: { [FROM_DAY]: { [A]: [] } }, est: estimate([live('i-4', 40)]) });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes).toHaveLength(1);
    expect(r.causes[0].actor).toBeUndefined();
    expect(r.causes[0].action).toBeUndefined();
    expect(r.causes[0].time).toBeUndefined();
  });

  it('s3MatchesByName', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [] } },
      est: estimate([
        live('arn:aws:s3:::logs-bucket', 4, { name: 'logs-bucket', category: 'storage' }),
      ]),
      records: [
        rec('create', 'logs-bucket-id', '2026-10-22T01:00:00Z', { resourceType: 's3-bucket', resourceName: 'logs-bucket', actor: { kind: 'person', name: 'bucketeer' } }),
        rec('create', 'vol-other', '2026-10-22T01:00:00Z', { resourceType: 'ebs-volume', resourceName: 'n-x' }),
      ],
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    const bucket = r.causes.find((c) => c.resourceId === 'arn:aws:s3:::logs-bucket');
    expect(bucket?.actor).toEqual({ kind: 'person', name: 'bucketeer' });
    expect(bucket?.action).toBe('create');
  });

  it('a non-s3 record matches by id, never by name', async () => {
    const d = deps({
      snapshots: { [FROM_DAY]: { [A]: [] } },
      est: estimate([live('i-4', 40, { name: 'web' })]),
      records: [rec('create', 'i-other', '2026-10-22T01:00:00Z', { resourceName: 'web' })],
    });
    const r = await explainChange({ accountId: A, days: 7, now: NOW }, d);
    expect(r.causes[0].actor).toBeUndefined();
  });

  it('days=1 uses yesterday (KST) as the base day', async () => {
    const d = deps({ snapshots: { '2026-10-26': { [A]: [snap('i-1', 10)] } }, est: estimate([live('i-1', 12)]) });
    const r = await explainChange({ accountId: A, days: 1, now: NOW }, d);
    expect(r.fromDay).toBe('2026-10-26');
    expect(r.delta).toBe(2);
  });
});
