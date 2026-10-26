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

const TICKS_TO_75 = ['15', '30', '45', '60', '75'];
/** Seconds of the "(Ns)" progress statuses for `step`, in order. */
const progressSecs = (all: Array<[string, any]>, step: string) =>
  all.filter(([e, d]) => e === 'status' && d.step === step && /\(\d+s\)$/.test(d.message))
    .map(([, d]) => d.message.match(/\((\d+)s\)$/)![1]);

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

    // Up to 89.999 s: still hanging, no timeout reported, no fallback; exactly five progress ticks.
    await vi.advanceTimersByTimeAsync(44999);
    expect(mocks.reportAgentcoreInvoke).not.toHaveBeenCalled();
    expect(progressSecs(r.all, 'agentcore')).toEqual(TICKS_TO_75);
    expect(names(r.all)).not.toContain('status:fallback');
    expect(r.isDone()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5000);
    await r.pump;

    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledTimes(1);
    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledWith(expect.any(String), 'timeout');

    const n = names(r.all);
    // A '(90s)' tick may or may not land before the 90 s timeout (same-instant tie); at most one, and only '90'.
    expect([TICKS_TO_75, [...TICKS_TO_75, '90']]).toContainEqual(progressSecs(r.all, 'agentcore'));
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

  it('multiRouteKeepaliveAndTimeout', async () => {
    vi.useFakeTimers();
    mocks.bedrock.classify(['network', 'cost']);
    mocks.agent.reply('HANG');
    mocks.bedrock.stream(['MF1', 'MF2']);

    const res = await POST(aiRequest({ stream: true, messages: user('vpc and cost') }));
    const r = sseReader(res);
    const head: Array<[string, any]> = [
      ['status', { step: 'classifying', message: '🔍 Analyzing question...' }],
      ['status', { step: 'classified', route: 'network', routes: ['network', 'cost'], message: '📡 Multi-route: Network Gateway (17 tools) + Cost Gateway (9 tools)' }],
      ['status', { step: 'multi-call', message: '🤖 Calling 2 Gateways in parallel...' }],
    ];
    const tick = (sec: number): [string, any] => ['status', { step: 'multi-call', message: `🤖 Running 2 Gateways... (${sec}s)` }];

    await vi.advanceTimersByTimeAsync(14999);
    expect(r.all).toEqual(head);

    await vi.advanceTimersByTimeAsync(1);
    expect(r.all).toEqual([...head, tick(15)]);

    // Up to 89.999 s: progress every 15 s, both participants still hanging, nothing reported.
    await vi.advanceTimersByTimeAsync(74999);
    expect(r.all).toEqual([...head, tick(15), tick(30), tick(45), tick(60), tick(75)]);
    expect(mocks.reportAgentcoreInvoke).not.toHaveBeenCalled();
    expect(r.isDone()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5000);
    await r.pump;

    // Each participant times out once; both reports share ONE requestId.
    const reports = mocks.reportAgentcoreInvoke.mock.calls;
    expect(reports).toHaveLength(2);
    expect(reports.map(c => c.slice(1))).toEqual([['timeout'], ['timeout']]);
    expect(typeof reports[0][0]).toBe('string');
    expect(reports[1][0]).toBe(reports[0][0]);
    expect(mocks.agent.calls('InvokeAgentRuntimeCommand').map(c => c.payload.gateway).sort()).toEqual(['cost', 'network']);

    // A '(90s)' tick may or may not land before the 90 s timeouts (same-instant tie); at most one.
    expect([TICKS_TO_75, [...TICKS_TO_75, '90']]).toContainEqual(progressSecs(r.all, 'multi-call'));
    const fbIdx = r.all.findIndex(([e, d]) => e === 'status' && d.step === 'fallback');
    expect(fbIdx).toBeGreaterThan(-1);
    const pre = r.all.slice(0, fbIdx);
    expect([
      [...head, tick(15), tick(30), tick(45), tick(60), tick(75)],
      [...head, tick(15), tick(30), tick(45), tick(60), tick(75), tick(90)],
    ]).toContainEqual(pre);
    expect(r.all.slice(fbIdx)).toEqual([
      ['status', { step: 'fallback', message: '🔄 Gateway timeout, switching to Bedrock Direct...' }],
      ['chunk', { delta: 'MF1' }],
      ['chunk', { delta: 'MF2' }],
      ['done', {
        content: 'MF1MF2', model: 'test-label',
        via: 'Bedrock Direct (multi-route fallback: network+cost timed out)', queriedResources: [],
        route: 'network', routes: ['network', 'cost'], usedTools: [],
        inputTokens: 0, outputTokens: 0,
      }],
    ]);
    expect(mocks.bedrock.calls('stream')).toHaveLength(1);
    expect(mocks.bedrock.calls('converse')).toHaveLength(0);

    // Progress interval and both timeouts are gone; nothing arrives after done.
    expect(vi.getTimerCount()).toBe(0);
    const before = r.all.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(r.all.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledTimes(2);
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
    expect(body).toEqual({
      content: 'JSON FALLBACK', model: 'test-label', via: 'Bedrock Direct (fallback)',
      queriedResources: [], route: 'general', routes: ['general'],
    });
    expect(body).not.toHaveProperty('usedTools');
    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledTimes(1);
    expect(mocks.reportAgentcoreInvoke).toHaveBeenCalledWith(expect.any(String), 'timeout');
    expect(mocks.bedrock.calls('stream')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
