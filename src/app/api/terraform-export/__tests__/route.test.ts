// Status-path tests for the /api/terraform-export handlers with faked deps. / 가짜 의존성으로 상태 코드 경로 시험.
import { describe, it, expect, vi } from 'vitest';
import { handleTerraformGet, handleTerraformPost, parseSeed } from '@/lib/tf-export/api';
import type { JobRecord } from '@/lib/tf-export/types';

const ID = '20261029-120000-abc123';
const job = { id: ID, stage: 'done', files: ['main.tf', 'bundle.zip'] } as unknown as JobRecord;
const P = (s: string) => new URLSearchParams(s);
const err = (name: string) => Object.assign(new Error(name), { name });
const recover = vi.fn(async () => 0);
const base = { recover, getJob: async (id: string) => (id === ID ? job : null) };
const A = '111111111111';

describe('GET', () => {
  it('status', async () => {
    const r = await handleTerraformGet(P('op=status'), { ...base, installed: async () => ({ installed: true, version: '1.9.8' }), running: () => ID });
    expect(r.body).toEqual({ installed: true, version: '1.9.8', running: ID });
  });
  it('list caps at 20 and stats passes through', async () => {
    const many = Array.from({ length: 30 }, () => job);
    expect(((await handleTerraformGet(P('op=list'), { ...base, listJobs: async () => many })).body as { jobs: unknown[] }).jobs).toHaveLength(20);
    expect((await handleTerraformGet(P('op=stats'), { ...base, stats: async () => ({ jobs: 3 }) })).body).toEqual({ stats: { jobs: 3 } });
  });
  it('job: 200, 404, 400 on bad id', async () => {
    expect((await handleTerraformGet(P(`op=job&id=${ID}`), base)).status).toBe(200);
    expect((await handleTerraformGet(P('op=job&id=20261029-120000-ffffff'), base)).status).toBe(404);
    expect((await handleTerraformGet(P('op=job&id=../etc'), base)).status).toBe(400);
  });
  it('file: only names in job.files, text result', async () => {
    const readFile = vi.fn(async () => 'hcl');
    const ok = await handleTerraformGet(P(`op=file&id=${ID}&name=main.tf`), { ...base, readFile });
    expect(ok.status).toBe(200); expect(ok.text).toBe('hcl');
    expect((await handleTerraformGet(P(`op=file&id=${ID}&name=../../secrets.auto.tfvars`), { ...base, readFile })).status).toBe(404);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
  it('download: zip with filename, 404 when missing', async () => {
    const r = await handleTerraformGet(P(`op=download&id=${ID}`), { ...base, zip: async () => Buffer.from('PK') });
    expect(r.zip?.toString()).toBe('PK'); expect(r.filename).toBe(`terraform-${ID}.zip`);
    expect((await handleTerraformGet(P(`op=download&id=${ID}`), { ...base, zip: async () => null })).status).toBe(404);
  });
  it('unknown op 400, internal error 500 with name only', async () => {
    expect((await handleTerraformGet(P('op=x'), base)).status).toBe(400);
    const r = await handleTerraformGet(P('op=list'), { ...base, listJobs: async () => { throw err('Boom'); } });
    expect(r).toEqual({ status: 500, body: { error: 'Boom' } });
  });
  it('recovers before handling', async () => {
    recover.mockClear();
    await handleTerraformGet(P('op=x'), base);
    expect(recover).toHaveBeenCalled();
  });
});

describe('POST', () => {
  const seed = { prefix: 'web-' };
  it('rejects bad op, account and seeds', async () => {
    expect((await handleTerraformPost(null, null, base)).status).toBe(400);
    expect((await handleTerraformPost({ op: 'x', accountId: A, seed }, null, base)).status).toBe(400);
    expect((await handleTerraformPost({ op: 'start', accountId: '12', seed }, null, base)).status).toBe(400);
    for (const s of [null, {}, { tag: { key: '', value: 'v' } }, { prefix: 'x'.repeat(65) }, { vpc: 'arn:aws:s3:::b' }, { arns: [] }, { arns: ['nope'] }, { arns: Array(61).fill('arn:a') }]) {
      expect((await handleTerraformPost({ op: 'start', accountId: A, seed: s }, null, base)).status).toBe(400);
    }
  });
  it('parseSeed maps shapes and trims', () => {
    expect(parseSeed({ tag: { key: ' k ', value: 'v' } })).toEqual({ kind: 'tag', key: 'k', value: 'v' });
    expect(parseSeed({ vpc: 'arn:aws:ec2:ap-northeast-2:1:vpc/v' })).toEqual({ kind: 'vpc', arn: 'arn:aws:ec2:ap-northeast-2:1:vpc/v' });
    expect(parseSeed({ arns: ['arn:a'] })).toEqual({ kind: 'arns', arns: ['arn:a'] });
  });
  it('start: 202 with user, maps error names', async () => {
    const start = vi.fn(async () => ({ jobId: ID }));
    const r = await handleTerraformPost({ op: 'start', accountId: A, seed }, 'a@b.c', { ...base, start });
    expect(r).toEqual({ status: 202, body: { jobId: ID } });
    expect(start).toHaveBeenCalledWith({ accountId: A, seed: { kind: 'prefix', prefix: 'web-' }, requestedBy: 'a@b.c' });
    for (const [n, c] of [['Busy', 429], ['NotInstalled', 409], ['NotFound', 404], ['Empty', 400], ['UnsafeConfig', 500]] as const) {
      const x = await handleTerraformPost({ op: 'start', accountId: A, seed }, null, { ...base, start: async () => { throw err(n); } });
      expect(x).toEqual({ status: c, body: { error: n } });
    }
  });
  it('preview: result, 404 no-graph', async () => {
    const res = { items: [], excluded: [] };
    expect((await handleTerraformPost({ op: 'preview', accountId: A, seed }, null, { ...base, preview: async () => res })).body).toEqual(res);
    expect(await handleTerraformPost({ op: 'preview', accountId: A, seed }, null, { ...base, preview: async () => null })).toEqual({ status: 404, body: { error: 'no-graph' } });
  });
});
