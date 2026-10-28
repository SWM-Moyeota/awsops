import { describe, it, expect, vi, beforeEach } from 'vitest';

const rebuildGraph = vi.fn();
vi.mock('../build', () => ({ rebuildGraph: (...a: unknown[]) => rebuildGraph(...a) }));
import { tick } from '../loop';

beforeEach(() => { rebuildGraph.mockReset(); (globalThis as { __awsopsDepGraphLoop?: unknown }).__awsopsDepGraphLoop = undefined; });

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
    const a = tick(); await tick();
    expect(rebuildGraph).toHaveBeenCalledTimes(1);
    release(); await a;
  });
});
