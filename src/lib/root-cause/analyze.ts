// Incident analysis: CloudTrail write events -> merged graph -> ranked suspects -> cited AI explanation; serial queue; manual runs.
// 사건 분석 — CloudTrail 쓰기 이벤트 → 합친 그래프 → 용의자 순위 → 인용 검증 AI 설명. 직렬 큐, 수동 분석.
import { withCap } from '@/lib/with-cap';
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { accountCredentials, cloudTrailSlot } from '@/lib/cloudtrail-access';
import type { LookupFn } from '@/lib/change-timeline/ingest';
import { listHistory as defaultListHistory } from '@/lib/dep-graph/build';
import { getCurrentStore } from '@/lib/dep-graph/store';
import type { GraphData } from '@/lib/dep-graph/types';
import { recordAndSave } from '@/lib/ai/stats';
import { getAccountById, getBedrockModelLabel } from '@/lib/app-config';
import { findNode, mergeGraphs } from './graph';
import { rankSuspects } from './rank';
import { buildBundle } from './bundle';
import { explain } from './explain';
import { newIncidentId } from './incidents';
import { rootCauseState, updateIncidents } from './store';
import type { Analysis, GraphSnapshot, Incident } from './types';

const SESSION = 'awsops-root-cause';
const MAX_PAGES = 10;
const BEFORE_MS = 60 * 60_000;
const AFTER_MS = 5 * 60_000;
const GLOBAL_REGION = 'us-east-1';
const MANUAL_COOLDOWN_MS = 30_000;
const MANUAL_FUTURE_MS = 2 * 60_000;
const MANUAL_MAX_AGE_MS = 7 * 86_400_000;
const MANUAL_TIMEOUT_MS = 120_000;
const DEFAULT_REGION = 'ap-northeast-2';
const LOOKUP_TIMEOUT_MS = 20_000;
const JOB_CAP_MS = 180_000;

const errName = (e: unknown) => (e instanceof Error ? e.name : 'Error');
// withCap lives in a shared module; re-exported for existing importers / withCap은 공용 모듈로 옮기고 기존 import를 위해 다시 내보냄
export { withCap };
function namedError(name: string, message = name): Error { const e = new Error(message); e.name = name; return e; }

// Write events only (ReadOnly=false), 50 per page; creds first, then the shared slot, new client per call.
// 쓰기 이벤트만, 페이지당 50개 — 자격증명 먼저, 그다음 공용 슬롯, 호출마다 새 클라이언트.
export const defaultLookup: LookupFn = async (accountId, region, p) => {
  const creds = await accountCredentials(accountId, SESSION);
  await cloudTrailSlot(accountId, region);
  const client = new CloudTrailClient({ region, ...(creds ? { credentials: creds } : {}) });
  const res = await client.send(new LookupEventsCommand({
    StartTime: p.start,
    EndTime: p.end,
    MaxResults: 50,
    NextToken: p.nextToken,
    LookupAttributes: [{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }],
  }), { abortSignal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) }); // a hung call must not stall the queue / 멈춘 호출이 큐를 막지 않게
  return { events: (res.Events ?? []).map((e) => ({ CloudTrailEvent: e.CloudTrailEvent })), nextToken: res.NextToken };
};

/** Up to 10 pages for one region; parses CloudTrailEvent JSON; errors -> failed with events so far. / 리전당 최대 10페이지, 오류면 그때까지의 이벤트와 failed. */
export async function lookupWriteEvents(accountId: string, region: string, from: Date, to: Date, deps: { lookup?: LookupFn } = {}): Promise<{ events: unknown[]; truncated: boolean; failed: boolean }> {
  const lookup = deps.lookup ?? defaultLookup;
  const events: unknown[] = [];
  let token: string | undefined;
  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await lookup(accountId, region, { start: from, end: to, nextToken: token });
      for (const e of page.events) {
        if (typeof e.CloudTrailEvent !== 'string') continue;
        try { events.push(JSON.parse(e.CloudTrailEvent)); } catch { /* skip malformed / 깨진 이벤트 건너뜀 */ }
      }
      token = page.nextToken;
      if (!token) return { events, truncated: false, failed: false };
    }
    return { events, truncated: true, failed: false };
  } catch (e) {
    console.error('[root-cause] lookup failed:', errName(e));
    return { events, truncated: false, failed: true };
  }
}

// Usage record callback shape from explain(). / explain()의 사용량 기록 콜백 형태.
type UsageRecord = { inputTokens: number; outputTokens: number; ms: number; ok: boolean };
export interface AnalyzeDeps {
  lookup?: LookupFn;
  listHistory?: () => Promise<GraphSnapshot[]>;
  currentData?: () => GraphData | null;
  invoke?: NonNullable<Parameters<typeof explain>[1]>['invoke'];
  record?: (r: UsageRecord) => void;
  now?: () => Date;
  userId?: string;
}

const currentGraph = (): GraphData | null => getCurrentStore()?.data() ?? null;

/** Analyze one incident; region and AI failures are recorded, never thrown. / 리전·AI 실패는 기록만 하고 throw하지 않는다. */
export async function analyzeIncident(inc: Incident, deps: AnalyzeDeps = {}): Promise<Analysis> {
  const now = deps.now?.() ?? new Date();
  const start = new Date(inc.startedAt);
  const windowFrom = new Date(start.getTime() - BEFORE_MS);
  const windowTo = new Date(start.getTime() + AFTER_MS);
  const lookupTo = new Date(Math.min(windowTo.getTime(), Math.max(now.getTime(), windowFrom.getTime())));
  const regions = Array.from(new Set([inc.region, GLOBAL_REGION]));
  const rawEvents: unknown[] = [];
  const seenIds = new Set<string>();
  const failedRegions: string[] = [];
  let truncated = false;
  for (const region of regions) {
    const r = await lookupWriteEvents(inc.accountId, region, windowFrom, lookupTo, { lookup: deps.lookup });
    // Drop repeats of the same eventID across regions/pages. / 리전·페이지 사이 같은 eventID 중복 제거.
    for (const e of r.events) {
      const id = e && typeof e === 'object' ? (e as { eventID?: unknown }).eventID : undefined;
      if (typeof id === 'string') { if (seenIds.has(id)) continue; seenIds.add(id); }
      rawEvents.push(e);
    }
    if (r.truncated) truncated = true;
    if (r.failed) failedRegions.push(region);
  }
  const history = await (deps.listHistory ?? (() => defaultListHistory()))().catch(() => [] as GraphSnapshot[]);
  const merged = mergeGraphs(history, windowFrom, start, (deps.currentData ?? currentGraph)());
  const { suspects, eventsSeen } = rankSuspects({ accountId: inc.accountId, targetArn: inc.resourceArn, startedAt: start, rawEvents, graph: merged.data });
  const bundle = buildBundle({ signals: inc.signals, resourceName: inc.resourceName ?? inc.resourceArn, startedAt: inc.startedAt, graph: { from: merged.from, to: merged.to } }, suspects);
  const userId = deps.userId ?? 'system';
  const record = deps.record ?? ((r: UsageRecord) => recordAndSave({
    route: 'root-cause', gateway: 'bedrock', responseTimeMs: r.ms, usedTools: [], success: r.ok, via: 'Bedrock Direct',
    question: `장애 원인 분석: ${inc.resourceName ?? inc.resourceArn ?? inc.accountId}`, summary: `suspects ${suspects.length}`,
    userId, inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: getBedrockModelLabel(),
  }));
  let ai: Analysis['ai'];
  try { ai = await explain(bundle, { invoke: deps.invoke, record }); } catch (e) {
    console.error('[root-cause] explain threw:', errName(e));
    ai = { status: 'failed', droppedCitations: 0 };
  }
  return {
    analyzedAt: now.toISOString(), windowFrom: windowFrom.toISOString(), windowTo: windowTo.toISOString(),
    graph: { from: merged.from, to: merged.to, count: merged.count }, eventsSeen, truncated, failedRegions, suspects, ai,
  };
}

/** Process-wide serial chain: one analysis at a time (shares CloudTrail slots with ingest), each capped at 180 s. / 프로세스 전체에서 한 번에 하나씩, 작업당 180초 상한. */
export function enqueueAnalysis<T>(fn: () => Promise<T>): Promise<T> {
  const s = rootCauseState();
  const p = s.queue.then(() => withCap(fn, JOB_CAP_MS));
  s.queue = p.catch(() => undefined);
  return p;
}

/** Store an analysis on its incident; returns the saved incident (null if it fell off the list). / 분석을 사건에 저장. */
export async function saveAnalysis(id: string, analysis: Analysis, update: (fn: (list: Incident[]) => Incident[]) => Promise<Incident[]> = updateIncidents): Promise<Incident | null> {
  const list = await update((l) => l.map((i) => (i.id === id ? { ...i, analysis } : i)));
  return list.find((i) => i.id === id) ?? null;
}

export interface ManualDeps extends AnalyzeDeps { analyze?: (inc: Incident) => Promise<Analysis>; timeoutMs?: number }

/**
 * Manual analysis: RateLimited (<30 s since the last run), NotFound (ARN in neither current graph nor history),
 * BadTime (>2 min ahead, >7 days old, unparseable). Waits for the queue up to 120 s (Timeout); the run is saved anyway.
 * 수동 분석 — 30초 제한, 그래프·이력에 없으면 NotFound, 시각 오류 BadTime. 최대 120초 대기(Timeout), 분석은 계속 돌아 저장된다.
 */
export async function manualAnalyze(req: { accountId: string; resourceArn: string | null; at?: string; userId?: string }, deps: ManualDeps = {}): Promise<Incident> {
  const s = rootCauseState();
  const now = deps.now?.() ?? new Date();
  const prev = s.lastManualAt;
  if (now.getTime() - prev < MANUAL_COOLDOWN_MS) throw namedError('RateLimited');
  // Claim the slot synchronously so concurrent requests are rejected; give it back if validation fails.
  // 동시 요청을 막도록 바로 차지하고, 검증이 실패하면 되돌린다.
  s.lastManualAt = now.getTime();
  let inc: Incident;
  try {
    const at = req.at === undefined ? now : new Date(req.at);
    const atMs = at.getTime();
    if (Number.isNaN(atMs) || atMs > now.getTime() + MANUAL_FUTURE_MS || atMs < now.getTime() - MANUAL_MAX_AGE_MS) throw namedError('BadTime');
    let name: string | null = null;
    let region: string | undefined;
    if (req.resourceArn) {
      const history = await (deps.listHistory ?? (() => defaultListHistory()))().catch(() => [] as GraphSnapshot[]);
      const node = findNode(req.resourceArn, (deps.currentData ?? currentGraph)(), history);
      // Stay inside the requested account; IAM roles carry it in the ARN. / 요청 계정 안에서만 — 역할은 ARN 계정 칸.
      const nodeAccount = node && (node.type === 'role' ? (node.arn.split(':')[4] || node.accountId) : node.accountId);
      if (!node || nodeAccount !== req.accountId) throw namedError('NotFound');
      name = node.name;
      region = node.region || undefined;
    }
    region ??= getAccountById(req.accountId)?.region || DEFAULT_REGION;
    const id = newIncidentId();
    const iso = now.toISOString();
    inc = { id, key: `manual|${id}`, accountId: req.accountId, region, resourceArn: req.resourceArn, resourceName: name, signals: [], startedAt: at.toISOString(), firstSeenAt: iso, lastSeenAt: iso, status: 'open', source: 'manual' };
  } catch (e) {
    s.lastManualAt = prev;
    throw e;
  }
  const created = inc;
  await updateIncidents((l) => [created, ...l]);
  const analyze = deps.analyze ?? ((i: Incident) => analyzeIncident(i, { ...deps, userId: req.userId ?? deps.userId }));
  const done = enqueueAnalysis(() => analyze(created)).then(async (a) => (await saveAnalysis(created.id, a)) ?? { ...created, analysis: a });
  done.catch((e) => console.error('[root-cause] manual analysis failed:', errName(e)));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(namedError('Timeout')), deps.timeoutMs ?? MANUAL_TIMEOUT_MS);
    timer.unref?.();
  });
  try { return await Promise.race([done, timeout]); } finally { clearTimeout(timer); }
}
