import { describe, it, expect } from 'vitest';
import { createLimiter, createRecentSet } from '../concurrency';

describe('createLimiter', () => {
  it('runsAtMostMaxTasksAtOnce', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const task = () => limit(async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5));
      running -= 1;
    });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('keepsGoingAfterARejectedTask', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(limit(async () => 7)).resolves.toBe(7);
  });
});

describe('createRecentSet', () => {
  it('remembersRecentIdsAndForgetsOldest', () => {
    const s = createRecentSet(2);
    expect(s.addIfNew('a')).toBe(true);
    expect(s.addIfNew('a')).toBe(false);
    s.addIfNew('b');
    s.addIfNew('c');
    expect(s.addIfNew('a')).toBe(true);
  });
});
