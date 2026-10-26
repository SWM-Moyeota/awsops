import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toSnapshotResources, writeSnapshotAccount, readSnapshot, listSnapshotDays, pruneSnapshots } from '../snapshots';
import { recordDailyIfMissing, resetDailyState } from '../history';
import type { Estimate, PricedResource, RawInventory, SnapshotResource } from '../types';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  process.env.COST_RADAR_DATA_DIR = dir;
  resetDailyState();
});
afterEach(() => {
  delete process.env.COST_RADAR_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const pr = (id: string, monthly: number | null): PricedResource => ({
  id, name: `n-${id}`, accountId: '1', region: 'ap-northeast-2', category: 'ec2', detail: 'm5.large', monthly, tags: { a: 'b' },
});
const sr = (id: string, monthly = 10): SnapshotResource => ({ id, name: id, category: 'ec2', monthly, detail: 'd' });

describe('snapshots', () => {
  it('toSnapshotResourcesKeepsPricedOnly', () => {
    const e = { accountId: '1', resources: [pr('a', 5), pr('b', 0), pr('c', null)], unpriced: [pr('d', null)] } as unknown as Estimate;
    expect(toSnapshotResources(e)).toEqual([{ id: 'a', name: 'n-a', category: 'ec2', monthly: 5, detail: 'm5.large' }]);
  });

  it('writeMergesAccountsInOneDay', async () => {
    await writeSnapshotAccount('2026-10-24', '1', [sr('a')]);
    await Promise.all([
      writeSnapshotAccount('2026-10-24', '2', [sr('b')]),
      writeSnapshotAccount('2026-10-24', '3', [sr('c')]),
    ]);
    const s = await readSnapshot('2026-10-24');
    expect(s?.day).toBe('2026-10-24');
    expect(Object.keys(s!.accounts).sort()).toEqual(['1', '2', '3']);
    expect(fs.readdirSync(path.join(dir, 'snapshots'))).toEqual(['2026-10-24.json']);
  });

  it('readMissingDayIsNull', async () => {
    expect(await readSnapshot('2026-01-01')).toBeNull();
  });

  it('listDaysSorted', async () => {
    expect(await listSnapshotDays()).toEqual([]);
    for (const d of ['2026-10-25', '2026-10-23', '2026-10-24']) await writeSnapshotAccount(d, '1', [sr('a')]);
    expect(await listSnapshotDays()).toEqual(['2026-10-23', '2026-10-24', '2026-10-25']);
  });

  it('prunesOlderThan40Days', async () => {
    for (const d of ['2026-09-01', '2026-09-17', '2026-09-18', '2026-10-27']) await writeSnapshotAccount(d, '1', [sr('a')]);
    await pruneSnapshots(new Date('2026-10-27T01:00:00Z')); // cutoff 2026-09-17 (KST)
    expect(await listSnapshotDays()).toEqual(['2026-09-17', '2026-09-18', '2026-10-27']);
  });

  it('dailyRecordWritesSnapshotForCompleteEstimatesOnly', async () => {
    const inv = (accountId: string, errors: RawInventory['errors']): RawInventory => ({
      accountId, volumes: [], snapshots: [], eips: [], nats: [], albs: [], nlbs: [], endpoints: [], rds: [], elasticache: [], targetGroups: [],
      instances: [{ instance_id: 'i-1', instance_type: 't3.micro', instance_state: 'running', region: 'ap-northeast-2', platform_details: 'Linux/UNIX', placement_tenancy: 'default' }],
      errors,
    });
    const now = new Date('2026-10-27T01:00:00Z');
    await recordDailyIfMissing(now, {
      accountIds: ['1', '2'],
      collectInventory: async (id) => inv(id, id === '2' ? { rds: 'denied' } : {}),
    });
    const s = await readSnapshot('2026-10-27');
    expect(Object.keys(s!.accounts)).toEqual(['1']); // account 2 has warnings -> skipped
    expect(s!.accounts['1'][0]).toMatchObject({ id: 'i-1', category: 'ec2' });
  });
});
