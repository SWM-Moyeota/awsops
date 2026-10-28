import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { rebuildGraph, loadSnapshot, ensureGraph, collectRows, statsFor } from '../build';
import { getCurrentStore } from '../store';

const A = '111111111111';
const R = 'ap-northeast-2';
const b = { account_id: A, region: R };
const arn = (s: string) => `arn:aws:ec2:${R}:${A}:${s}`;

const run = async (q: Record<string, string>) => {
  const out: Record<string, { rows: unknown[]; error?: string }> = {};
  for (const k of Object.keys(q)) out[k] = { rows: [] };
  out.vpc = { rows: [{ arn: arn('vpc/vpc-1'), vpc_id: 'vpc-1', ...b }] };
  out.subnet = { rows: [{ subnet_arn: arn('subnet/subnet-1'), subnet_id: 'subnet-1', vpc_id: 'vpc-1', ...b }] };
  out.policy = { rows: [], error: 'denied' };
  return out;
};

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dg-')); });
afterEach(async () => {
  const s = getCurrentStore();
  if (s) await s.close();
  (globalThis as { __awsopsDepGraph?: unknown }).__awsopsDepGraph = undefined;
  await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('build', () => {
  it('collectRows reports errored queries as warnings', async () => {
    const { rows, warnings } = await collectRows(run);
    expect(warnings).toEqual(['policy']);
    expect(rows.vpc).toHaveLength(1);
  });

  it('rebuildGraph builds stats, writes snapshot, sets store', async () => {
    const snap = path.join(dir, 'graph', 'latest.json');
    const stats = await rebuildGraph({ run, snapshotPath: snap });
    expect(stats.warnings).toEqual(['policy']);
    expect(stats.nodeCounts).toEqual({ vpc: 1, subnet: 1 });
    expect(stats.edgeCount).toBe(1);
    expect(getCurrentStore()?.stats().builtAt).toBe(stats.builtAt);
    const f = JSON.parse(await fs.readFile(snap, 'utf8'));
    expect(f.version).toBe(1);
    expect((await fs.readdir(path.dirname(snap)))).toEqual(['latest.json']);

    (globalThis as { __awsopsDepGraph?: unknown }).__awsopsDepGraph = undefined;
    expect(await loadSnapshot(snap)).toBe(true);
    expect(getCurrentStore()?.stats().builtAt).toBe(stats.builtAt);
  });

  it('loadSnapshot rejects other versions and malformed files', async () => {
    const p = path.join(dir, 'x.json');
    await fs.writeFile(p, JSON.stringify({ version: 2 }));
    expect(await loadSnapshot(p)).toBe(false);
    await fs.writeFile(p, '{nope');
    expect(await loadSnapshot(p)).toBe(false);
    expect(await loadSnapshot(path.join(dir, 'missing.json'))).toBe(false);
    expect(getCurrentStore()).toBeNull();
  });

  it('ensureGraph starts one rebuild and returns null', async () => {
    const rebuild = vi.fn(() => new Promise<unknown>(() => {}));
    const snapshotPath = path.join(dir, 'none.json');
    expect(await ensureGraph({ snapshotPath, rebuild })).toBeNull();
    expect(await ensureGraph({ snapshotPath, rebuild })).toBeNull();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('rebuildGraph rejects when run rejects', async () => {
    await expect(rebuildGraph({ run: async () => { throw new Error('x'); }, snapshotPath: path.join(dir, 's.json') })).rejects.toThrow();
  });

  it('statsFor counts only present types', () => {
    const s = statsFor({ nodes: [], edges: [], dropped: 2 }, ['a'], new Date(0));
    expect(s).toEqual({ builtAt: new Date(0).toISOString(), nodeCounts: {}, edgeCount: 0, dropped: 2, warnings: ['a'] });
  });
});
