// sseEvent / simulateStreaming pin current output / 현재 출력을 고정한다
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sseEvent, simulateStreaming } from '../sse';

afterEach(() => { vi.useRealTimers(); });

describe('sseEvent', () => {
  it('formats event + JSON data with a blank-line terminator', () => {
    expect(sseEvent('status', { step: 'x', message: '한글' }))
      .toBe('event: status\ndata: {"step":"x","message":"한글"}\n\n');
  });
});

describe('simulateStreaming', () => {
  it('splits into 50-char chunks', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const text = 'a'.repeat(120);
    const p = simulateStreaming(text, send);
    await vi.runAllTimersAsync();
    await p;
    expect(send.mock.calls.map(c => c[0])).toEqual(['chunk', 'chunk', 'chunk']);
    expect(send.mock.calls.map(c => c[1].delta.length)).toEqual([50, 50, 20]);
    expect(send.mock.calls.map(c => c[1].delta).join('')).toBe(text);
  });
  it('sends nothing for empty text', async () => {
    const send = vi.fn();
    await simulateStreaming('', send);
    expect(send).not.toHaveBeenCalled();
  });
  it('exact multiple of 50 yields no trailing empty chunk', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const p = simulateStreaming('b'.repeat(100), send);
    await vi.runAllTimersAsync();
    await p;
    expect(send).toHaveBeenCalledTimes(2);
  });
});
