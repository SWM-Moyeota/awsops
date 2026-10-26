import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ChangesResponse } from '@/lib/change-timeline/types';

const queryChanges = vi.fn();
vi.mock('@/lib/change-timeline/query', () => ({ queryChanges: (...a: unknown[]) => queryChanges(...a) }));

import { GET } from '../route';

const EMPTY: ChangesResponse = {
  records: [], summary: { creates: 0, deletes: 0, people: 0 }, facets: { people: [], resourceTypes: [] },
  status: { coverageFrom: null, lastIngestAt: null, backfilling: false, failedAccounts: [] }, truncated: false,
};
const req = (qs: string) => new NextRequest(`http://localhost/api/changes${qs}`);

beforeEach(() => {
  queryChanges.mockReset();
  queryChanges.mockResolvedValue(EMPTY);
});

describe('GET /api/changes', () => {
  it('defaults to all accounts and 7 days with no-store', async () => {
    const res = await GET(req(''));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(queryChanges.mock.calls[0][0]).toEqual({ accountId: '__all__', range: '7d' });
  });
  it('passes the filters through', async () => {
    await GET(req('?accountId=111111111111&range=30d&kind=delete&actor=sungyoon&type=s3-bucket&q=%20logs%20'));
    expect(queryChanges.mock.calls[0][0]).toEqual({
      accountId: '111111111111', range: '30d', kind: 'delete', actor: 'sungyoon', resourceType: 's3-bucket', q: 'logs',
    });
  });
  it('wires tracked event names per region', async () => {
    await GET(req(''));
    const { namesFor } = queryChanges.mock.calls[0][1];
    expect(namesFor('ap-northeast-2')).toContain('CreateBucket');
    expect(namesFor('eu-west-1')).toEqual([]);
  });
  it('rejects bad input with 400', async () => {
    for (const qs of ['?accountId=123', '?accountId=abcdefghijkl', '?range=1y', '?kind=update', '?type=sqs-queue']) {
      const res = await GET(req(qs));
      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(queryChanges).not.toHaveBeenCalled();
  });
  it('returns only the error name on failure', async () => {
    const err = new TypeError('secret path /data/x');
    queryChanges.mockRejectedValue(err);
    const res = await GET(req(''));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'TypeError' });
  });
});
