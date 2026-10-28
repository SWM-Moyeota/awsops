// In-server detection loop: first tick after 90 s, then every 5 min; signals -> incidents, analysis >= 10 min after start, one alert each.
// 서버 안 감지 루프 — 90초 후 첫 tick, 이후 5분마다. 신호 → 사건, 시작 10분 뒤 분석(최대 3회), 사건마다 알림 1회.
import { getConfig, type AppConfig } from '@/lib/app-config';
import { getCurrentStore } from '@/lib/dep-graph/store';
import type { GraphData } from '@/lib/dep-graph/types';
import { analyzeIncident, enqueueAnalysis, saveAnalysis, withCap } from './analyze';
import { applySignals } from './incidents';
import { notifyIncident } from './slack';
import { fetchSignals } from './signals';
import { rootCauseState, updateIncidents } from './store';
import type { Analysis, Incident, Signal } from './types';

export const DETECT_INTERVAL_MS = 300_000;
const FIRST_RUN_DELAY_MS = 90_000;
const DEFAULT_REGION = 'ap-northeast-2';
// CloudTrail delivers events ~5 min late: analyze from start+10 min. / CloudTrail 이벤트는 약 5분 늦게 오므로 시작 10분 뒤부터 분석.
export const ANALYZE_DELAY_MS = 10 * 60_000;
// After the last failed attempt the alert goes out without analysis. / 마지막 시도도 실패하면 분석 없이 알린다.
export const MAX_ANALYSIS_ATTEMPTS = 3;
// A hung per-account signal fetch must not stall the loop. / 계정별 신호 조회가 멈춰도 루프는 계속.
const FETCH_CAP_MS = 60_000;

const errName = (e: unknown) => (e instanceof Error ? e.name : 'Error');

// Injectable pieces (tests fake all of them). / 주입 가능한 부품 — 시험에서 모두 가짜로.
export interface LoopDeps {
  config?: () => Pick<AppConfig, 'accounts' | 'rootCause'>;
  currentData?: () => GraphData | null;
  fetch?: (accountId: string, region: string, data: GraphData, now: Date) => Promise<Signal[]>;
  analyze?: (inc: Incident) => Promise<Analysis>;
  update?: (fn: (list: Incident[]) => Incident[]) => Promise<Incident[]>;
  now?: () => Date;
}

/** The Slack notifier is registered here (default: notifyIncident); truthy return marks the incident notified. / Slack 알림 훅 등록 — 참이면 notifiedAt 기록. */
export function setIncidentNotifier(fn: (inc: Incident) => Promise<unknown>): void {
  rootCauseState().notifier = fn;
}

// Configured accounts, else the accounts present in the current graph (no STS call). / 설정 계정, 없으면 현재 그래프에 있는 계정.
function targetAccounts(cfg: Pick<AppConfig, 'accounts'>, data: GraphData): Array<{ accountId: string; region: string }> {
  const list = (cfg.accounts ?? []).map((a) => ({ accountId: a.accountId, region: a.region || DEFAULT_REGION }));
  if (list.length > 0) return list;
  const seen = new Map<string, string>();
  for (const n of data.nodes) {
    if ((n.type === 'lb' || n.type === 'tg' || n.type === 'instance') && /^\d{12}$/.test(n.accountId) && !seen.has(n.accountId)) seen.set(n.accountId, n.region || DEFAULT_REGION);
  }
  return Array.from(seen, ([accountId, region]) => ({ accountId, region }));
}

// Open auto incident with no analysis or alert, old enough, attempts left. / 분석·알림 없는 열린 자동 사건, 시작 10분 경과, 시도 남음.
function analysisDue(i: Incident, now: Date): boolean {
  return i.source === 'auto' && i.status === 'open' && !i.analysis && !i.notifiedAt
    && (i.analysisAttempts ?? 0) < MAX_ANALYSIS_ATTEMPTS && now.getTime() >= Date.parse(i.startedAt) + ANALYZE_DELAY_MS;
}

/** One detection pass; never throws, never overlaps. / 감지 한 번 — throw하지 않고 겹치지 않는다. */
export async function tick(deps: LoopDeps = {}): Promise<void> {
  const s = rootCauseState();
  if (s.running) return;
  s.running = true;
  try {
    const cfg = (deps.config ?? getConfig)();
    if (cfg.rootCause?.autoDetect === false) return;
    const data = (deps.currentData ?? (() => getCurrentStore()?.data() ?? null))();
    if (!data) return; // no graph yet: skip this tick / 그래프가 아직 없으면 건너뜀
    const clock = deps.now ?? (() => new Date());
    const now = clock();
    const fetchFn = deps.fetch ?? ((a: string, r: string, d: GraphData, t: Date) => fetchSignals(a, r, d, t));
    const update = deps.update ?? updateIncidents;
    const analyze = deps.analyze ?? ((inc: Incident) => analyzeIncident(inc));

    const signals: Signal[] = [];
    for (const { accountId, region } of targetAccounts(cfg, data)) {
      try { signals.push(...(await withCap(() => fetchFn(accountId, region, data, now), FETCH_CAP_MS))); } catch (e) {
        console.error('[root-cause] fetch signals failed:', errName(e));
      }
    }
    // New incidents are stored now; due ones are claimed (attempt +1) in the same write. / 새 사건은 지금 저장, 분석할 사건은 같은 쓰기에서 시도 +1.
    let due: Incident[] = [];
    try {
      await update((list) => {
        const next = applySignals(list, signals, () => data, now).list;
        due = next.filter((i) => analysisDue(i, now)).map((i) => ({ ...i, analysisAttempts: (i.analysisAttempts ?? 0) + 1 }));
        const claimed = new Map(due.map((i) => [i.id, i]));
        return next.map((i) => claimed.get(i.id) ?? i);
      });
    } catch (e) {
      console.error('[root-cause] incident update failed:', errName(e));
      return;
    }
    for (const inc of due) {
      let target: Incident | null;
      try {
        target = await saveAnalysis(inc.id, await enqueueAnalysis(() => analyze(inc)), update);
      } catch (e) {
        console.error('[root-cause] incident analysis failed:', errName(e));
        // Last attempt failed: alert without analysis so an outage is never silent. / 마지막 시도 실패 — 분석 없이라도 알린다.
        if ((inc.analysisAttempts ?? 0) < MAX_ANALYSIS_ATTEMPTS) continue;
        target = inc;
      }
      try {
        const notifier = s.notifier;
        if (!target || !notifier || cfg.rootCause?.slackAlerts === false) continue;
        if (await notifier(target)) {
          const at = clock().toISOString();
          await update((l) => l.map((i) => (i.id === inc.id ? { ...i, notifiedAt: at } : i)));
        }
      } catch (e) {
        console.error('[root-cause] incident alert failed:', errName(e));
      }
    }
  } catch (e) {
    console.error('[root-cause] tick failed:', errName(e));
  } finally {
    s.running = false;
  }
}

/** Production only: first tick after 90 s, then every 300,000 ms; timers unref'd. / 프로덕션 전용, 타이머 unref. */
export function ensureRootCauseStarted(deps: LoopDeps = {}): void {
  const s = rootCauseState();
  // Default Slack notifier unless a test/caller already set one. / 이미 설정된 알림 훅이 없으면 기본 Slack 알림 등록
  s.notifier ??= notifyIncident;
  if (s.started || process.env.NODE_ENV !== 'production') return;
  s.started = true;
  const first = setTimeout(() => {
    void tick(deps);
    s.timer = setInterval(() => void tick(deps), DETECT_INTERVAL_MS);
    s.timer.unref?.();
  }, FIRST_RUN_DELAY_MS);
  first.unref?.();
}
