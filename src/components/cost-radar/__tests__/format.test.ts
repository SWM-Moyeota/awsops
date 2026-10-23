import { describe, it, expect } from 'vitest';
import {
  formatMoney, splitMoney, formatShort, donutGradient, trendLabel, creatorKey, displayName, shortId,
  visibleRecommendations, splitTemplate, minutesSince, reasonParams, CATEGORY_COLORS,
} from '../format';
import type { Recommendation } from '@/lib/cost-radar/types';

const rec = (over: Partial<Recommendation>): Recommendation => ({
  id: 'x', rule: 'unused-eip', resourceId: 'eipalloc-1', accountId: '111111111111', region: 'ap-northeast-2',
  params: {}, monthlySaving: 0, countedInTotal: true, cliCommand: '', consoleUrl: '', tags: {}, ...over,
});

describe('money formatting', () => {
  it('formats with two decimals and thousands separators', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
    expect(formatMoney(0)).toBe('$0.00');
  });
  it('never yields NaN', () => {
    expect(formatMoney(NaN)).toBe('$0.00');
    expect(formatMoney(null)).toBe('$0.00');
    expect(formatMoney(undefined)).toBe('$0.00');
    expect(formatShort(NaN)).toBe('$0');
  });
  it('splits whole and cents', () => {
    expect(splitMoney(268.4)).toEqual({ whole: '$268', cents: '.40' });
    expect(splitMoney(0)).toEqual({ whole: '$0', cents: '.00' });
  });
  it('short format rounds dollars and keeps cents below $1', () => {
    expect(formatShort(85.4)).toBe('$85');
    expect(formatShort(0.5)).toBe('$0.50');
    expect(formatShort(0)).toBe('$0');
    expect(formatShort(1640)).toBe('$1,640');
  });
});

describe('donutGradient', () => {
  it('is a flat ring when total is zero or empty', () => {
    expect(donutGradient([])).toBe('conic-gradient(#232327 0 100%)');
    expect(donutGradient([{ id: 'ec2', monthly: 0 }])).toBe('conic-gradient(#232327 0 100%)');
    expect(donutGradient([{ id: 'ec2', monthly: 0 }])).not.toContain('NaN');
  });
  it('uses amounts and closes at 100%', () => {
    const g = donutGradient([{ id: 'ec2', monthly: 75 }, { id: 'nat', monthly: 25 }]);
    expect(g).toBe(`conic-gradient(${CATEGORY_COLORS.ec2} 0% 75%, ${CATEGORY_COLORS.nat} 75% 100%)`);
  });
  it('closes at exactly 100% with awkward fractions', () => {
    const g = donutGradient([{ id: 'ec2', monthly: 1 }, { id: 'nat', monthly: 1 }, { id: 'storage', monthly: 1 }]);
    expect(g.endsWith('100%)')).toBe(true);
  });
});

describe('labels', () => {
  it('trend label has a sign', () => {
    expect(trendLabel(12.4)).toBe('+12%');
    expect(trendLabel(-8)).toBe('-8%');
    expect(trendLabel(0)).toBe('0%');
  });
  it('creator key is accountId:region:resourceId', () => {
    expect(creatorKey(rec({}))).toBe('111111111111:ap-northeast-2:eipalloc-1');
  });
  it('display name prefers Name tag, then name param, then a short id', () => {
    expect(displayName(rec({ tags: { Name: 'web' } }))).toBe('web');
    expect(displayName(rec({ params: { name: 'tg-a' } }))).toBe('tg-a');
    expect(displayName(rec({ resourceId: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:targetgroup/my-tg/abc' }))).toBe('my-tg');
    expect(shortId('vol-123')).toBe('vol-123');
  });
  it('splits templates into text and keys', () => {
    expect(splitTemplate('You could save {amount}')).toEqual([{ text: 'You could save ' }, { key: 'amount' }]);
    expect(splitTemplate('{a} and {b}.')).toEqual([{ key: 'a' }, { text: ' and ' }, { key: 'b' }, { text: '.' }]);
  });
  it('minutes since is never negative', () => {
    expect(minutesSince(1000, 0)).toBe(0);
    expect(minutesSince(0, 125000)).toBe(2);
  });
});

describe('visibleRecommendations', () => {
  it('keeps savings, notes and empty target groups, sorted by saving desc', () => {
    const out = visibleRecommendations([
      rec({ id: 'a', monthlySaving: 3 }),
      rec({ id: 'b', monthlySaving: 0 }),
      rec({ id: 'c', monthlySaving: 0, rule: 'empty-tg' }),
      rec({ id: 'd', monthlySaving: 0, note: 'maybe-scaled-to-zero', countedInTotal: false }),
      rec({ id: 'e', monthlySaving: 9 }),
    ]);
    expect(out.map(r => r.id)).toEqual(['e', 'a', 'c', 'd']);
  });
});

describe('reasonParams', () => {
  it('formats money and dates, keeps the rest', () => {
    expect(reasonParams(rec({ params: { monthly: 121.2, hoursPerWeek: 50 } }))).toEqual({ monthly: '$121.20', hoursPerWeek: 50 });
    expect(reasonParams(rec({ params: { days: 23, since: '2026-10-01T03:00:00.000Z' } }))).toEqual({ days: 23, since: '2026-10-01' });
  });
});
