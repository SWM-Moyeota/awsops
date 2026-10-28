import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';

const rebuildGraph = vi.fn();
const loadSnapshot = vi.fn();
// Real runBuildOnce / ensureGraph; only the expensive steps are mocked (no PGlite is created).
// runBuildOnce·ensureGraph는 실제 코드, 무거운 단계만 mock — PGlite를 만들지 않는다.
vi.mock('../build', async (orig) => ({
  ...(await orig<typeof import('../build')>()),
  rebuildGraph: (...a: unknown[]) => rebuildGraph(...a),
  loadSnapshot: (...a: unknown[]) => loadSnapshot(...a),
}));
import { tick, ensureDepGraphStarted, BUILD_INTERVAL_MS } from '../loop';
import { ensureGraph } from '../build';

const reset = () => {
  const g = globalThis as { __awsopsDepGraphLoop?: unknown; __awsopsDepGraphBuild?: unknown; __awsopsDepGraph?: unknown };
  g.__awsopsDepGraphLoop = undefined;
  g.__awsopsDepGraphBuild = undefined;
  g.__awsopsDepGraph = undefined;
};
const missing = path.join(os.tmpdir(), 'dg-loop-none', 'latest.json');

beforeEach(() => { rebuildGraph.mockReset(); loadSnapshot.mockReset(); reset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); reset(); });

describe('tick', () => {
  it('swallows failures and logs the error name only', async () => {
    rebuildGraph.mockRejectedValue(new TypeError('secret detail'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(tick()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('[dep-graph] build failed:', 'TypeError');
  });
  it('does not overlap', async () => {
    let release!: () => void;
    rebuildGraph.mockReturnValue(new Promise<unknown>((r) => { release = () => r({ nodeCounts: {}, edgeCount: 0 }); }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = tick(); const b = tick();
    await Promise.resolve();
    expect(rebuildGraph).toHaveBeenCalledTimes(1);
    release(); await a; await b;
  });
});

describe('one build at a time across tick and ensureGraph', () => {
  it('tick first: ensureGraph joins instead of building', async () => {
    let release!: () => void;
    rebuildGraph.mockReturnValue(new Promise<unknown>((r) => { release = () => r({ nodeCounts: {}, edgeCount: 0 }); }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const rebuild = vi.fn(async () => undefined);
    const t = tick();
    await Promise.resolve();
    expect(await ensureGraph({ snapshotPath: missing, rebuild })).toBeNull();
    expect(rebuildGraph).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    release(); await t;
  });
  it('ensureGraph first: tick joins instead of building', async () => {
    let release!: () => void;
    const rebuild = vi.fn(() => new Promise<void>((r) => { release = r; }));
    expect(await ensureGraph({ snapshotPath: missing, rebuild })).toBeNull();
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    const t = tick();
    await Promise.resolve();
    expect(rebuildGraph).not.toHaveBeenCalled();
    release(); await t;
  });
  it('tick ignores the ensureGraph cooldown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    rebuildGraph.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({ nodeCounts: {}, edgeCount: 0 });
    await tick();
    await tick();
    expect(rebuildGraph).toHaveBeenCalledTimes(2);
  });
});

describe('ensureDepGraphStarted scheduling', () => {
  it('production: snapshot at boot, first tick at 60 s, then every 15 min', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    loadSnapshot.mockResolvedValue(true);
    rebuildGraph.mockResolvedValue({ nodeCounts: {}, edgeCount: 0 });
    ensureDepGraphStarted();
    ensureDepGraphStarted(); // idempotent / 두 번 불러도 한 번
    await vi.advanceTimersByTimeAsync(0);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(rebuildGraph).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(rebuildGraph).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuildGraph).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BUILD_INTERVAL_MS - 1);
    expect(rebuildGraph).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rebuildGraph).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BUILD_INTERVAL_MS);
    expect(rebuildGraph).toHaveBeenCalledTimes(3);
    expect(BUILD_INTERVAL_MS).toBe(900_000);
  });
  it('boot snapshot failure is swallowed and logged by name', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'production');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadSnapshot.mockRejectedValue(new SyntaxError('secret'));
    ensureDepGraphStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(err).toHaveBeenCalledWith('[dep-graph] snapshot load failed:', 'SyntaxError');
  });
  it('outside production nothing runs', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'test');
    ensureDepGraphStarted();
    await vi.advanceTimersByTimeAsync(3 * BUILD_INTERVAL_MS);
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(rebuildGraph).not.toHaveBeenCalled();
  });
});
