import { describe, it, expect } from 'vitest';
import { recordEstimate, trendFor, hasEntryForDay, type HistoryFile } from '../history';
import type { Estimate } from '../types';

function est(accountId: string, monthly: number): Estimate {
  return {
    accountId, monthly, hourly: monthly / 730,
    categories: [{ id: 'ec2', monthly, percent: 100, count: 1 }],
    resources: [], unpriced: [], warnings: [], priceAsOf: '2026-10-01',
  };
}
const D = (s: string) => new Date(s);

describe('history', () => {
  it('recordIsIdempotentPerDay', () => {
    const a = recordEstimate({ entries: [] }, est('1', 100), D('2026-10-24T01:00:00Z'));
    const b = recordEstimate(a, est('1', 200), D('2026-10-24T05:00:00Z'));
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toMatchObject({ accountId: '1', day: '2026-10-24', monthly: 100, categories: { ec2: 100 } });
    expect(hasEntryForDay(b, '1', D('2026-10-24T05:00:00Z'))).toBe(true);
    expect(hasEntryForDay(b, '2', D('2026-10-24T05:00:00Z'))).toBe(false);
  });

  it('uses the KST day', () => {
    // 16:00Z on the 24th is already the 25th in KST
    const h = recordEstimate({ entries: [] }, est('1', 1), D('2026-10-24T16:00:00Z'));
    expect(h.entries[0].day).toBe('2026-10-25');
  });

  it('historyPrunedAfter90Days', () => {
    let h: HistoryFile = { entries: [] };
    h = recordEstimate(h, est('1', 1), D('2026-06-01T00:00:00Z'));
    h = recordEstimate(h, est('1', 2), D('2026-10-24T00:00:00Z'));
    expect(h.entries.map((e) => e.day)).toEqual(['2026-10-24']);
  });

  it('trendNullWithout7DayOldEntry', () => {
    const h = recordEstimate({ entries: [] }, est('1', 100), D('2026-10-24T00:00:00Z'));
    expect(trendFor(h, ['1'], D('2026-10-24T00:00:00Z'))).toBeNull();
  });

  it('trendSumsAccountsForAll', () => {
    let h: HistoryFile = { entries: [] };
    h = recordEstimate(h, est('1', 100), D('2026-10-17T00:00:00Z'));
    h = recordEstimate(h, est('2', 100), D('2026-10-17T00:00:00Z'));
    h = recordEstimate(h, est('1', 150), D('2026-10-24T00:00:00Z'));
    h = recordEstimate(h, est('2', 150), D('2026-10-24T00:00:00Z'));
    const now = D('2026-10-24T00:00:00Z');
    expect(trendFor(h, ['1', '2'], now)).toEqual({ previousMonthly: 200, changePercent: 50 });
    expect(trendFor(h, ['1', '3'], now)).toBeNull();
  });

  it('trend null when previous sum is 0', () => {
    let h: HistoryFile = { entries: [] };
    h = recordEstimate(h, est('1', 0), D('2026-10-17T00:00:00Z'));
    h = recordEstimate(h, est('1', 5), D('2026-10-24T00:00:00Z'));
    expect(trendFor(h, ['1'], D('2026-10-24T00:00:00Z'))).toBeNull();
  });
});
