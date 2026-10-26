import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectWhoQuestion, answerWho, buildDailySummary, maybeSendDailySummary, maybeHandleChangeQuestion, resetDailySummaryGuard } from '../slack';
import { appendRecords, readState } from '../store';
import { costSummaryLine } from '@/lib/cost-radar/slack';

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

describe('whoQuestionCandidates', () => {
  const ev = (text: string) => ({ type: 'app_mention' as const, text, ts: '1.0', channel: 'C1' });
  it('skipsServiceWordsAndTriesEachCandidate', async () => {
    await appendRecords([
      rec('l', '2026-10-26T05:00:00Z', { resourceType: 'lambda-function', resourceId: 'order-fn', resourceName: 'order-fn' }),
      rec('r', '2026-10-26T05:00:00Z', { resourceType: 'rds-instance', resourceId: 'moyeota-dev-db', resourceName: 'moyeota-dev-db' }),
    ]);
    const reply = vi.fn(async (_t: string) => {});
    expect(await maybeHandleChangeQuestion(ev('<@U1> Lambda 함수 order-fn 누가 만들었어?'), { reply })).toBe(true);
    expect(reply.mock.calls[0][0]).toContain('order-fn');
    expect(reply.mock.calls[0][0]).not.toContain('찾지 못했어요');
    expect(await maybeHandleChangeQuestion(ev('<@U1> RDS moyeota-dev-db 누가 만들었어?'), { reply })).toBe(true);
    expect(reply.mock.calls[1][0]).toContain('moyeota-dev-db');
    expect(await maybeHandleChangeQuestion(ev('<@U1> nothere-xyz order-fn 누가 만들었어?'), { reply })).toBe(true);
    expect(reply.mock.calls[2][0]).toContain('order-fn');
    expect(reply.mock.calls[2][0]).not.toContain('찾지 못했어요');
  });
});

describe('slackEscaping', () => {
  it('escapesNamesAndTarget', () => {
    const r = bucket('a', '2026-10-26T05:02:00Z', { resourceName: '<!channel>', resourceId: 'x', actor: { kind: 'person', name: '<https://x|y>' } });
    const out = answerWho({ kind: 'create', target: '<!channel>&' }, [r]);
    expect(out).not.toMatch(/<[!h]/);
    expect(out).toContain('&lt;!channel&gt;');
    expect(out).toContain('&lt;https://x|y&gt;');
    expect(answerWho({ kind: 'create', target: '<!channel>&' }, [])).toContain('&lt;!channel&gt;&amp;');
    const s = buildDailySummary([rec('1', '2026-10-25T01:00:00Z', { actor: { kind: 'person', name: '<!here>' } })], '2026-10-25')!;
    expect(s).toContain('&lt;!here&gt;');
  });
});

describe('state kinds and cost line', () => {
  it('whoAnswerIgnoresStateKinds', () => {
    const recs = [
      bucket('c', '2026-10-24T01:00:00Z', { kind: 'create' }),
      bucket('s', '2026-10-25T01:00:00Z', { kind: 'stop' }),
      bucket('m', '2026-10-26T01:00:00Z', { kind: 'modify' }),
    ];
    const t = answerWho({ kind: 'delete', target: 'moyeota-media' }, recs);
    expect(t).toContain('아직 있어요');
    expect(answerWho({ kind: 'any', target: 'x' }, [bucket('s', '2026-10-25T01:00:00Z', { kind: 'start' })])).toContain('찾지 못했어요');
    const sum = buildDailySummary([bucket('c', '2026-10-25T01:00:00Z', { kind: 'create' }), bucket('s', '2026-10-25T02:00:00Z', { kind: 'stop' })], '2026-10-25');
    expect(sum).toContain('1개가 생겼어요');
    expect(sum).not.toContain('사라졌어요');
    expect(buildDailySummary([bucket('s', '2026-10-25T02:00:00Z', { kind: 'start' })], '2026-10-25')).toBeNull();
  });

  const now = new Date('2026-10-26T00:10:00Z'); // KST 09:10
  it('summaryOmitsCostLineWhenSmallOrFailing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await appendRecords([rec('1', '2026-10-25T01:00:00Z')]);
    const post = vi.fn(async (_t: string) => true);
    await maybeSendDailySummary({ now, post, costLine: async () => { throw Object.assign(new Error('secret'), { name: 'Boom' }); } });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).not.toContain('💸');
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('Boom');
    expect(logged).not.toContain('secret');
    // small delta: the real provider chain yields null via costSummaryLine
    resetDailySummaryGuard();
    await appendRecords([rec('2', '2026-10-26T01:00:00Z')]);
    const post2 = vi.fn(async (_t: string) => true);
    const small = { mode: 'snapshot', days: 1, fromDay: '2026-10-26', accountId: '__all__', baseMonthly: 100, currentMonthly: 100.4, delta: 0.4, causes: [], unexplained: 0.4 } as const;
    await maybeSendDailySummary({ now: new Date('2026-10-27T00:10:00Z'), post: post2, costLine: async () => costSummaryLine({ ...small, causes: [], notes: [] }) });
    expect(post2).toHaveBeenCalledTimes(1);
    expect(post2.mock.calls[0][0]).not.toContain('💸');
  });
  it('doesNotRecomputeCostLineAfterFailedPost', async () => {
    await appendRecords([rec('1', '2026-10-25T01:00:00Z')]);
    const post = vi.fn(async (_t: string) => false);
    const costLine = vi.fn(async () => '💸 x');
    await maybeSendDailySummary({ now, post, costLine });
    await maybeSendDailySummary({ now, post, costLine });
    expect(post).toHaveBeenCalledTimes(2);
    expect(costLine).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[1][0]).toContain('💸 x');
  });
  it('summaryAppendsCostLine', async () => {
    await appendRecords([rec('1', '2026-10-25T01:00:00Z')]);
    const post = vi.fn(async (_t: string) => true);
    await maybeSendDailySummary({ now, post, costLine: async () => '💸 어제보다 월 예상 비용 +$45.00' });
    expect(post.mock.calls[0][0]).toMatch(/어제 1개가 생겼어요[\s\S]*\n💸 어제보다 월 예상 비용 \+\$45\.00$/);
  });
  // A cost line that never settles. / 끝나지 않는 비용 줄
  const hanging = () => vi.fn(() => new Promise<string | null>(() => {}));
  // One loop tick: wait until the cost line is called (store I/O runs first), then advance fake time.
  // 한 틱: 비용 줄이 호출될 때까지 기다린 뒤 가짜 시간을 돌린다.
  type CostFn = ReturnType<typeof vi.fn>;
  const tick = async (opts: { now: Date; post: (t: string) => Promise<boolean>; costLine: CostFn }, ms = 60_001) => {
    const before = opts.costLine.mock.calls.length;
    let settled = false;
    const p = maybeSendDailySummary(opts as Parameters<typeof maybeSendDailySummary>[0]).then(() => { settled = true; });
    while (!settled && opts.costLine.mock.calls.length === before) await new Promise((r) => setImmediate(r));
    if (!settled && ms > 0) await vi.advanceTimersByTimeAsync(ms);
    await p;
  };
  it('summaryTimesOutSlowCostLineAfter60s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await appendRecords([rec('1', '2026-10-25T01:00:00Z')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const post = vi.fn(async (_t: string) => true);
      const slow = hanging();
      let settled = false;
      const p = maybeSendDailySummary({ now, post, costLine: slow }).then(() => { settled = true; });
      while (slow.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(59_000);
      expect(settled).toBe(false); // 20s is no longer the limit
      await vi.advanceTimersByTimeAsync(1_001);
      await p;
      expect(post).not.toHaveBeenCalled(); // first timeout: summary delayed to the next tick
    } finally { vi.useRealTimers(); }
  });
  it('timedOutCostLineIsNotCachedAndRetriedNextTick', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await appendRecords([rec('1', '2026-10-25T01:00:00Z')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const post = vi.fn(async (_t: string) => true);
      const slow = hanging();
      await tick({ now, post, costLine: slow });
      expect(slow).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled();
      const fast = vi.fn(async () => '💸 x');
      await tick({ now, post, costLine: fast }, 0);
      expect(fast).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toContain('💸 x');
    } finally { vi.useRealTimers(); }
  });
  it('sendsWithoutCostLineAfterTwoDelayedTicks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await appendRecords([rec('1', '2026-10-25T01:00:00Z')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const post = vi.fn(async (_t: string) => true);
      const slow = hanging();
      await tick({ now, post, costLine: slow });
      await tick({ now, post, costLine: slow });
      expect(post).not.toHaveBeenCalled();
      await tick({ now, post, costLine: slow });
      expect(slow).toHaveBeenCalledTimes(3);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toContain('어제 1개가 생겼어요');
      expect(post.mock.calls[0][0]).not.toContain('💸');
      await tick({ now, post, costLine: slow }, 0);
      expect(post).toHaveBeenCalledTimes(1);
      expect(slow).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('aTimedOutLineGivenUpIsNotRecomputedAfterAFailedPost', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await appendRecords([rec('1', '2026-10-25T01:00:00Z')]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const post = vi.fn(async (_t: string) => false);
      const slow = hanging();
      for (let i = 0; i < 3; i++) await tick({ now, post, costLine: slow });
      expect(post).toHaveBeenCalledTimes(1);
      await tick({ now, post, costLine: slow }, 0);
      expect(post).toHaveBeenCalledTimes(2);
      expect(slow).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
