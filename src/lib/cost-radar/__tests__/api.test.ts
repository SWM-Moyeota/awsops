import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@/lib/steampipe', () => ({ runQuery: vi.fn() }));
vi.mock('@/lib/app-config', () => ({
  getConfig: () => ({ accounts: [] }),
}));

import { buildRadarResponse, getRadarResponse, resetRadarCache, parseCreatorIds, MAX_CREATOR_IDS, type RadarDeps } from '../radar';
import { recordDailyIfMissing, resetDailyState, type DailyDeps } from '../history';
import type { RawInventory } from '../types';

const A = '111111111111';
const B = '222222222222';
const NOW = new Date('2026-10-24T03:00:00Z');
const CATS = ['ec2', 'loadbalancer', 'nat', 'vpc-endpoint', 'public-ip', 'storage', 'rds', 'elasticache'];

function inv(accountId: string): RawInventory {
  return {
    accountId, instances: [], volumes: [], snapshots: [], eips: [], nats: [], albs: [], nlbs: [],
    endpoints: [], rds: [], elasticache: [], targetGroups: [], errors: {},
  };
}

function deps(over: Partial<RadarDeps> = {}): RadarDeps {
  return {
    collectInventory: vi.fn(async (id: string) => inv(id)),
    accounts: [{ accountId: A, alias: 'Host' }, { accountId: B, alias: 'Stg' }],
    readHistory: vi.fn(async () => ({ entries: [] })),
    now: NOW,
    ...over,
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-api-'));
  process.env.COST_RADAR_DATA_DIR = dir;
  resetRadarCache();
  resetDailyState();
});
afterEach(() => {
  delete process.env.COST_RADAR_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildRadarResponse', () => {
  it('allScopeUsesEveryConfiguredAccount', async () => {
    const d = deps();
    const r = await buildRadarResponse('__all__', d);
    expect(d.collectInventory).toHaveBeenCalledTimes(2);
    expect(r.estimate.accountId).toBe('__all__');
    expect(r.accounts).toEqual([{ accountId: A, alias: 'Host' }, { accountId: B, alias: 'Stg' }]);
  });

  it('single account collects only that account', async () => {
    const d = deps();
    const r = await buildRadarResponse(B, d);
    expect(d.collectInventory).toHaveBeenCalledTimes(1);
    expect(d.collectInventory).toHaveBeenCalledWith(B);
    expect(r.estimate.accountId).toBe(B);
  });

  it('collects accounts one at a time', async () => {
    let active = 0;
    let peak = 0;
    const collect = vi.fn(async (id: string) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return inv(id);
    });
    await buildRadarResponse('__all__', deps({ collectInventory: collect }));
    expect(collect).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  it('throws (500, not cached) when every category of every account failed', async () => {
    const errors = Object.fromEntries(CATS.map((k) => [k, 'e']));
    const d = deps({ collectInventory: vi.fn(async (id: string) => ({ ...inv(id), errors })) });
    await expect(buildRadarResponse('__all__', d)).rejects.toThrow();
    await expect(getRadarResponse(A, d)).rejects.toThrow();
    // one account still answering is a partial result, not a failure
    const mixed = deps({ collectInventory: vi.fn(async (id: string) => (id === A ? { ...inv(id), errors } : inv(id))) });
    const r = await buildRadarResponse('__all__', mixed);
    expect(r.estimate.warnings.length).toBeGreaterThan(0);
  });

  it('trend compares the live estimate with the entry 7 KST days earlier', async () => {
    const withNat = (id: string): RawInventory => ({
      ...inv(id),
      nats: [{ nat_gateway_id: `nat-${id}`, state: 'available', tags: null, account_id: id, region: 'ap-northeast-2' }],
    });
    const live = await buildRadarResponse(A, deps({ collectInventory: async (id) => withNat(id) }));
    const natMonthly = live.estimate.monthly;
    expect(natMonthly).toBeGreaterThan(0);
    const readHistory = vi.fn(async () => ({
      entries: [
        { accountId: A, day: '2026-10-17', monthly: natMonthly / 2, categories: {} },
        // today's early entry must be ignored in favour of the live total
        { accountId: A, day: '2026-10-24', monthly: 1, categories: {} },
      ],
    }));
    const r = await buildRadarResponse(A, deps({ collectInventory: async (id) => withNat(id), readHistory }));
    expect(r.trend).toEqual({ previousMonthly: natMonthly / 2, changePercent: 100 });
  });

  it('trend is hidden while the estimate has warnings', async () => {
    const readHistory = vi.fn(async () => ({ entries: [{ accountId: A, day: '2026-10-17', monthly: 10, categories: {} }] }));
    const collect = async (id: string): Promise<RawInventory> => ({
      ...inv(id), errors: { rds: 'denied' },
      nats: [{ nat_gateway_id: 'nat-1', state: 'available', tags: null, account_id: id, region: 'ap-northeast-2' }],
    });
    const r = await buildRadarResponse(A, deps({ collectInventory: collect, readHistory }));
    expect(r.trend).toBeNull();
  });

  it('invalidAccountIdRejected', async () => {
    for (const bad of ['abc', '12345', '111111111111; DROP', '999999999999', '']) {
      await expect(buildRadarResponse(bad, deps())).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe('getRadarResponse cache', () => {
  it('responseIsCachedFiveMinutes', async () => {
    const d = deps();
    const r1 = await getRadarResponse(A, d);
    const r2 = await getRadarResponse(A, d);
    expect(r2).toBe(r1);
    expect(d.collectInventory).toHaveBeenCalledTimes(1);
    await getRadarResponse(B, d);
    expect(d.collectInventory).toHaveBeenCalledTimes(2);
  });

  it('a failed build is not cached', async () => {
    const collect = vi.fn().mockRejectedValueOnce(new Error('boom')).mockImplementation(async (id: string) => inv(id));
    const d = deps({ collectInventory: collect });
    await expect(getRadarResponse(A, d)).rejects.toThrow('boom');
    await expect(getRadarResponse(A, d)).resolves.toBeTruthy();
    expect(collect).toHaveBeenCalledTimes(2);
  });
});

describe('parseCreatorIds', () => {
  const cfg = [A, B];
  it('creatorsEndpointCapsAt50', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `${A}:ap-northeast-2:i-${i}`).join(',');
    expect(MAX_CREATOR_IDS).toBe(50);
    expect(parseCreatorIds(ids(50), cfg)).toHaveLength(50);
    expect(() => parseCreatorIds(ids(51), cfg)).toThrowError(/50/);
  });

  it('splits on the first two colons only (ARN ids)', () => {
    const arn = 'arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:loadbalancer/app/x/abc';
    expect(parseCreatorIds(`${A}:ap-northeast-2:${arn}`, cfg)).toEqual([{ accountId: A, region: 'ap-northeast-2', resourceId: arn }]);
  });

  it('rejects missing, malformed and unconfigured', () => {
    expect(() => parseCreatorIds(null, cfg)).toThrow();
    expect(() => parseCreatorIds('', cfg)).toThrow();
    expect(() => parseCreatorIds('nope', cfg)).toThrow();
    expect(() => parseCreatorIds(`${A}:AP_NORTH:i-1`, cfg)).toThrow();
    expect(() => parseCreatorIds('333333333333:ap-northeast-2:i-1', cfg)).toThrow();
  });
});

describe('recordDailyIfMissing', () => {
  function dd(over: Partial<DailyDeps> = {}): DailyDeps {
    return { collectInventory: vi.fn(async (id: string) => inv(id)), accountIds: [A, B], ...over };
  }

  it('recordDailyIfMissingWritesOncePerDay', async () => {
    const d = dd();
    await recordDailyIfMissing(NOW, d);
    expect(d.collectInventory).toHaveBeenCalledTimes(2);
    const hist = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
    expect(hist.entries).toHaveLength(2);
    await recordDailyIfMissing(new Date(NOW.getTime() + 3600_000), d);
    expect(d.collectInventory).toHaveBeenCalledTimes(2);
  });

  it('recordDailyIfMissingNeverThrows', async () => {
    const d = dd({ collectInventory: vi.fn().mockRejectedValue(new Error('x')) });
    await expect(recordDailyIfMissing(NOW, d)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'history.json'))).toBe(false);
  });

  it('skips writing when every category errored', async () => {
    const errors = Object.fromEntries(['ec2', 'loadbalancer', 'nat', 'vpc-endpoint', 'public-ip', 'storage', 'rds', 'elasticache'].map((k) => [k, 'e']));
    const d = dd({ collectInventory: vi.fn(async (id: string) => ({ ...inv(id), errors })) });
    await recordDailyIfMissing(NOW, d);
    expect(fs.existsSync(path.join(dir, 'history.json'))).toBe(false);
  });

  it('a partial entry is marked and replaced by a later complete run the same day', async () => {
    const partial = dd({ collectInventory: vi.fn(async (id: string) => ({ ...inv(id), errors: { rds: 'denied' } })) });
    await recordDailyIfMissing(NOW, partial);
    let hist = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
    expect(hist.entries).toHaveLength(2);
    expect(hist.entries.every((e: { partial?: boolean }) => e.partial === true)).toBe(true);
    const full = dd();
    await recordDailyIfMissing(new Date(NOW.getTime() + 3600_000), full);
    expect(full.collectInventory).toHaveBeenCalledTimes(2);
    hist = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
    expect(hist.entries).toHaveLength(2);
    expect(hist.entries.some((e: { partial?: boolean }) => e.partial)).toBe(false);
    // complete entries are not collected again / 완전한 기록은 다시 수집하지 않음
    await recordDailyIfMissing(new Date(NOW.getTime() + 7200_000), full);
    expect(full.collectInventory).toHaveBeenCalledTimes(2);
  });

  it('collects accounts one at a time', async () => {
    let active = 0;
    let peak = 0;
    const collect = vi.fn(async (id: string) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return inv(id);
    });
    await recordDailyIfMissing(NOW, dd({ collectInventory: collect }));
    expect(collect).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  it('overlapping calls run once', async () => {
    const d = dd();
    await Promise.all([recordDailyIfMissing(NOW, d), recordDailyIfMissing(NOW, d)]);
    expect(d.collectInventory).toHaveBeenCalledTimes(2);
  });
});
