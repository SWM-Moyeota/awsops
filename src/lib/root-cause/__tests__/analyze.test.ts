// Analysis, queue and manual-analyze tests with every AWS/Bedrock dep faked. / 분석·큐·수동 분석 시험 — AWS·Bedrock 전부 가짜.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeIncident, enqueueAnalysis, lookupWriteEvents, manualAnalyze } from '../analyze';
import { readIncidents } from '../store';
import type { LookupFn } from '@/lib/change-timeline/ingest';
import type { GraphData, GraphNode } from '@/lib/dep-graph/types';
import type { Analysis, GraphSnapshot, Incident } from '../types';

const A = '111111111111';
const start = new Date('2026-10-29T12:00:00Z');
const NOW = new Date('2026-10-29T12:10:00Z');
const LB = `arn:aws:elasticloadbalancing:ap-northeast-2:${A}:loadbalancer/app/web/abc`;
const SG = `arn:aws:ec2:ap-northeast-2:${A}:security-group/sg-1`;
const GONE = `arn:aws:ec2:ap-northeast-2:${A}:security-group/sg-gone`;
const node = (type: GraphNode['type'], id: string, arn: string): GraphNode => ({ arn, type, id, name: id, accountId: A, region: 'ap-northeast-2', attrs: {} });
const graph: GraphData = { nodes: [node('lb', 'web', LB), node('sg', 'sg-1', SG)], edges: [{ src: LB, dst: SG, type: 'uses_sg' }], dropped: 0 };
const history: GraphSnapshot[] = [{ builtAt: '2026-10-29T11:30:00.000Z', data: { nodes: [...graph.nodes, node('sg', 'sg-gone', GONE)], edges: graph.edges, dropped: 0 } }];

const raw = (id: string, minBefore: number, name = 'RevokeSecurityGroupIngress', region = 'ap-northeast-2') => ({
  eventID: id, eventName: name, eventSource: 'ec2.amazonaws.com', eventTime: new Date(start.getTime() - minBefore * 60_000).toISOString(),
  awsRegion: region, userIdentity: { type: 'IAMUser', userName: 'kim', arn: `arn:aws:iam::${A}:user/kim` }, requestParameters: { groupId: 'sg-1' },
});
const page = (events: object[], nextToken?: string) => ({ events: events.map((e) => ({ CloudTrailEvent: JSON.stringify(e) })), nextToken });

const incident = (over: Partial<Incident> = {}): Incident => ({
  id: 'rc-test000001', key: `${A}|${LB}|alb-5xx`, accountId: A, region: 'ap-northeast-2', resourceArn: LB, resourceName: 'web',
  signals: [{ kind: 'alb-5xx', accountId: A, region: 'ap-northeast-2', resourceArn: LB, startedAt: start.toISOString(), detail: '5분 5xx 312건, 평소 2건' }],
  startedAt: start.toISOString(), firstSeenAt: start.toISOString(), lastSeenAt: start.toISOString(), status: 'open', source: 'auto', ...over,
});
const okInvoke = (eventId: string) => vi.fn().mockResolvedValue({ content: JSON.stringify({ summary: 's', causes: [{ eventId, reason: 'r', confidence: 'high' }], checks: [] }), inputTokens: 10, outputTokens: 5 });
const baseDeps = () => ({ listHistory: async () => history, currentData: () => graph, record: vi.fn(), now: () => NOW });

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-analyze-'));
  process.env.ROOT_CAUSE_DATA_DIR = dir;
  delete globalThis.__awsopsRootCause;
});
afterEach(() => {
  delete process.env.ROOT_CAUSE_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lookupWriteEvents', () => {
  it('parses CloudTrailEvent strings and stops at the last page', async () => {
    const lookup: LookupFn = vi.fn().mockResolvedValueOnce(page([raw('e1', 5)], 't1')).mockResolvedValueOnce(page([raw('e2', 6)]));
    const r = await lookupWriteEvents(A, 'ap-northeast-2', start, NOW, { lookup });
    expect(r).toMatchObject({ truncated: false, failed: false });
    expect((r.events as Array<{ eventID: string }>).map((e) => e.eventID)).toEqual(['e1', 'e2']);
    expect(vi.mocked(lookup).mock.calls[1][2].nextToken).toBe('t1');
  });
  it('10 full pages with a next token -> truncated', async () => {
    const full = Array.from({ length: 50 }, (_, i) => raw(`e${i}`, 5));
    const lookup: LookupFn = vi.fn().mockResolvedValue(page(full, 'more'));
    const r = await lookupWriteEvents(A, 'ap-northeast-2', start, NOW, { lookup });
    expect(lookup).toHaveBeenCalledTimes(10);
    expect(r.truncated).toBe(true);
    expect(r.events).toHaveLength(500);
  });
  it('error -> failed with the events so far', async () => {
    const lookup: LookupFn = vi.fn().mockResolvedValueOnce(page([raw('e1', 5)], 't')).mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'ThrottlingException' }));
    const r = await lookupWriteEvents(A, 'ap-northeast-2', start, NOW, { lookup });
    expect(r.failed).toBe(true);
    expect(r.events).toHaveLength(1);
  });
});

describe('analyzeIncident', () => {
  it('one region failing -> other region suspects present and failedRegions', async () => {
    const lookup: LookupFn = vi.fn(async (_a, region) => {
      if (region === 'us-east-1') throw Object.assign(new Error('x'), { name: 'AccessDenied' });
      return page([raw('e1', 10)]);
    });
    const a = await analyzeIncident(incident(), { ...baseDeps(), lookup, invoke: okInvoke('e1') });
    expect(a.failedRegions).toEqual(['us-east-1']);
    expect(a.suspects.map((s) => s.event.eventId)).toEqual(['e1']);
    expect(a.suspects[0].proximity.distance).toBe(1);
    expect(a.ai.status).toBe('ok');
    expect(a.windowFrom).toBe('2026-10-29T11:00:00.000Z');
    expect(a.windowTo).toBe('2026-10-29T12:05:00.000Z');
    expect(a.graph.count).toBe(1);
    expect(vi.mocked(lookup).mock.calls.map((c) => c[1])).toEqual(['ap-northeast-2', 'us-east-1']);
  });
  it('dedupes regions when the incident is in us-east-1', async () => {
    const lookup: LookupFn = vi.fn().mockResolvedValue(page([]));
    await analyzeIncident(incident({ region: 'us-east-1' }), { ...baseDeps(), lookup, invoke: okInvoke('x') });
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('AI failing -> ai.status failed, ranking kept (same eventID in both regions counted once), usage recorded', async () => {
    const lookup: LookupFn = vi.fn().mockResolvedValue(page([raw('e1', 10)]));
    const deps = { ...baseDeps(), lookup, invoke: vi.fn().mockRejectedValue(new Error('boom')) };
    const a = await analyzeIncident(incident(), deps);
    expect(a.ai.status).toBe('failed');
    expect(a.suspects).toHaveLength(1);
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
  it('truncated from any region is reported', async () => {
    const full = Array.from({ length: 50 }, (_, i) => raw(`e${i}`, 5));
    const lookup: LookupFn = vi.fn().mockResolvedValue(page(full, 'more'));
    const a = await analyzeIncident(incident(), { ...baseDeps(), lookup, invoke: okInvoke('e0') });
    expect(a.truncated).toBe(true);
  });
});

describe('enqueueAnalysis', () => {
  it('runs analyses one at a time', async () => {
    const log: string[] = [];
    let release!: () => void;
    const first = enqueueAnalysis(async () => { log.push('a-start'); await new Promise<void>((r) => { release = r; }); log.push('a-end'); return 1; });
    const second = enqueueAnalysis(async () => { log.push('b-start'); return 2; });
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(['a-start']);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(log).toEqual(['a-start', 'a-end', 'b-start']);
  });
  it('a failing analysis does not block the next', async () => {
    await expect(enqueueAnalysis(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await enqueueAnalysis(async () => 'ok')).toBe('ok');
  });
});

describe('manualAnalyze', () => {
  const fakeAnalysis = (): Analysis => ({ analyzedAt: NOW.toISOString(), windowFrom: '', windowTo: '', graph: { from: null, to: null, count: 0 }, eventsSeen: 0, truncated: false, failedRegions: [], suspects: [], ai: { status: 'skipped', droppedCitations: 0 } });

  it('creates and saves a manual incident with the analysis', async () => {
    const analyze = vi.fn(async () => fakeAnalysis());
    const inc = await manualAnalyze({ accountId: A, resourceArn: LB, at: start.toISOString() }, { ...baseDeps(), analyze });
    expect(inc.source).toBe('manual');
    expect(inc.key).toBe(`manual|${inc.id}`);
    expect(inc.signals).toEqual([]);
    expect(inc.resourceName).toBe('web');
    expect(inc.startedAt).toBe(start.toISOString());
    expect(inc.analysis).toBeTruthy();
    const saved = await readIncidents();
    expect(saved[0].id).toBe(inc.id);
    expect(saved[0].analysis).toBeTruthy();
  });
  it('RateLimited within 30 s of the last run', async () => {
    const analyze = vi.fn(async () => fakeAnalysis());
    await manualAnalyze({ accountId: A, resourceArn: LB }, { ...baseDeps(), analyze });
    const later = new Date(NOW.getTime() + 20_000);
    await expect(manualAnalyze({ accountId: A, resourceArn: LB }, { ...baseDeps(), analyze, now: () => later })).rejects.toMatchObject({ name: 'RateLimited' });
    const after = new Date(NOW.getTime() + 31_000);
    await expect(manualAnalyze({ accountId: A, resourceArn: LB }, { ...baseDeps(), analyze, now: () => after })).resolves.toBeTruthy();
  });
  it('NotFound when the ARN is in neither current graph nor history', async () => {
    await expect(manualAnalyze({ accountId: A, resourceArn: 'arn:aws:ec2:x:y:instance/i-none' }, { ...baseDeps(), analyze: vi.fn() })).rejects.toMatchObject({ name: 'NotFound' });
  });
  it('a rejected request does not consume the rate limit', async () => {
    await expect(manualAnalyze({ accountId: A, resourceArn: 'arn:none' }, { ...baseDeps(), analyze: vi.fn() })).rejects.toMatchObject({ name: 'NotFound' });
    await expect(manualAnalyze({ accountId: A, resourceArn: LB }, { ...baseDeps(), analyze: vi.fn(async () => fakeAnalysis()) })).resolves.toBeTruthy();
  });
  it('BadTime for future (>2 min), older than 7 days, or unparseable', async () => {
    const d = { ...baseDeps(), analyze: vi.fn() };
    await expect(manualAnalyze({ accountId: A, resourceArn: LB, at: new Date(NOW.getTime() + 3 * 60_000).toISOString() }, d)).rejects.toMatchObject({ name: 'BadTime' });
    await expect(manualAnalyze({ accountId: A, resourceArn: LB, at: new Date(NOW.getTime() - 8 * 86_400_000).toISOString() }, d)).rejects.toMatchObject({ name: 'BadTime' });
    await expect(manualAnalyze({ accountId: A, resourceArn: LB, at: 'nope' }, d)).rejects.toMatchObject({ name: 'BadTime' });
    await expect(manualAnalyze({ accountId: A, resourceArn: LB, at: new Date(NOW.getTime() + 60_000).toISOString() }, { ...d, analyze: vi.fn(async () => fakeAnalysis()) })).resolves.toBeTruthy();
  });
  it('a deleted resource found only in history is ok', async () => {
    const inc = await manualAnalyze({ accountId: A, resourceArn: GONE }, { ...baseDeps(), analyze: vi.fn(async () => fakeAnalysis()) });
    expect(inc.resourceName).toBe('sg-gone');
  });
  it('account-wide (no resource) is allowed', async () => {
    const inc = await manualAnalyze({ accountId: A, resourceArn: null }, { ...baseDeps(), analyze: vi.fn(async () => fakeAnalysis()) });
    expect(inc.resourceArn).toBeNull();
  });
  it('Timeout after the overall limit, analysis still saved later', async () => {
    let release!: () => void;
    const analyze = vi.fn(() => new Promise<Analysis>((r) => { release = () => r(fakeAnalysis()); }));
    const p = manualAnalyze({ accountId: A, resourceArn: LB }, { ...baseDeps(), analyze, timeoutMs: 20 });
    await expect(p).rejects.toMatchObject({ name: 'Timeout' });
    expect((await readIncidents())[0].analysis).toBeUndefined();
    release();
    await enqueueAnalysis(async () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect((await readIncidents())[0].analysis).toBeTruthy();
  });
});
