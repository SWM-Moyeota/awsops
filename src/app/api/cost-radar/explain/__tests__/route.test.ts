import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ExplainResponse } from '@/lib/cost-radar/types';

const explainChange = vi.fn();
vi.mock('@/lib/cost-radar/explain', () => ({ explainChange: (...a: unknown[]) => explainChange(...a) }));
vi.mock('@/lib/health/monitor', () => ({ ensureHealthMonitorStarted: vi.fn() }));

import { GET } from '../route';
import { RadarInputError } from '@/lib/cost-radar/radar';

const OK: ExplainResponse = {
  mode: 'timeline-only', days: 7, fromDay: '2026-10-20', accountId: '__all__',
  baseMonthly: null, currentMonthly: 10, delta: null, causes: [], unexplained: null, notes: [],
};
const req = (qs: string) => new NextRequest(`http://localhost/api/cost-radar/explain${qs}`);

beforeEach(() => {
  explainChange.mockReset();
  explainChange.mockResolvedValue(OK);
});

describe('GET /api/cost-radar/explain', () => {
  it('defaults to all accounts and 7 days with no-store', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual(OK);
    expect(explainChange.mock.calls[0][0]).toEqual({ accountId: '__all__', days: 7 });
  });

  it('passes accountId and days through', async () => {
    for (const days of [1, 7, 30]) {
      explainChange.mockClear();
      const res = await GET(req(`?accountId=111111111111&days=${days}`));
      expect(res.status).toBe(200);
      expect(explainChange.mock.calls[0][0]).toEqual({ accountId: '111111111111', days });
    }
  });

  it('rejects bad input with 400', async () => {
    for (const qs of ['?accountId=123', '?accountId=abcdefghijkl', '?days=2', '?days=abc', '?days=7.0', '?days=-7', '?days=constructor', '?days=__proto__']) {
      const res = await GET(req(qs));
      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(explainChange).not.toHaveBeenCalled();
  });

  it('an unconfigured account is a 400', async () => {
    explainChange.mockRejectedValue(new RadarInputError('invalid accountId'));
    const res = await GET(req('?accountId=999999999999'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns only the error name on failure', async () => {
    explainChange.mockRejectedValue(new TypeError('secret path /data/x'));
    const res = await GET(req(''));
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'TypeError' });
  });
});
