import { describe, it, expect, vi } from 'vitest';
import { queries as relQ } from '@/lib/queries/relationships';
import { collectRows } from '../collect';

describe('collectRows', () => {
  it('fails with a name when a core source fails', async () => {
    const q = vi.fn(async (sql: string) => (sql === relQ.routeTables ? { rows: [], error: 'denied' } : { rows: [] }));
    await expect(collectRows(q, true)).rejects.toMatchObject({ name: 'DiagramQueryFailed' });
  });
  it('skips optional sources that fail or throw, and names them', async () => {
    const q = vi.fn(async (sql: string) => {
      if (sql === relQ.msk) return { rows: [], error: 'no table' };
      if (sql === relQ.s3Buckets) throw new Error('boom');
      return { rows: [{ ok: 1 }] };
    });
    const r = await collectRows(q, true);
    expect(r.skipped.sort()).toEqual(['msk', 's3']);
    expect(r.rows.msk).toBeUndefined();
    expect(r.rows.rds).toEqual([{ ok: 1 }]);
  });
  it('does not read account-wide lists when they are hidden, but keeps CloudFront', async () => {
    const q = vi.fn(async () => ({ rows: [] }));
    await collectRows(q, false);
    const sqls = q.mock.calls.map(c => (c as unknown as string[])[0]);
    expect(sqls).not.toContain(relQ.s3Buckets);
    expect(sqls).toContain(relQ.diagramCloudfront);
  });
});
