import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectWhoQuestion, answerWho, buildDailySummary, maybeSendDailySummary, maybeHandleChangeQuestion, resetDailySummaryGuard } from '../slack';
import { appendRecords, readState } from '../store';

const failWrite = vi.hoisted(() => ({ times: 0 }));
vi.mock('../store', async (orig) => {
  const m = await orig<typeof import('../store')>();
  return { ...m, writeState: (s: Parameters<typeof m.writeState>[0]) => {
    if (failWrite.times > 0) { failWrite.times -= 1; return Promise.reject(Object.assign(new Error('x'), { name: 'EIO' })); }
    return m.writeState(s);
  } };
});
import { rec } from './helpers';

let dir: string;
beforeEach(() => { resetDailySummaryGuard(); failWrite.times = 0; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-slack-')); process.env.CHANGE_TIMELINE_DATA_DIR = dir; });
afterEach(() => { delete process.env.CHANGE_TIMELINE_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

const bucket = (id: string, time: string, over = {}) =>
  rec(id, time, { resourceType: 's3-bucket', resourceId: 'moyeota-media', resourceName: 'moyeota-media', ...over });

describe('detectWhoQuestion', () => {
  it('detectsWhoCreatedAndDeleted', () => {
    expect(detectWhoQuestion('<@U0BOT> moyeota-media 누가 만들었어?')).toEqual({ kind: 'create', target: 'moyeota-media' });
    expect(detectWhoQuestion('i-0abc12345 누가 지웠어')).toEqual({ kind: 'delete', target: 'i-0abc12345' });
    expect(detectWhoQuestion('moyeota-media 누가 했어?')).toEqual({ kind: 'any', target: 'moyeota-media' });
    expect(detectWhoQuestion('<@U0BOT> 지금 켜진 EC2 뭐 있어?')).toBeNull();
    expect(detectWhoQuestion('누가 만들었어?')).toBeNull();
  });
});

describe('answerWho', () => {
  const q = { kind: 'create' as const, target: 'moyeota-media' };
  it('answerFoundStillExists', () => {
    const out = answerWho(q, [bucket('a', '2026-10-26T05:02:00Z')]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('🪣 *sungyoon님이 S3 버킷을 만들었어요*');
    expect(lines[1]).toBe('moyeota-media · S3 버킷');
    expect(lines[2]).toBe('10월 26일 오후 2:02 · 콘솔');
    expect(lines[3]).toBe('아직 있어요');
  });
  it('answerFoundDeleted', () => {
    const out = answerWho(q, [
      bucket('a', '2026-10-26T05:02:00Z'),
      bucket('b', '2026-10-27T01:00:00Z', { kind: 'delete', actor: { kind: 'person', name: 'minsu' } }),
    ]);
    expect(out.split('\n')[0]).toContain('sungyoon님이');
    expect(out.split('\n')[3]).toBe('10월 27일 minsu님이 지웠어요');
  });
  it('answerNotFound', () => {
    expect(answerWho(q, [])).toBe('최근 90일 기록에서 `moyeota-media`을(를) 찾지 못했어요');
  });
  it('answerMultipleCandidates', () => {
    const rs = Array.from({ length: 7 }, (_, i) => bucket(`x${i}`, `2026-10-2${i}T05:00:00Z`, { resourceId: `media-${i}`, resourceName: `media-${i}` }));
    const out = answerWho({ kind: 'create', target: 'media' }, rs);
    expect(out.split('\n').filter((l) => l.startsWith('• ')).length).toBe(5);
    expect(out).toContain('7개');
  });
});

describe('dailySummary', () => {
  const day = '2026-10-25';
  const at = (h: string) => `2026-10-25T${h}:00Z`; // KST 10-25 09:00 .. next day 08:59 for 00..23 UTC
  it('dailySummaryCountsPeopleOnly', () => {
    const rs = [
      rec('1', at('01:00'), { actor: { kind: 'person', name: 'jiwoo' } }),
      rec('2', at('02:00'), { actor: { kind: 'person', name: 'jiwoo' } }),
      rec('3', at('03:00'), { actor: { kind: 'person', name: 'sungyoon' } }),
      rec('4', at('04:00'), { kind: 'delete', actor: { kind: 'person', name: 'minsu' } }),
      rec('5', at('05:00'), { actor: { kind: 'auto', name: 'autoscaling' } }),
      rec('6', '2026-10-24T20:00:00Z', { actor: { kind: 'person', name: 'old' } }), // KST 10-25 05:00 -> in day
      rec('7', '2026-10-24T10:00:00Z', { actor: { kind: 'person', name: 'outside' } }), // KST 10-24
    ];
    const out = buildDailySummary(rs, day)!;
    expect(out.split('\n')[0]).toBe('☀️ *어제 5개가 생기고 1개가 사라졌어요*');
    expect(out.split('\n')[1]).toBe('jiwoo 생성 2 · old 생성 1 · sungyoon 생성 1 · minsu 삭제 1');
    expect(out).not.toContain('autoscaling');
    expect(out).not.toContain('outside');
  });
  it('noSummaryWhenNoChanges', () => {
    expect(buildDailySummary([], day)).toBeNull();
  });
  it('dailySummaryOncePerDay', async () => {
    await appendRecords([rec('1', '2026-10-25T01:00:00Z', { actor: { kind: 'person', name: 'jiwoo' } })]);
    const post = vi.fn(async (_t: string) => true);
    const kst = (iso: string) => new Date(new Date(iso).getTime() - 9 * 3_600_000); // KST wall-clock -> Date
    await maybeSendDailySummary({ now: kst('2026-10-26T08:59:00Z'), post });
    expect(post).not.toHaveBeenCalled();
    await maybeSendDailySummary({ now: kst('2026-10-26T09:05:00Z'), post });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toContain('어제 1개가 생겼어요');
    await maybeSendDailySummary({ now: kst('2026-10-26T15:00:00Z'), post });
    expect(post).toHaveBeenCalledTimes(1);
    expect((await readState()).lastSummaryDay).toBe('2026-10-25');
    await maybeSendDailySummary({ now: kst('2026-10-27T09:00:00Z'), post });
    expect(post).toHaveBeenCalledTimes(1); // day with no changes: nothing sent, but marked
    expect((await readState()).lastSummaryDay).toBe('2026-10-26');
  });
  it('retriesWhenPostFails', async () => {
    await appendRecords([rec('1', '2026-10-25T01:00:00Z')]);
    const post = vi.fn(async (_t: string) => false);
    const now = new Date('2026-10-26T00:10:00Z'); // KST 09:10
    await maybeSendDailySummary({ now, post });
    await maybeSendDailySummary({ now, post });
    expect(post).toHaveBeenCalledTimes(2);
    expect((await readState()).lastSummaryDay).toBeUndefined();
  });
});

describe('maybeHandleChangeQuestion', () => {
  const ev = (text: string) => ({ type: 'app_mention' as const, text, ts: '1.0', channel: 'C1' });
  it('repliesFromRecordsAndIgnoresOtherQuestions', async () => {
    await appendRecords([bucket('a', '2026-10-26T05:02:00Z')]);
    const reply = vi.fn(async (_t: string) => {});
    expect(await maybeHandleChangeQuestion(ev('<@U1> moyeota-media 누가 만들었어?'), { reply })).toBe(true);
    expect(reply.mock.calls[0][0]).toContain('sungyoon님이');
    expect(await maybeHandleChangeQuestion(ev('<@U1> EC2 뭐 있어?'), { reply })).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('fallsThroughWhenNothingFoundWithoutVerb', async () => {
    const reply = vi.fn(async (_t: string) => {});
    for (const text of [
      '<@U1> 누가 Grafana 대시보드 쓰나요?',
      '<@U1> Terraform 누가 설정했어?',
      '<@U1> 누가 nginx 재시작했어?',
      '<@U1> RDS prod-db 누구 팀 거야?',
    ]) expect(await maybeHandleChangeQuestion(ev(text), { reply })).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
  it('answersWithVerbEvenWhenNotFoundAndWithoutVerbWhenFound', async () => {
    const reply = vi.fn(async (_t: string) => {});
    expect(await maybeHandleChangeQuestion(ev('<@U1> moyeota-media 누가 만들었어?'), { reply })).toBe(true);
    expect(reply.mock.calls[0][0]).toContain('찾지 못했어요');
    await appendRecords([bucket('a', '2026-10-26T05:02:00Z')]);
    expect(await maybeHandleChangeQuestion(ev('<@U1> 누가 moyeota-media 건드렸어?'), { reply })).toBe(true);
    expect(reply.mock.calls[1][0]).toContain('sungyoon님이');
  });
  it('doesNotResendWhenStateWriteFails', async () => {
    await appendRecords([rec('1', '2026-10-25T01:00:00Z')]);
    const post = vi.fn(async (_t: string) => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    failWrite.times = 1;
    const now = new Date('2026-10-26T00:10:00Z');
    await maybeSendDailySummary({ now, post });
    await maybeSendDailySummary({ now, post });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
