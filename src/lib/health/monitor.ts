// In-server health monitor — 5-min loop + AgentCore invoke hook, one shared result pipeline.
// 서버 안 헬스 모니터 — 5분 루프와 AgentCore 호출 훅이 같은 결과 처리 경로(processResults)를 공유한다.
// Singleton on globalThis so hot reloads / duplicate module instances never start a second timer.
import fs from 'node:fs';
import path from 'node:path';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { getConfig } from '@/lib/app-config';
import { applyResults, initialState, loadState, saveState } from './state';
import { formatSlackMessage, getWebhookUrl, postSlack } from './slack';
import { checkAgentcoreRuntime, checkBedrock, checkLambdas, checkSteampipe } from './checks';
import type { CheckId, CheckResult, HealthState, Transition } from './types';

const LOOP_INTERVAL_MS = 5 * 60 * 1000;
/** Bedrock + Lambda probes cost money: run them on the first loop and every 6th (30 min). */
const SLOW_EVERY = 6;
const REGION = 'ap-northeast-2';
const DEFAULT_DASHBOARD_URL = 'https://awsops.moyeota.co.kr/';
const MAX_TRACKED_REQUESTS = 500;
const HEARTBEAT_TIMEOUT_MS = 10_000;

type InvokeOutcome = 'success' | 'error' | 'timeout';

interface MonitorState {
  timer: NodeJS.Timeout | null;
  loopCount: number;
  state: HealthState;
  loaded: boolean;
  lastRunAt: string | null;
  lastSlack: { at: string; ok: boolean; error?: string } | null;
  inflight: Promise<void> | null;
  /** Serializes Slack sends so a fail and its recovery can't arrive out of order. */
  slackChain: Promise<void>;
  warnedNoWebhook: boolean;
  /** requestId → first recorded outcome; parallel routes of one request count once. */
  seenRequests: Map<string, 'success' | 'error'>;
}

declare global {
  // eslint-disable-next-line no-var
  var __awsopsHealthMonitor: MonitorState | undefined;
}

let cwClient: CloudWatchClient | null = null;

function monitor(): MonitorState {
  if (!globalThis.__awsopsHealthMonitor) {
    globalThis.__awsopsHealthMonitor = {
      timer: null,
      loopCount: 0,
      state: initialState(),
      loaded: false,
      lastRunAt: null,
      lastSlack: null,
      inflight: null,
      slackChain: Promise.resolve(),
      warnedNoWebhook: false,
      seenRequests: new Map(),
    };
  }
  const m = globalThis.__awsopsHealthMonitor;
  if (!m.loaded) {
    // Restore the previous run's state so a post-restart success is correctly reported as recovery.
    m.state = loadState(statePath());
    m.loaded = true;
  }
  return m;
}

function statePath(): string {
  return path.join(process.cwd(), 'data', 'health-status.json');
}

function errName(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function persist(s: HealthState): void {
  try {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    saveState(file, s);
  } catch (err) {
    console.warn(`[health] failed to persist state (${errName(err)})`);
  }
}

async function notify(m: MonitorState, transitions: Transition[], now: Date): Promise<void> {
  const url = await getWebhookUrl();
  if (!url) {
    if (!m.warnedNoWebhook) {
      m.warnedNoWebhook = true;
      console.warn('[health] Slack webhook not configured (SSM /awsops/slack-webhook-url) — alerts are not sent');
    }
    return;
  }
  const dashboardUrl = getConfig().appUrl || DEFAULT_DASHBOARD_URL;
  const res = await postSlack(url, formatSlackMessage(transitions, { dashboardUrl, now }));
  m.lastSlack = { at: now.toISOString(), ok: res.ok, ...(res.error ? { error: res.error } : {}) };
  // postSlack's error text never contains the webhook URL.
  if (!res.ok) console.warn(`[health] Slack send failed: ${res.error}`);
}

/**
 * Shared pipeline for the loop and the AgentCore hook: apply results to the state machine,
 * persist, and queue one Slack message for the whole batch of transitions. Never throws.
 * The Slack send is chained on `m.slackChain` but NOT awaited, so a slow or stuck Slack/SSM
 * path can never hold up the loop, the heartbeat, or `m.inflight`.
 * Slack 전송은 slackChain에 이어 붙이되 기다리지 않는다 — Slack/SSM이 멈춰도 루프·하트비트는 계속된다.
 */
async function processResults(results: CheckResult[], now: Date = new Date()): Promise<void> {
  try {
    const m = monitor();
    // applyResults is synchronous, so concurrent callers can't interleave a read-modify-write.
    const { next, transitions } = applyResults(m.state, results, now);
    m.state = next;
    persist(next);
    if (transitions.length > 0) {
      for (const t of transitions) console.log(`[health] ${t.id}: ${t.from} -> ${t.to} (${t.message})`);
      const send = m.slackChain.then(() => notify(m, transitions, now)).catch((err) => {
        console.warn(`[health] Slack notify failed (${errName(err)})`);
      });
      m.slackChain = send;
    }
  } catch (err) {
    console.error(`[health] processResults failed (${errName(err)})`);
  }
}

async function safeCheck(id: CheckId, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await fn();
  } catch (err) {
    return { id, ok: false, message: errName(err) };
  }
}

async function sendHeartbeat(): Promise<void> {
  try {
    cwClient ??= new CloudWatchClient({ region: REGION });
    // No Dimensions: the out-of-server watchdog queries the metric without dimensions.
    await cwClient.send(new PutMetricDataCommand({
      Namespace: 'AWSops/Health',
      MetricData: [{ MetricName: 'Heartbeat', Value: 1, Unit: 'Count' }],
    }), { abortSignal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
  } catch (err) {
    console.warn(`[health] heartbeat PutMetricData failed (${errName(err)})`);
  }
}

/** Run one round of checks. Concurrent calls share the in-flight run. Never throws. */
export async function runOnce(opts?: { includeSlow?: boolean }): Promise<void> {
  const m = monitor();
  if (m.inflight) return m.inflight;
  const run = (async () => {
    try {
      const pending: Promise<CheckResult>[] = [
        safeCheck('steampipe', checkSteampipe),
        safeCheck('agentcore-runtime', checkAgentcoreRuntime),
      ];
      if (opts?.includeSlow) {
        pending.push(safeCheck('bedrock', checkBedrock), safeCheck('lambda', checkLambdas));
      }
      const results = await Promise.all(pending);
      const now = new Date();
      m.lastRunAt = now.toISOString();
      await processResults(results, now);
      await sendHeartbeat();
    } catch (err) {
      console.error(`[health] run failed (${errName(err)})`);
    } finally {
      m.inflight = null;
    }
  })();
  m.inflight = run;
  return run;
}

async function tick(): Promise<void> {
  try {
    const m = monitor();
    const includeSlow = m.loopCount % SLOW_EVERY === 0;
    m.loopCount += 1;
    await runOnce({ includeSlow });
  } catch (err) {
    console.error(`[health] tick failed (${errName(err)})`);
  }
}

/** Start the 5-min loop once per process (idempotent). The first run starts immediately. */
export function ensureHealthMonitorStarted(): void {
  const m = monitor();
  if (m.timer) return;
  m.timer = setInterval(() => { void tick(); }, LOOP_INTERVAL_MS);
  m.timer.unref?.();
  void tick();
}

/**
 * AgentCore invocation hook (called from invokeAgentCore in /api/ai).
 * `error` counts once per requestId; `timeout` is only logged (slow tools are not an outage);
 * `success` resets the counter. Results enter the state machine immediately.
 */
export function reportAgentcoreInvoke(requestId: string, outcome: InvokeOutcome, detail?: string): void {
  try {
    if (outcome === 'timeout') {
      console.warn(`[health] AgentCore invoke timed out (request ${requestId}) — not counted as a failure`);
      return;
    }
    const m = monitor();
    const seen = m.seenRequests.get(requestId);
    // One request = one vote. A later success still clears an earlier error of the same request.
    if (seen === outcome || (seen === 'success' && outcome === 'error')) return;
    m.seenRequests.set(requestId, outcome);
    while (m.seenRequests.size > MAX_TRACKED_REQUESTS) {
      const oldest = m.seenRequests.keys().next().value;
      if (oldest === undefined) break;
      m.seenRequests.delete(oldest);
    }
    const message = outcome === 'success' ? 'ok' : (detail ? detail.slice(0, 200) : 'AgentCore invoke failed');
    void processResults([{ id: 'agentcore-invoke', ok: outcome === 'success', message }]);
  } catch (err) {
    console.error(`[health] reportAgentcoreInvoke failed (${errName(err)})`);
  }
}

export function getHealthSnapshot(): {
  state: HealthState;
  lastRunAt: string | null;
  lastSlack: { at: string; ok: boolean; error?: string } | null;
} {
  const m = monitor();
  return { state: m.state, lastRunAt: m.lastRunAt, lastSlack: m.lastSlack };
}
