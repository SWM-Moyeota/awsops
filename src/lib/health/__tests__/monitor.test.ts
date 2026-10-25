import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cwSend = vi.fn(async (..._a: unknown[]) => ({}));
const getWebhookUrl = vi.fn(async (): Promise<string | null> => null);
const postSlack = vi.fn(async () => ({ ok: true }));
const postAlertViaBot = vi.fn(async (..._a: unknown[]): Promise<{ ok: boolean; error?: string }> => ({ ok: false }));
const checks = vi.hoisted(() => ({
  checkSteampipe: vi.fn(async () => ({ id: 'steampipe', ok: true, message: 'ok' })),
  checkBedrock: vi.fn(async () => ({ id: 'bedrock', ok: true, message: 'ok' })),
  checkAgentcoreRuntime: vi.fn(async () => ({ id: 'agentcore-runtime', ok: true, message: 'ok' })),
  checkLambdas: vi.fn(async () => ({ id: 'lambda', ok: true, message: 'ok' })),
  checkCrossAccount: vi.fn(async () => ({ id: 'cross-account', ok: true, message: 'ok' })),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send = cwSend; },
  PutMetricDataCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('../checks', () => checks);
vi.mock('../slack', async (orig) => ({
  ...(await orig<typeof import('../slack')>()),
  getWebhookUrl: () => getWebhookUrl(),
  postSlack: (...a: unknown[]) => postSlack(...(a as [])),
}));
vi.mock('@/lib/app-config', () => ({ getConfig: () => ({}) }));
vi.mock('@/lib/slack-chatops/alert', () => ({ postAlertViaBot: (...a: unknown[]) => postAlertViaBot(...a) }));

import {
  ensureHealthMonitorStarted, reportAgentcoreInvoke, getHealthSnapshot, runOnce,
} from '../monitor';

let tmp: string;

/** reportAgentcoreInvoke is fire-and-forget; let its microtasks settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'health-mon-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmp);
  globalThis.__awsopsHealthMonitor = undefined;
  cwSend.mockClear();
  getWebhookUrl.mockReset().mockResolvedValue(null);
  postSlack.mockClear();
  postAlertViaBot.mockReset().mockResolvedValue({ ok: false });
  for (const f of Object.values(checks)) f.mockClear();
});

afterEach(() => {
  const g = globalThis.__awsopsHealthMonitor;
  if (g?.timer) clearInterval(g.timer);
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('reportAgentcoreInvoke', () => {
  it('parallelFailuresInOneRequestCountOnce', async () => {
    reportAgentcoreInvoke('r1', 'error');
    reportAgentcoreInvoke('r1', 'error');
    reportAgentcoreInvoke('r1', 'error');
    await flush();
    expect(getHealthSnapshot().state['agentcore-invoke'].consecutiveFailures).toBe(1);
  });

  it('threeSeparateErrorRequestsTransition', async () => {
    reportAgentcoreInvoke('r1', 'error');
    reportAgentcoreInvoke('r2', 'error');
    reportAgentcoreInvoke('r3', 'error');
    await flush();
    expect(getHealthSnapshot().state['agentcore-invoke'].status).toBe('fail');
  });

  it('timeoutDoesNotCount', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) reportAgentcoreInvoke(`t${i}`, 'timeout');
    await flush();
    const s = getHealthSnapshot().state['agentcore-invoke'];
    expect(s.status).not.toBe('fail');
    expect(s.consecutiveFailures).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('successResetsAndRecovers', async () => {
    getWebhookUrl.mockResolvedValue('https://hooks.slack.com/services/T/B/SECRET');
    for (const id of ['a', 'b', 'c']) reportAgentcoreInvoke(id, 'error');
    await flush();
    reportAgentcoreInvoke('d', 'success');
    await flush();
    const s = getHealthSnapshot().state['agentcore-invoke'];
    expect(s.status).toBe('ok');
    expect(s.consecutiveFailures).toBe(0);
    expect(postSlack).toHaveBeenCalledTimes(2); // fail, then recovery
  });

  it('persistsStateFile', async () => {
    reportAgentcoreInvoke('r1', 'error');
    await flush();
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'health-status.json'), 'utf8'));
    expect(saved['agentcore-invoke'].consecutiveFailures).toBe(1);
  });
});

describe('runOnce', () => {
  it('noWebhookSkipsSendWithoutThrowing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: false, message: 'ECONNREFUSED' });
    await expect(runOnce()).resolves.toBeUndefined();
    await expect(runOnce()).resolves.toBeUndefined();
    const snap = getHealthSnapshot();
    expect(snap.state.steampipe.status).toBe('fail');
    expect(snap.lastSlack).toBeNull();
    expect(postSlack).not.toHaveBeenCalled();
    expect(snap.lastRunAt).not.toBeNull();
    // webhook-missing warning only once per process, and never contains a URL
    const webhookWarns = warn.mock.calls.filter((c) => String(c[0]).includes('webhook'));
    expect(webhookWarns).toHaveLength(1);
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: true, message: 'ok' });
  });

  it('sendsOneSlackMessagePerBatchOfTransitions', async () => {
    getWebhookUrl.mockResolvedValue('https://hooks.slack.com/services/T/B/SECRET');
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: false, message: 'down' });
    checks.checkAgentcoreRuntime.mockResolvedValue({ id: 'agentcore-runtime', ok: false, message: 'UPDATE_FAILED' });
    await runOnce();
    await runOnce();
    await flush(); // Slack is queued, not awaited, by runOnce
    expect(postSlack).toHaveBeenCalledTimes(1);
    const text = (postSlack.mock.calls[0] as unknown as [string, { text: string }])[1].text;
    expect(text).toContain('down');
    expect(text).toContain('UPDATE_FAILED');
    expect(text).toContain('https://awsops.moyeota.co.kr/');
    expect(getHealthSnapshot().lastSlack?.ok).toBe(true);
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: true, message: 'ok' });
    checks.checkAgentcoreRuntime.mockResolvedValue({ id: 'agentcore-runtime', ok: true, message: 'ok' });
  });

  it('sendsThroughBotWithAnalyzeButtonWhenAvailable', async () => {
    getWebhookUrl.mockResolvedValue('https://hooks.slack.com/services/T/B/SECRET');
    postAlertViaBot.mockResolvedValue({ ok: true });
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: false, message: 'down' });
    await runOnce();
    await runOnce();
    await flush();
    expect(postAlertViaBot).toHaveBeenCalledTimes(1);
    const [text, opts] = postAlertViaBot.mock.calls[0] as [string, { button: boolean }];
    expect(text).toContain('down');
    expect(opts).toEqual({ button: true });
    expect(postSlack).not.toHaveBeenCalled();
    expect(getHealthSnapshot().lastSlack?.ok).toBe(true);
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: true, message: 'ok' });
  });

  it('fallsBackToWebhookWhenBotPostFails', async () => {
    getWebhookUrl.mockResolvedValue('https://hooks.slack.com/services/T/B/SECRET');
    postAlertViaBot.mockResolvedValue({ ok: false, error: 'Slack bot post failed (not_in_channel)' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: false, message: 'down' });
    await runOnce();
    await runOnce();
    await flush();
    expect(postSlack).toHaveBeenCalledTimes(1);
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: true, message: 'ok' });
  });

  it('slowChecksOnlyWhenRequested', async () => {
    await runOnce();
    expect(checks.checkBedrock).not.toHaveBeenCalled();
    expect(checks.checkLambdas).not.toHaveBeenCalled();
    await runOnce({ includeSlow: true });
    expect(checks.checkBedrock).toHaveBeenCalledTimes(1);
    expect(checks.checkLambdas).toHaveBeenCalledTimes(1);
  });

  it('throwingCheckBecomesFailureNotException', async () => {
    checks.checkSteampipe.mockRejectedValueOnce(new Error('boom'));
    await expect(runOnce()).resolves.toBeUndefined();
    expect(getHealthSnapshot().state.steampipe.consecutiveFailures).toBe(1);
  });

  it('heartbeatHasNoDimensions', async () => {
    await runOnce();
    expect(cwSend).toHaveBeenCalledTimes(1);
    const input = (cwSend.mock.calls[0] as unknown as [{ input: Record<string, any> }])[0].input;
    expect(input.Namespace).toBe('AWSops/Health');
    expect(input.MetricData).toHaveLength(1);
    expect(input.MetricData[0]).toMatchObject({ MetricName: 'Heartbeat', Value: 1, Unit: 'Count' });
    expect(input.MetricData[0].Dimensions).toBeUndefined();
  });

  it('heartbeatSendHasAbortSignalTimeout', async () => {
    await runOnce();
    const opts = cwSend.mock.calls[0][1] as { abortSignal?: unknown } | undefined;
    expect(opts?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('stuckWebhookLookupNeverBlocksRunOnceOrHeartbeat', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    getWebhookUrl.mockReturnValue(new Promise<string | null>(() => {})); // never resolves
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: false, message: 'down' });
    const within = (p: Promise<unknown>) => Promise.race([
      p.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('hung'), 500)),
    ]);
    expect(await within(runOnce())).toBe('resolved');
    expect(await within(runOnce())).toBe('resolved'); // 2nd failure -> transition -> stuck Slack path
    expect(getHealthSnapshot().state.steampipe.status).toBe('fail');
    expect(cwSend).toHaveBeenCalledTimes(2);
    expect(globalThis.__awsopsHealthMonitor?.inflight).toBeNull();
    expect(await within(runOnce())).toBe('resolved'); // a later run is not blocked either
    expect(cwSend).toHaveBeenCalledTimes(3);
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: true, message: 'ok' });
  });

  it('heartbeatFailureDoesNotThrow', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    cwSend.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(runOnce()).resolves.toBeUndefined();
  });
});

describe('secrecy', () => {
  it('neverLogsWebhookUrl', async () => {
    const calls: unknown[][] = [];
    for (const k of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { calls.push(a); });
    }
    getWebhookUrl.mockResolvedValue('https://hooks.slack.com/services/T/B/SECRET');
    postSlack.mockResolvedValueOnce({ ok: false, error: 'Slack responded 404' } as never);
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: false, message: 'down' });
    await runOnce();
    await runOnce();
    await flush(); // Slack is queued, not awaited, by runOnce
    expect(postSlack).toHaveBeenCalledTimes(1);
    expect(getHealthSnapshot().lastSlack).toMatchObject({ ok: false, error: 'Slack responded 404' });
    expect(JSON.stringify(calls)).not.toContain('SECRET');
    checks.checkSteampipe.mockResolvedValue({ id: 'steampipe', ok: true, message: 'ok' });
  });
});

describe('ensureHealthMonitorStarted', () => {
  it('ensureStartedIsIdempotent', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    ensureHealthMonitorStarted();
    ensureHealthMonitorStarted();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(5 * 60 * 1000);
    await flush();
    // first run includes the slow probes
    expect(checks.checkBedrock).toHaveBeenCalledTimes(1);
    expect(checks.checkLambdas).toHaveBeenCalledTimes(1);
  });
});
