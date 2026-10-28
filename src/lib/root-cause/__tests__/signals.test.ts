// Signal detection tests (no real AWS). / 신호 감지 시험 — 실제 AWS 호출 없음.
import { describe, it, expect, vi } from 'vitest';
import { detect5xx, detectRise, watchTargets, lbDimension, tgDimension, fetchSignals, type Series } from '../signals';
import type { GraphData, GraphNode } from '@/lib/dep-graph/types';

const now = new Date('2026-10-29T12:00:00Z');
const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
// minute offsets (ago) -> value. / 몇 분 전 -> 값.
const mk = (f: (m: number) => number, from = 65): Series => Array.from({ length: from }, (_, m) => ({ t: at(m), v: f(m) }));

const node = (type: GraphNode['type'], id: string, arn: string, attrs: Record<string, unknown> = {}): GraphNode => ({ arn, type, id, name: id, accountId: 'A', region: 'ap-northeast-2', attrs });
const LB = 'arn:aws:elasticloadbalancing:ap-northeast-2:A:loadbalancer/app/web/abc';
const NLB = 'arn:aws:elasticloadbalancing:ap-northeast-2:A:loadbalancer/net/nlb/def';
const TG = 'arn:aws:elasticloadbalancing:ap-northeast-2:A:targetgroup/web-tg/123';
const TG2 = 'arn:aws:elasticloadbalancing:ap-northeast-2:A:targetgroup/nlb-tg/456';
const data: GraphData = {
  nodes: [node('lb', 'web', LB, { lbType: 'application' }), node('lb', 'nlb', NLB, { lbType: 'network' }), node('tg', 'web-tg', TG), node('tg', 'nlb-tg', TG2),
    node('instance', 'i-1', 'arn:i-1', { state: 'running' }), node('instance', 'i-2', 'arn:i-2', { state: 'stopped' })],
  edges: [{ src: LB, dst: TG, type: 'forwards_to' }, { src: NLB, dst: TG2, type: 'forwards_to' }],
  dropped: 0,
};

describe('detect5xx', () => {
  it('flat 0 -> null', () => expect(detect5xx(mk(() => 0), now)).toBeNull());
  it('spike over baseline', () => {
    const r = detect5xx(mk((m) => (m < 5 ? 20 : 3)), now)!;
    expect(r.recent).toBe(100);
    expect(r.baseline).toBe(15);
    expect(r.startedAt).toBe(at(4));
  });
  it('under floor -> null', () => expect(detect5xx(mk((m) => (m < 3 ? 3 : 0)), now)).toBeNull());
});

describe('detectRise', () => {
  it('rise from zero', () => expect(detectRise(mk((m) => (m < 3 ? 2 : 0)), now)).toEqual({ startedAt: at(2), recent: 2 }));
  it('suppressed when prior 30 had 1', () => expect(detectRise(mk((m) => (m < 3 || m === 20 ? 1 : 0)), now)).toBeNull());
});

describe('watchTargets / dimensions', () => {
  it('filters NLB and stopped instances', () => {
    const t = watchTargets(data, 'A');
    expect(t.lbs.map((n) => n.id)).toEqual(['web']);
    expect(t.tgs.map((n) => n.id)).toEqual(['web-tg']);
    expect(t.instances.map((n) => n.id)).toEqual(['i-1']);
  });
  it('dimension helpers', () => {
    expect(lbDimension(LB)).toBe('app/web/abc');
    expect(tgDimension(TG)).toBe('targetgroup/web-tg/123');
  });
});

describe('fetchSignals', () => {
  const fakeMetrics = async (q: { id: string }[]) => {
    const r: Record<string, Series> = {};
    for (const x of q) r[x.id] = [];
    r.lb0e = mk((m) => (m < 5 ? 10 : 0));
    r.lb0t = mk((m) => (m < 5 ? 10 : 0));
    r.tg0 = mk((m) => (m < 2 ? 2 : 0));
    r.ec0 = mk((m) => (m < 2 ? 1 : 0));
    return r;
  };
  it('maps series to resources and sums ELB+Target 5xx', async () => {
    const s = await fetchSignals('A', 'ap-northeast-2', data, now, { getMetricData: fakeMetrics, describeAlarms: async () => [] });
    expect(s.map((x) => x.kind).sort()).toEqual(['alb-5xx', 'ec2-status', 'tg-unhealthy']);
    const a = s.find((x) => x.kind === 'alb-5xx')!;
    expect(a.resourceArn).toBe(LB);
    expect(a.recent).toBe(100);
    expect(a.detail).toContain('5xx');
    expect(s.find((x) => x.kind === 'tg-unhealthy')!.detail).toBe('비정상 대상 2개');
    expect(s.find((x) => x.kind === 'ec2-status')!.resourceArn).toBe('arn:i-1');
  });
  const alarm = { name: 'tg-bad', arn: 'arn:alarm', stateUpdatedAt: at(3), dimensions: { TargetGroup: 'targetgroup/web-tg/123', LoadBalancer: 'app/web/abc' } };
  it('alarm with TargetGroup dim resolves to TG; old alarms ignored', async () => {
    const s = await fetchSignals('A', 'ap-northeast-2', data, now, { getMetricData: async () => ({}), describeAlarms: async () => [alarm, { ...alarm, name: 'old', stateUpdatedAt: at(30) }] });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: 'alarm', resourceArn: TG, alarmName: 'tg-bad', alarmArn: 'arn:alarm', detail: '알람 tg-bad' });
  });
  it('unresolvable alarm -> null arn', async () => {
    const s = await fetchSignals('A', 'ap-northeast-2', data, now, { getMetricData: async () => ({}), describeAlarms: async () => [{ ...alarm, dimensions: { InstanceId: 'i-zzz' } }] });
    expect(s[0].resourceArn).toBeNull();
  });
  it('getMetricData throwing still returns alarm signals', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await fetchSignals('A', 'ap-northeast-2', data, now, { getMetricData: async () => { throw new Error('boom'); }, describeAlarms: async () => [alarm] });
    expect(s.map((x) => x.kind)).toEqual(['alarm']);
    spy.mockRestore();
  });
});
