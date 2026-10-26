import { describe, it, expect, vi } from 'vitest';

const findCreators = vi.hoisted(() => vi.fn());
vi.mock('@/lib/health/monitor', () => ({ ensureHealthMonitorStarted: () => {} }));
vi.mock('@/lib/change-timeline/loop', () => ({ ensureChangeTimelineStarted: () => {} }));
vi.mock('@/lib/change-timeline/query', () => ({ findCreators }));

import { GET } from '../route';

const call = (ids?: string) => GET({ nextUrl: new URL(`http://x/api/changes/creators${ids === undefined ? '' : `?ids=${encodeURIComponent(ids)}`}`) } as never);

describe('creators route', () => {
  it('rejectsTooManyIds', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `111111111111:i-${i}`).join(',');
    expect((await call(ids)).status).toBe(400);
  });
  it('rejectsMissingIds', async () => { expect((await call()).status).toBe(400); });
  it('rejectsMalformedAccount', async () => { expect((await call('123:i-1')).status).toBe(400); });
  it('rejectsBadIdCharacters', async () => {
    expect((await call('111111111111:i 1')).status).toBe(400);
    expect((await call('111111111111:a|b|c')).status).toBe(400);
  });
  it('returnsLookups', async () => {
    findCreators.mockResolvedValue([{ key: '111111111111:i-1', status: 'none' }]);
    const res = await call('111111111111:i-1|2026-01-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ key: '111111111111:i-1', status: 'none' }]);
    expect(findCreators).toHaveBeenCalledWith([{ key: '111111111111:i-1', createdAt: '2026-01-01T00:00:00Z' }]);
  });
});
