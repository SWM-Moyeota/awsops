// Status-path tests for the /api/root-cause handlers with faked deps. / 가짜 의존성으로 상태 코드 경로 시험.
import { describe, it, expect, vi } from 'vitest';
import { handleRootCauseGet, handleRootCausePost } from '@/lib/root-cause/api';
import type { Incident, Suspect } from '@/lib/root-cause/types';

const sus = (n: number) => ({ rank: n }) as unknown as Suspect;
const inc = (id: string, accountId = '111111111111', withAnalysis = false): Incident => ({
  id, key: id, accountId, region: 'ap-northeast-2', resourceArn: null, resourceName: null, signals: [],
  startedAt: 'x', firstSeenAt: 'x', lastSeenAt: 'x', status: 'open', source: 'auto',
  ...(withAnalysis ? { analysis: { suspects: [sus(1), sus(2), sus(3)] } as unknown as Incident['analysis'] } : {}),
});
const err = (name: string) => Object.assign(new Error(name), { name });
const P = (s: string) => new URLSearchParams(s);
const ID = 'rc-abcdefghij';

describe('GET', () => {
  const read = async () => [inc(ID, '111111111111', true), inc('rc-0123456789', '222222222222')];
  it('lists with autoDetect and trims suspects to rank 1', async () => {
    const r = await handleRootCauseGet(P('op=list'), { read, autoDetect: () => false });
    const b = r.body as { incidents: Incident[]; autoDetect: boolean };
    expect(r.status).toBe(200);
    expect(b.autoDetect).toBe(false);
    expect(b.incidents).toHaveLength(2);
    expect(b.incidents[0].analysis!.suspects).toHaveLength(1);
  });
  it('filters by account and caps at 50', async () => {
    const many = async () => Array.from({ length: 80 }, (_, i) => inc(`rc-${String(i).padStart(10, '0')}`));
    expect(((await handleRootCauseGet(P('op=list'), { read: many })).body as { incidents: unknown[] }).incidents).toHaveLength(50);
    const r = await handleRootCauseGet(P('op=list&accountId=222222222222'), { read });
    expect((r.body as { incidents: unknown[] }).incidents).toHaveLength(1);
  });
  it('400 on bad account, op, id', async () => {
    expect((await handleRootCauseGet(P('op=list&accountId=abc'), { read })).status).toBe(400);
    expect((await handleRootCauseGet(P('op=zzz'), { read })).status).toBe(400);
    expect((await handleRootCauseGet(P('op=get&id=nope'), { read })).status).toBe(400);
  });
  it('get returns full incident or 404', async () => {
    const ok = await handleRootCauseGet(P(`op=get&id=${ID}`), { read });
    expect(ok.status).toBe(200);
    expect(((ok.body as { incident: Incident }).incident.analysis!.suspects)).toHaveLength(3);
    const nf = await handleRootCauseGet(P('op=get&id=rc-zzzzzzzzzz'), { read });
    expect(nf).toEqual({ status: 404, body: { error: 'not-found' } });
  });
  it('500 carries the error name only', async () => {
    const r = await handleRootCauseGet(P('op=list'), { read: async () => { throw err('Boom'); } });
    expect(r).toEqual({ status: 500, body: { error: 'Boom' } });
  });
});

describe('POST analyze', () => {
  const good = { op: 'analyze', accountId: '111111111111', resourceArn: 'arn:aws:ec2:x', at: '2026-10-29T12:00:00Z' };
  it('200 and passes user id', async () => {
    const analyze = vi.fn(async () => inc(ID));
    const r = await handleRootCausePost(good, 'a@b.c', { analyze });
    expect(r.status).toBe(200);
    expect(analyze).toHaveBeenCalledWith({ accountId: '111111111111', resourceArn: 'arn:aws:ec2:x', at: '2026-10-29T12:00:00Z', userId: 'a@b.c' });
  });
  it('maps error names to statuses', async () => {
    const run = (n: string) => handleRootCausePost(good, null, { analyze: async () => { throw err(n); } });
    expect((await run('RateLimited')).status).toBe(429);
    expect((await run('NotFound')).status).toBe(404);
    expect((await run('BadTime')).status).toBe(400);
    expect(await run('Timeout')).toEqual({ status: 202, body: { status: 'running' } });
    expect(await run('Boom')).toEqual({ status: 500, body: { error: 'Boom' } });
  });
  it('400 on bad bodies', async () => {
    const analyze = vi.fn();
    for (const b of [null, 'x', { op: 'nope' }, { ...good, accountId: '12' }, { ...good, resourceArn: 'foo' }, { ...good, resourceArn: 5 },
      { ...good, resourceArn: 'arn:' + 'a'.repeat(2050) }, { ...good, at: 'not-a-date' }, { ...good, at: 5 }]) {
      expect((await handleRootCausePost(b, null, { analyze })).status).toBe(400);
    }
    expect(analyze).not.toHaveBeenCalled();
  });
  it('allows null/missing resourceArn and at', async () => {
    const analyze = vi.fn(async () => inc(ID));
    expect((await handleRootCausePost({ op: 'analyze', accountId: '111111111111' }, null, { analyze })).status).toBe(200);
    expect((await handleRootCausePost({ op: 'analyze', accountId: '111111111111', resourceArn: null }, null, { analyze })).status).toBe(200);
  });
});
