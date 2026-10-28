// Incident grouping tests (pure). / 사건 묶기 시험 — 순수 함수.
import { describe, it, expect } from 'vitest';
import { applySignals, incidentKey } from '../incidents';
import type { GraphData, GraphNode } from '@/lib/dep-graph/types';
import type { Incident, Signal } from '../types';

const A = '111111111111';
const t0 = new Date('2026-10-29T12:00:00Z');
const plus = (min: number) => new Date(t0.getTime() + min * 60_000);
const node = (type: GraphNode['type'], id: string, arn: string): GraphNode => ({ arn, type, id, name: id, accountId: A, region: 'ap-northeast-2', attrs: {} });
const LB = `arn:aws:elasticloadbalancing:ap-northeast-2:${A}:loadbalancer/app/web/abc`;
const LB2 = `arn:aws:elasticloadbalancing:ap-northeast-2:${A}:loadbalancer/app/other/def`;
const TG = `arn:aws:elasticloadbalancing:ap-northeast-2:${A}:targetgroup/web-tg/123`;
const I1 = `arn:aws:ec2:ap-northeast-2:${A}:instance/i-1`;
const graph: GraphData = {
  nodes: [node('lb', 'web', LB), node('lb', 'other', LB2), node('tg', 'web-tg', TG), node('instance', 'i-1', I1)],
  edges: [{ src: LB, dst: TG, type: 'forwards_to' }, { src: TG, dst: I1, type: 'targets' }],
  dropped: 0,
};
const graphFor = () => graph;
const sig = (kind: Signal['kind'], resourceArn: string | null, extra: Partial<Signal> = {}): Signal =>
  ({ kind, accountId: A, region: 'ap-northeast-2', resourceArn, startedAt: t0.toISOString(), detail: kind, ...extra });

describe('incidentKey', () => {
  it('uses the resource ARN', () => expect(incidentKey(sig('alb-5xx', LB))).toBe(`${A}|${LB}|alb-5xx`));
  it('alarm without a resource uses alarm:<arn>', () =>
    expect(incidentKey(sig('alarm', null, { alarmArn: 'arn:alarm:x' }))).toBe(`${A}|alarm:arn:alarm:x|alarm`));
});

describe('applySignals', () => {
  it('LB, its TG and its instance in one tick -> 1 incident with 3 signals', () => {
    const r = applySignals([], [sig('tg-unhealthy', TG), sig('ec2-status', I1), sig('alb-5xx', LB)], graphFor, t0);
    expect(r.list).toHaveLength(1);
    expect(r.created).toHaveLength(1);
    expect(r.list[0].signals).toHaveLength(3);
    expect(r.list[0].id).toMatch(/^rc-[0-9a-z]{10}$/);
    expect(r.list[0].source).toBe('auto');
    expect(r.list[0].resourceName).toBe('web-tg');
  });
  it('unrelated LB -> 2 incidents', () => {
    const r = applySignals([], [sig('alb-5xx', LB), sig('alb-5xx', LB2)], graphFor, t0);
    expect(r.list).toHaveLength(2);
    expect(r.created).toHaveLength(2);
  });
  it('dedupes within 60 min, creates a new one after 61', () => {
    const first = applySignals([], [sig('alb-5xx', LB)], graphFor, t0).list;
    const again = applySignals(first, [sig('alb-5xx', LB)], graphFor, plus(25));
    expect(again.list).toHaveLength(1);
    expect(again.created).toHaveLength(0);
    expect(again.list[0].lastSeenAt).toBe(plus(25).toISOString());
    expect(again.list[0].signals).toHaveLength(1);
    // keep it open but stale by 61 min (no resolve pass in between) / 중간 정리 없이 61분 지난 상태
    const later = applySignals(first, [sig('alb-5xx', LB)], graphFor, plus(61));
    expect(later.created).toHaveLength(1);
    expect(later.list).toHaveLength(2);
  });
  it('a joined signal seen again only bumps lastSeenAt', () => {
    const first = applySignals([], [sig('alb-5xx', LB), sig('tg-unhealthy', TG)], graphFor, t0).list;
    const again = applySignals(first, [sig('tg-unhealthy', TG)], graphFor, plus(5));
    expect(again.list).toHaveLength(1);
    expect(again.list[0].signals).toHaveLength(2);
  });
  it('resolves after 30 quiet minutes', () => {
    const first = applySignals([], [sig('alb-5xx', LB)], graphFor, t0).list;
    expect(applySignals(first, [], graphFor, plus(29)).list[0].status).toBe('open');
    expect(applySignals(first, [], graphFor, plus(31)).list[0].status).toBe('resolved');
  });
  it('manual incidents never take part in grouping', () => {
    const manual: Incident = { id: 'rc-manual0001', key: 'manual|rc-manual0001', accountId: A, region: 'ap-northeast-2', resourceArn: LB, resourceName: 'web', signals: [], startedAt: t0.toISOString(), firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString(), status: 'open', source: 'manual' };
    const r = applySignals([manual], [sig('alb-5xx', LB)], graphFor, plus(1));
    expect(r.created).toHaveLength(1);
    expect(r.list).toHaveLength(2);
    expect(r.list.find((i) => i.id === manual.id)!.signals).toHaveLength(0);
  });
  it('alarm without resource does not group with anything', () => {
    const r = applySignals([], [sig('alb-5xx', LB), sig('alarm', null, { alarmArn: 'arn:alarm:x' })], graphFor, t0);
    expect(r.list).toHaveLength(2);
  });
  it('different account does not group', () => {
    const r = applySignals([], [sig('alb-5xx', LB), sig('tg-unhealthy', TG, { accountId: '222222222222' })], graphFor, t0);
    expect(r.list).toHaveLength(2);
  });
  it('keeps the newest 200', () => {
    const many: Incident[] = Array.from({ length: 205 }, (_, i) => ({
      id: `rc-${String(i).padStart(10, '0')}`, key: `k${i}`, accountId: A, region: 'ap-northeast-2', resourceArn: null, resourceName: null, signals: [],
      startedAt: plus(-300 + i).toISOString(), firstSeenAt: plus(-300 + i).toISOString(), lastSeenAt: plus(-300 + i).toISOString(), status: 'resolved', source: 'auto',
    }));
    const r = applySignals(many, [sig('alb-5xx', LB)], graphFor, t0);
    expect(r.list).toHaveLength(200);
    expect(r.list[0].resourceArn).toBe(LB);
    expect(r.list.some((i) => i.id === 'rc-0000000000')).toBe(false);
  });
});
