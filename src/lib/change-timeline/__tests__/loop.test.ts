import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ingestOnce = vi.fn();
vi.mock('../ingest', () => ({ ingestOnce: (...a: unknown[]) => ingestOnce(...a) }));

import { tick, setDailySummaryHook } from '../loop';

beforeEach(() => { globalThis.__awsopsChangeTimeline = undefined; ingestOnce.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); globalThis.__awsopsChangeTimeline = undefined; });

describe('loop', () => {
  it('tickDoesNotOverlap', async () => {
    let release!: () => void;
    ingestOnce.mockReturnValue(new Promise<void>((r) => { release = r; }));
    const first = tick();
    await tick();
    expect(ingestOnce).toHaveBeenCalledTimes(1);
    release();
    await first;
    ingestOnce.mockResolvedValue({ added: 0, failed: [] });
    await tick();
    expect(ingestOnce).toHaveBeenCalledTimes(2);
  });

  it('hookAndIngestErrorsAreIsolated', async () => {
    ingestOnce.mockRejectedValue(Object.assign(new Error('x'), { name: 'Boom' }));
    const hook = vi.fn().mockRejectedValue(new Error('h'));
    setDailySummaryHook(hook);
    await expect(tick()).resolves.toBeUndefined();
    expect(hook).toHaveBeenCalledTimes(1);
    ingestOnce.mockResolvedValue({ added: 0, failed: [] });
    await tick(); // running flag was released
    expect(ingestOnce).toHaveBeenCalledTimes(2);
  });

  it('startsOnlyInProduction', async () => {
    vi.useFakeTimers();
    ingestOnce.mockResolvedValue({ added: 0, failed: [] });
    const { ensureChangeTimelineStarted } = await import('../loop');
    vi.stubEnv('NODE_ENV', 'test');
    ensureChangeTimelineStarted();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(ingestOnce).not.toHaveBeenCalled();
    vi.stubEnv('NODE_ENV', 'production');
    ensureChangeTimelineStarted();
    ensureChangeTimelineStarted();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(ingestOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(ingestOnce).toHaveBeenCalledTimes(2);
  });
});
