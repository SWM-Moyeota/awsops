// Envelope tests: bodies come from the real server handlers (injected deps), then go through the client parsers.
// 응답 봉투 테스트 — 실제 서버 처리기(주입식)가 만든 body를 클라이언트 해석 함수에 넣어 본다.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleTerraformGet, handleTerraformPost, parseSeed, type ApiDeps } from '@/lib/tf-export/api';
import type { ExportSeed, JobRecord } from '@/lib/tf-export/types';
import { TfExportError, getStats, parseJob, parseJobs, parsePreview, parseStart, parseStats, parseStatus, previewSeed, startJob } from '../api';
import { toWireSeed } from '../format';

const ID = '20261029-153012-a1b2c3';
const ACC = '111111111111';
const job: JobRecord = {
  id: ID, accountId: ACC, region: 'ap-northeast-2', seed: { kind: 'prefix', prefix: 'shop-' }, requestedBy: null,
  startedAt: '2026-10-29T06:30:12.000Z', stage: 'done', items: [], excluded: [], results: [], files: ['providers.tf'],
};
const totals = {
  jobs: 2, total: 14, passRules: 13, passAi: 14, passFinal: 14, pure: 12, ignore: 2, failed: 0,
  byType: { aws_vpc: { total: 1, pass: 1 } }, aiCalls: 3, inputTokens: 100, outputTokens: 50, updatedAt: '2026-10-29T07:00:00.000Z',
};
const deps: ApiDeps = {
  recover: async () => undefined,
  installed: async () => ({ installed: true, version: '1.9.8' }),
  running: () => ID,
  getJob: async (id) => (id === ID ? job : null),
  listJobs: async () => [job],
  stats: async () => totals,
  preview: async () => ({ items: [], excluded: [{ nodeArn: 'arn:x', name: 'x', nodeType: 'eni', reason: 'unsupported' }] }),
  start: async () => ({ jobId: ID }),
};
const q = (p: Record<string, string>) => new URLSearchParams(p);

describe('envelopes from the real handlers', () => {
  it('status', async () => {
    const r = await handleTerraformGet(q({ op: 'status' }), deps);
    expect(parseStatus(r.body)).toEqual({ installed: true, version: '1.9.8', running: ID });
    const none = await handleTerraformGet(q({ op: 'status' }), { ...deps, installed: async () => ({ installed: false }), running: () => null });
    expect(parseStatus(none.body)).toEqual({ installed: false, version: undefined, running: null });
  });
  it('stats is unwrapped from {stats}', async () => {
    const r = await handleTerraformGet(q({ op: 'stats' }), deps);
    expect(r.body).toHaveProperty('stats');
    const s = parseStats(r.body);
    expect(s.jobs).toBe(2);
    expect(s.passFinal).toBe(14);
    expect(s.byType).toEqual({ aws_vpc: { total: 1, pass: 1 } });
    expect(s.updatedAt).toBe('2026-10-29T07:00:00.000Z');
  });
  it('stats defaults missing numbers to 0', () => {
    expect(parseStats({ stats: {} })).toMatchObject({ jobs: 0, total: 0, aiCalls: 0, byType: {}, updatedAt: null });
    expect(parseStats({}).jobs).toBe(0);
  });
  it('list and job', async () => {
    expect(parseJobs((await handleTerraformGet(q({ op: 'list' }), deps)).body)).toEqual([job]);
    expect(parseJob((await handleTerraformGet(q({ op: 'job', id: ID }), deps)).body)).toEqual(job);
    expect(() => parseJob({})).toThrow(TfExportError);
  });
  it('preview and start', async () => {
    const seed = toWireSeed({ kind: 'prefix', prefix: 'shop-' });
    const p = await handleTerraformPost({ op: 'preview', accountId: ACC, seed }, null, deps);
    expect(p.status).toBe(200);
    expect(parsePreview(p.body).excluded).toHaveLength(1);
    const s = await handleTerraformPost({ op: 'start', accountId: ACC, seed }, null, deps);
    expect(s.status).toBe(202);
    expect(parseStart(s.body)).toBe(ID);
  });
});

describe('toWireSeed round-trips through the server parser', () => {
  const seeds: ExportSeed[] = [
    { kind: 'tag', key: 'Project', value: 'shop' },
    { kind: 'prefix', prefix: 'shop-' },
    { kind: 'vpc', arn: 'arn:aws:ec2:ap-northeast-2:111111111111:vpc/vpc-0ab' },
    { kind: 'arns', arns: ['arn:aws:s3:::bucket', 'arn:aws:iam::111111111111:role/x'] },
  ];
  for (const seed of seeds) {
    it(seed.kind, () => { expect(parseSeed(toWireSeed(seed))).toEqual(seed); });
  }
});

describe('client functions over fetch', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

  it('getStats reads the {stats} envelope', async () => {
    vi.stubGlobal('fetch', respond(200, { stats: totals }));
    expect((await getStats()).jobs).toBe(2);
  });
  it('previewSeed and startJob send the wire seed to /api/terraform-export', async () => {
    const f = respond(200, { items: [], excluded: [] });
    vi.stubGlobal('fetch', f);
    await previewSeed(ACC, { kind: 'tag', key: 'k', value: 'v' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/terraform-export');
    expect(JSON.parse(String(init.body))).toEqual({ op: 'preview', accountId: ACC, seed: { tag: { key: 'k', value: 'v' } } });
    vi.stubGlobal('fetch', respond(202, { jobId: ID }));
    expect(await startJob(ACC, { kind: 'prefix', prefix: 'p' })).toBe(ID);
  });
  it('startJob throws the status and error name', async () => {
    vi.stubGlobal('fetch', respond(429, { error: 'Busy' }));
    await expect(startJob(ACC, { kind: 'prefix', prefix: 'p' })).rejects.toMatchObject({ status: 429, message: 'Busy' });
  });
});
