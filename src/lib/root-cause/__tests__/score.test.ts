// Unit tests for score parts and ranking order/limits.
// 점수 요소와 순위 정렬·상한 단위 시험.
import { describe, expect, it } from 'vitest';
import type { GraphData } from '@/lib/dep-graph/types';
import { rankSuspects } from '../rank';
import { graphWeight, kindWeight, timeWeight } from '../score';

const start = new Date('2026-10-29T10:00:00Z');
const at = (min: number) => new Date(start.getTime() + min * 60_000);

describe('timeWeight', () => {
  it('decays before start', () => {
    expect(timeWeight(at(0), start)).toBe(1);
    expect(timeWeight(at(-20), start)).toBeCloseTo(0.3679, 4);
    expect(timeWeight(at(-60), start)).toBeCloseTo(0.0498, 4);
  });
  it('is 0.3 after start', () => expect(timeWeight(at(3), start)).toBe(0.3));
});

describe('graphWeight', () => {
  it('maps distances', () => {
    expect([0, 1, 2, 3, 4].map(graphWeight)).toEqual([1.0, 0.85, 0.65, 0.45, 0.3]);
    expect(graphWeight('unconnected')).toBe(0.08);
    expect(graphWeight('not-in-graph')).toBe(0.12);
    expect(graphWeight('no-target')).toBe(0.5);
  });
});

describe('kindWeight', () => {
  it('follows the spec tables', () => {
    expect(kindWeight('CreateTags')).toBe(0.1);
    expect(kindWeight('RevokeSecurityGroupIngress')).toBe(1);
    expect(kindWeight('ModifyRule')).toBe(0.8);
    expect(kindWeight('CreateSecurityGroup')).toBe(0.5);
    expect(kindWeight('BatchSomething')).toBe(0.6);
    expect(kindWeight('UpdateFunctionConfiguration')).toBe(0.8);
    for (const n of ['AuthorizeSecurityGroupIngress', 'RegisterTargets', 'AttachRolePolicy', 'AssociateAddress', 'EnableX']) expect(kindWeight(n)).toBe(0.5);
  });
});

const graph: GraphData = { nodes: [], edges: [], dropped: 0 };
const raw = (id: string, min: number, name = 'BatchSomething') => ({
  eventID: id, eventName: name, eventSource: 'x.amazonaws.com', eventTime: at(min).toISOString(), awsRegion: 'ap-northeast-2',
  userIdentity: { type: 'IAMUser', userName: 'kim' }, requestParameters: {},
});
const run = (rawEvents: unknown[]) => rankSuspects({ accountId: '111111111111', targetArn: null, startedAt: start, rawEvents, graph });

describe('rankSuspects', () => {
  it('breaks ties by closeness to start, then eventId', () => {
    // same score impossible by time unless same |dt|: -1 and +1 differ in weight, so use equal-time ids
    const r = run([raw('b', -5), raw('a', -5)]);
    expect(r.suspects.map((s) => s.event.eventId)).toEqual(['a', 'b']);
    expect(r.suspects.map((s) => s.rank)).toEqual([1, 2]);
  });
  it('sorts by score desc', () => {
    const r = run([raw('old', -40), raw('new', -2)]);
    expect(r.suspects[0].event.eventId).toBe('new');
    expect(r.suspects[0].score).toBe(Math.round(Math.exp(-0.1) * 0.5 * 0.6 * 10000) / 10000);
  });
  it('excludes events outside the window but counts them as seen', () => {
    const r = run([raw('early', -61), raw('late', 6), raw('ok', -59), raw('ok2', 4)]);
    expect(r.suspects.map((s) => s.event.eventId).sort()).toEqual(['ok', 'ok2']);
    expect(r.eventsSeen).toBe(4);
  });
  it('drops noise from eventsSeen and keeps 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => raw(`e${String(i).padStart(2, '0')}`, -(i % 55) - 1));
    const r = run([...many, raw('n', -1, 'PutLogEvents')]);
    expect(r.eventsSeen).toBe(60);
    expect(r.suspects).toHaveLength(50);
  });
});
