// Detection loop tests: timers, config switches, one incident -> one analysis -> one notification. / 감지 루프 시험.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRootCauseStarted, setIncidentNotifier, tick, type LoopDeps } from '../loop';
import { readIncidents, updateIncidents } from '../store';
import type { GraphData, GraphNode } from '@/lib/dep-graph/types';
import type { Analysis, Incident, Signal } from '../types';

const A = '111111111111';
const NOW = new Date('2026-10-29T12:00:00Z');
const node = (type: GraphNode['type'], id: string, arn: string): GraphNode => ({ arn, type, id, name: id, accountId: A, region: 'ap-northeast-2', attrs: {} });
const LB = `arn:aws:elasticloadbalancing:ap-northeast-2:${A}:loadbalancer/app/web/abc`;
const TG = `arn:aws:elasticloadbalancing:ap-northeast-2:${A}:targetgroup/web-tg/123`;
const I1 = `arn:aws:ec2:ap-northeast-2:${A}:instance/i-1`;
const graph: GraphData = {
  nodes: [node('lb', 'web', LB), node('tg', 'web-tg', TG), node('instance', 'i-1', I1)],
  edges: [{ src: LB, dst: TG, type: 'forwards_to' }, { src: TG, dst: I1, type: 'targets' }],
  dropped: 0,
};
const sig = (kind: Signal['kind'], resourceArn: string): Signal => ({ kind, accountId: A, region: 'ap-northeast-2', resourceArn, startedAt: '2026-10-29T11:57:00.000Z', detail: kind });
const analysis = (): Analysis => ({ analyzedAt: NOW.toISOString(), windowFrom: '', windowTo: '', graph: { from: null, to: null, count: 0 }, eventsSeen: 0, truncated: false, failedRegions: [], suspects: [], ai: { status: 'skipped', droppedCitations: 0 } });
const accounts = [{ accountId: A, alias: 'Host', connectionName: `aws_${A}`, region: 'ap-northeast-2', isHost: true, features: { costEnabled: false, eksEnabled: false, k8sEnabled: false } }];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-loop-'));
  process.env.ROOT_CAUSE_DATA_DIR = dir;
  delete globalThis.__awsopsRootCause;
});
afterEach(() => {
  const s = globalThis.__awsopsRootCause;
  if (s?.timer) clearInterval(s.timer);
  delete globalThis.__awsopsRootCause;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete process.env.ROOT_CAUSE_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureRootCauseStarted', () => {
  // In-memory store so fake time never waits on real file I/O. / 가짜 시간에서 파일 I/O를 기다리지 않도록 메모리 저장소.
  const memDeps = (fetch: LoopDeps['fetch']): LoopDeps => {
    let mem: Incident[] = [];
    return { fetch, currentData: () => graph, config: () => ({ accounts }), now: () => NOW, update: async (fn) => (mem = fn(mem)), analyze: async () => analysis() };
  };
  it('first tick at 90 s, then every 300 s (production)', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'production');
    const fetch = vi.fn(async () => [] as Signal[]);
    ensureRootCauseStarted(memDeps(fetch));
    ensureRootCauseStarted(memDeps(fetch)); // idempotent / 두 번 불러도 한 번
    await vi.advanceTimersByTimeAsync(89_999);
    expect(fetch).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('does nothing outside production', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'development');
    const fetch = vi.fn(async () => [] as Signal[]);
    ensureRootCauseStarted(memDeps(fetch));
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('tick', () => {
  const deps = (over: Partial<LoopDeps> = {}): LoopDeps => ({
    fetch: vi.fn(async () => [sig('tg-unhealthy', TG), sig('ec2-status', I1), sig('alb-5xx', LB)]),
    currentData: () => graph, config: () => ({ accounts }), now: () => NOW, analyze: vi.fn(async () => analysis()), ...over,
  });

  it('autoDetect:false -> no fetch', async () => {
    const d = deps({ config: () => ({ accounts, rootCause: { autoDetect: false } }) });
    await tick(d);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('no current graph -> no fetch', async () => {
    const d = deps({ currentData: () => null });
    await tick(d);
    expect(d.fetch).not.toHaveBeenCalled();
  });
  // Signals start 11:57, so analysis is due from 12:07. / 신호 시작 11:57 → 12:07부터 분석.
  const at = (hhmm: string) => () => new Date(`2026-10-29T${hhmm}:00Z`);
  it('detection stores the incident only; no analysis or alert yet', async () => {
    const notify = vi.fn(async () => true);
    setIncidentNotifier(notify);
    const d = deps();
    await tick(d);
    expect(d.analyze).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    const [inc] = await readIncidents();
    expect(inc.signals).toHaveLength(3);
    expect(inc.analysis).toBeUndefined();
    expect(inc.analysisAttempts).toBeUndefined();
  });
  it('three related signals -> one incident, analyzed >= 10 min after start, one notification', async () => {
    const notify = vi.fn(async () => true);
    setIncidentNotifier(notify);
    const analyze = vi.fn(async () => analysis());
    await tick(deps({ analyze }));
    await tick(deps({ analyze, now: at('12:06') }));
    expect(analyze).not.toHaveBeenCalled(); // 9 min after start / 시작 9분 뒤
    await tick(deps({ analyze, now: at('12:07') }));
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const [notified] = notify.mock.calls[0] as unknown as [Incident];
    expect(notified.analysis).toBeTruthy();
    const list = await readIncidents();
    expect(list).toHaveLength(1);
    expect(list[0].signals).toHaveLength(3);
    expect(list[0].analysis).toBeTruthy();
    expect(list[0].analysisAttempts).toBe(1);
    expect(list[0].notifiedAt).toBe('2026-10-29T12:07:00.000Z');
    // Same signals next tick: no new incident, no new analysis or post. / 다음 tick 같은 신호: 새 사건·분석·알림 없음.
    await tick(deps({ analyze, now: at('12:12') }));
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await readIncidents()).toHaveLength(1);
  });
  it('failed analysis is retried up to 3 times, then alerted without analysis, once', async () => {
    const notify = vi.fn(async () => true);
    setIncidentNotifier(notify);
    const analyze = vi.fn(async (): Promise<Analysis> => { throw new Error('ai'); });
    await tick(deps({ analyze }));
    await tick(deps({ analyze, now: at('12:07') }));
    await tick(deps({ analyze, now: at('12:12') }));
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled(); // not silent, but not early either / 이르게 알리지 않음
    await tick(deps({ analyze, now: at('12:17') }));
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(1);
    const [notified] = notify.mock.calls[0] as unknown as [Incident];
    expect(notified.analysis).toBeUndefined();
    const [inc] = await readIncidents();
    expect(inc.analysisAttempts).toBe(3);
    expect(inc.notifiedAt).toBe('2026-10-29T12:17:00.000Z');
    await tick(deps({ analyze, now: at('12:22') }));
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('final failure with a falsy notifier is not retried again', async () => {
    const notify = vi.fn(async () => false);
    setIncidentNotifier(notify);
    const analyze = vi.fn(async (): Promise<Analysis> => { throw new Error('ai'); });
    await tick(deps({ analyze }));
    for (const t of ['12:07', '12:12', '12:17', '12:22']) await tick(deps({ analyze, now: at(t) }));
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await readIncidents())[0].notifiedAt).toBeUndefined();
  });
  it('a failure then a success -> one alert with the analysis', async () => {
    const notify = vi.fn(async () => true);
    setIncidentNotifier(notify);
    const analyze = vi.fn(async (): Promise<Analysis> => { throw new Error('ai'); }).mockImplementationOnce(async () => { throw new Error('ai'); }).mockImplementation(async () => analysis());
    await tick(deps({ analyze }));
    await tick(deps({ analyze, now: at('12:07') }));
    expect(notify).not.toHaveBeenCalled();
    await tick(deps({ analyze, now: at('12:12') }));
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0] as unknown as [Incident])[0].analysis).toBeTruthy();
  });
  it('restarted process picks up a pending open incident; manual and resolved ones are skipped', async () => {
    const base = { accountId: A, region: 'ap-northeast-2', resourceArn: LB, resourceName: 'web', signals: [sig('alb-5xx', LB)], startedAt: '2026-10-29T11:30:00.000Z', firstSeenAt: '2026-10-29T11:31:00.000Z', lastSeenAt: '2026-10-29T11:55:00.000Z' };
    await updateIncidents(() => [
      { ...base, id: 'rc-pending', key: 'k1', status: 'open', source: 'auto', analysisAttempts: 1 },
      { ...base, id: 'rc-manual', key: 'k2', status: 'open', source: 'manual' },
      { ...base, id: 'rc-resolved', key: 'k3', status: 'resolved', source: 'auto' },
    ]);
    delete globalThis.__awsopsRootCause; // fresh process state / 새 프로세스 상태
    const notify = vi.fn(async () => true);
    setIncidentNotifier(notify);
    const analyze = vi.fn(async () => analysis());
    await tick(deps({ analyze, fetch: vi.fn(async () => [] as Signal[]) }));
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((analyze.mock.calls[0] as unknown as [Incident])[0].id).toBe('rc-pending');
    expect(notify).toHaveBeenCalledTimes(1);
    const list = await readIncidents();
    expect(list.find((i) => i.id === 'rc-pending')).toMatchObject({ analysisAttempts: 2, notifiedAt: NOW.toISOString() });
    expect(list.find((i) => i.id === 'rc-manual')?.analysis).toBeUndefined();
  });
  it('a hung signal fetch is capped at 60 s; the tick ends and the next one runs', async () => {
    vi.useFakeTimers();
    const B = '222222222222';
    const fetch = vi.fn((accountId: string) => (accountId === B ? new Promise<Signal[]>(() => undefined) : Promise.resolve([sig('alb-5xx', LB)])));
    let mem: Incident[] = [];
    const d = deps({ fetch, config: () => ({ accounts: [{ ...accounts[0], accountId: B }, accounts[0]] }), update: async (fn) => (mem = fn(mem)) });
    let done = false;
    void tick(d).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(globalThis.__awsopsRootCause!.running).toBe(false);
    expect(mem).toHaveLength(1); // the other account still counted / 다른 계정은 그대로 처리
    void tick(d);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('notifier returning falsy leaves notifiedAt unset', async () => {
    const notify = vi.fn(async () => false);
    setIncidentNotifier(notify);
    const analyze = vi.fn(async () => analysis());
    await tick(deps({ analyze }));
    await tick(deps({ analyze, now: at('12:07') }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await readIncidents())[0].notifiedAt).toBeUndefined();
    // Analysis is saved, so no retry and no second post. / 분석은 저장됐으니 재시도·재알림 없음.
    await tick(deps({ analyze, now: at('12:12') }));
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('slackAlerts:false -> notifier not called', async () => {
    const notify = vi.fn(async () => true);
    setIncidentNotifier(notify);
    const config = () => ({ accounts, rootCause: { slackAlerts: false } });
    const analyze = vi.fn(async () => analysis());
    await tick(deps({ config, analyze }));
    await tick(deps({ config, analyze, now: at('12:07') }));
    expect(analyze).toHaveBeenCalledTimes(1); // still analyzed for the page / 화면용 분석은 그대로
    expect(notify).not.toHaveBeenCalled();
  });
  it('errors are logged, never thrown; other accounts still run', async () => {
    const B = '222222222222';
    const fetch = vi.fn(async (accountId: string) => { if (accountId === B) throw new Error('x'); return [sig('alb-5xx', LB)]; });
    const d = deps({ fetch, config: () => ({ accounts: [{ ...accounts[0], accountId: B }, accounts[0]] }), analyze: vi.fn(async () => { throw new Error('ai'); }) });
    await expect(tick(d)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readIncidents()).toHaveLength(1);
  });
  it('no configured accounts -> accounts found in the current graph', async () => {
    const d = deps({ config: () => ({}) });
    await tick(d);
    expect(d.fetch).toHaveBeenCalledWith(A, 'ap-northeast-2', graph, NOW);
  });
});

describe('default notifier', () => {
  it('registers notifyIncident only when none is set', () => {
    ensureRootCauseStarted();
    const first = globalThis.__awsopsRootCause!.notifier;
    expect(typeof first).toBe('function');
    const mine = async () => true;
    setIncidentNotifier(mine);
    ensureRootCauseStarted();
    expect(globalThis.__awsopsRootCause!.notifier).toBe(mine);
  });
});
