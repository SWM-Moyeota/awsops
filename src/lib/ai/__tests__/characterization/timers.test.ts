// Characterization tests — timers (15 s keepalive, 90 s AgentCore timeout) of /api/ai. FROZEN after Task 2: do not edit.
// 특성 테스트 — 타이머(15초 keepalive, 90초 AgentCore 타임아웃). 현재 동작을 그대로 고정한다.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupAiMocks, aiRequest, readJson } from './harness';
import { POST } from '@/app/api/ai/route';

const mocks = setupAiMocks();

afterEach(() => { vi.useRealTimers(); });

const user = (content: string) => [{ role: 'user', content }];

/** Incremental SSE reader: events() returns everything parsed since the last call. */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let finished = false;
  const all: Array<[string, any]> = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { finished = true; return; }
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        let event = 'message'; let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (block.trim()) all.push([event, data ? JSON.parse(data) : undefined]);
      }
    }
  })();
  return { all, pump, isDone: () => finished };
}

const names = (all: Array<[string, any]>) => all.map(([e, d]) => (e === 'status' ? `status:${d.step}` : e));

describe('/api/ai timers (characterization)', () => {
  it('gatewayTimeoutAndKeepalive (stream)', async () => {
    vi.useFakeTimers();
    mocks.agent.reply('HANG');
    mocks.bedrock.stream(['FB1', 'FB2']);

    const res = await POST(aiRequest({ stream: true, messages: user('hello there') }));
    const r = sseReader(res);

    await vi.advanceTimersByTimeAsync(14999);
    expect(names(r.all)).toEqual(['status:classifying', 'status:classified', 'status:agentcore']);
    expect(r.all.some(([, d]) => d?.message?.includes('Running'))).toBe(false);
    expect(mocks.reportAgentcoreInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const keeps = r.all.filter(([e, d]) => e === 'status' && d.step === 'agentcore');
    expect(keeps.map(([, d]) => d.message)).toEqual([
      '🤖 Calling Ops Gateway (9 tools) tools...',
      '🤖 Running Ops Gateway (9 tools) tools... (15s)',
    ]);

    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(15000);
    const msgs = r.all.filter(([e, d]) => e === 'status' && d.step === 'agentcore').map(([, d]) => d.message);
    expect(msgs.slice(2)).toEqual([
      '🤖 Running Ops Gateway (9 tools) tools... (30s)',
      '🤖 Running Ops Gateway (9 tools) tools... (45s)',
    ]);

    // Up to 89.999 s: still hanging, no timeout reported, no fallback.
    await vi.advanceTimersByTimeAsync(44999);
    expect(mocks.reportAgentcoreInvoke).not.toHaveBeenCalled();
    expect(names(r.all)).not.toContain('status:fallback');
    expect(r.isDone()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5000);
    await r.pump;

    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledTimes(1);
    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledWith(expect.any(String), 'timeout');

    const n = names(r.all);
    const agentcoreProgress = r.all.filter(([e, d]) => e === 'status' && d.step === 'agentcore' && d.message.includes('Running'));
    expect(agentcoreProgress.map(([, d]) => d.message.match(/\((\d+)s\)/)![1])).toEqual(['15', '30', '45', '60', '75', '90']);
    const fbIdx = n.indexOf('status:fallback');
    expect(fbIdx).toBeGreaterThan(-1);
    expect(r.all[fbIdx][1].message).toBe('🔄 Bedrock Direct fallback...');
    const tail = n.slice(fbIdx);
    expect(tail[0]).toBe('status:fallback');
    expect(tail.slice(1, -1).every(e => e === 'chunk')).toBe(true);
    expect(tail[tail.length - 1]).toBe('done');
    const done = r.all[r.all.length - 1][1];
    expect(done.content).toBe('FB1FB2');
    expect(done.via).toBe('Bedrock Direct (fallback from Ops Gateway (9 tools))');
    expect(mocks.agent.calls('InvokeAgentRuntimeCommand')).toHaveLength(1);
    expect(mocks.bedrock.calls('stream')).toHaveLength(1);
    expect(mocks.recordCall).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'bedrock-fallback', success: false }));
  });

  it('keepaliveIntervalsAreClearedAfterDone', async () => {
    vi.useFakeTimers();
    mocks.agent.reply('HANG');
    const res = await POST(aiRequest({ stream: true, messages: user('hello there') }));
    const r = sseReader(res);
    await vi.advanceTimersByTimeAsync(95000);
    await r.pump;
    expect(names(r.all)[names(r.all).length - 1]).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    const before = r.all.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(r.all.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keepaliveStopsWhenAgentAnswersBefore15s', async () => {
    vi.useFakeTimers();
    mocks.agent.reply('FAST ANSWER');
    const res = await POST(aiRequest({ stream: true, messages: user('hello there') }));
    const r = sseReader(res);
    await vi.advanceTimersByTimeAsync(5000);
    await r.pump;
    const before = r.all.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(r.all.length).toBe(before);
    expect(r.all.some(([, d]) => d?.message?.includes('Running'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('gatewayTimeoutJsonPath', async () => {
    vi.useFakeTimers();
    mocks.agent.reply('HANG');
    mocks.bedrock.text('JSON FALLBACK');
    const p = POST(aiRequest({ stream: false, messages: user('hello there') })).then(readJson);
    await vi.advanceTimersByTimeAsync(89999);
    expect(mocks.reportAgentcoreInvoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const { status, body } = await p;

    expect(status).toBe(200);
    expect(body.content).toBe('JSON FALLBACK');
    expect(body.via).toContain('Bedrock Direct');
    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledTimes(1);
    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledWith(expect.any(String), 'timeout');
    expect(mocks.bedrock.calls('stream')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
