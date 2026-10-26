import { describe, it, expect, vi } from 'vitest';
import { detectCostQuestion, answerCostQuestion, costSummaryLine, maybeHandleCostQuestion } from '../slack';
import type { ExplainResponse, ExplainCause } from '../types';

const cause = (over: Partial<ExplainCause> = {}): ExplainCause => ({
  kind: 'added', accountId: '1', resourceId: 'r', name: 'moyeota-test-db', category: 'rds',
  monthlyBefore: null, monthlyAfter: 38, impact: 38, action: 'create', actor: { kind: 'person', name: 'jiwoo' }, ...over,
});
const resp = (over: Partial<ExplainResponse> = {}): ExplainResponse => ({
  mode: 'snapshot', days: 1, fromDay: '2026-10-26', accountId: '__all__', baseMonthly: 1000, currentMonthly: 1045,
  delta: 45, causes: [cause()], unexplained: 7, notes: [], ...over,
});

describe('detectCostQuestion', () => {
  it('detectsCostQuestions', () => {
    for (const t of ['<@U1> 비용 왜 늘었어?', '비용 왜 늘었어?', '돈 왜 이렇게 늘었지', '요금 변화 알려줘', '이번 주 비용 왜 올랐어', '요금 올랐어?', '<@U1> 이번 주 금액 변화 알려줘', '비용 줄었어?']) expect(detectCostQuestion(t)).toBe(true);
    for (const t of ['<@U1> 비용 레이더 링크 줘', '왜 느려?', '비용', 'EC2 뭐 있어?', '오늘 EC2 비용 알려줘', '오늘 비용 얼마야?', 'RDS 비용 줄이는 방법', '비용 줄여줘', '인스턴스 늘리면 요금 어때?', '돈 왜 이렇게 나가']) expect(detectCostQuestion(t)).toBe(false);
  });
});

describe('answerCostQuestion', () => {
  it('answerHasHeadlineTop3AndUnexplained', () => {
    const causes = [1, 2, 3, 4].map((i) => cause({ name: `db-${i}<x>&`, impact: 10 * (5 - i) }));
    const t = answerCostQuestion(resp({ causes }));
    expect(t).toContain('$45.00 늘었어요');
    expect(t).toContain('db-1&lt;x&gt;&amp;');
    expect(t).toContain('db-3');
    expect(t).not.toContain('db-4');
    expect(t).toContain('+$7.00');
    expect(t).toContain('jiwoo님이');
  });
  it('handlesTimelineOnlyAndMissingActor', () => {
    const t = answerCostQuestion(resp({ mode: 'timeline-only', delta: null, unexplained: null, baseMonthly: null, causes: [cause({ actor: undefined, impact: null })], notes: ['스냅샷이 아직 없어요'] }));
    expect(t).toContain('스냅샷이 아직 없어요');
    expect(t).toContain('기록 없음');
  });
});

describe('costSummaryLine', () => {
  it('costSummaryLineThresholdAndTimelineMode', () => {
    expect(costSummaryLine(null)).toBeNull();
    expect(costSummaryLine(resp({ mode: 'timeline-only' }))).toBeNull();
    expect(costSummaryLine(resp({ delta: 0.4 }))).toBeNull();
    expect(costSummaryLine(resp({ delta: -0.99 }))).toBeNull();
    expect(costSummaryLine(resp())).toBe('💸 어제보다 월 예상 비용이 $45.00 늘었어요 — 가장 큰 원인: jiwoo님이 RDS moyeota-test-db를 만들었어요 (+$38.00)');
    expect(costSummaryLine(resp({ delta: -12.4, causes: [] }))).toBe('💸 어제보다 월 예상 비용이 $12.40 줄었어요');
  });
});

describe('maybeHandleCostQuestion', () => {
  const ev = (text: string) => ({ type: 'app_mention' as const, text, ts: '1.0', channel: 'C1' });
  it('answersViaInjectedExplainAndIgnoresOthers', async () => {
    const reply = vi.fn(async (_t: string) => {});
    const explain = vi.fn(async () => resp());
    expect(await maybeHandleCostQuestion(ev('<@U1> 비용 레이더 링크 줘'), { reply, explain })).toBe(false);
    expect(explain).not.toHaveBeenCalled();
    expect(await maybeHandleCostQuestion(ev('<@U1> 비용 왜 늘었어?'), { reply, explain })).toBe(true);
    expect(explain).toHaveBeenCalledWith({ accountId: '__all__', days: 7 });
    expect(reply.mock.calls[0][0]).toContain('$45.00 늘었어요');
  });
  it('picksDaysFromText', async () => {
    const reply = vi.fn(async (_t: string) => {});
    const explain = vi.fn(async () => resp({ days: 7 }));
    const days = async (t: string) => { explain.mockClear(); await maybeHandleCostQuestion(ev(t), { reply, explain }); return (explain.mock.calls[0] as unknown[])[0]; };
    expect(await days('이번 주 비용 왜 늘었어')).toEqual({ accountId: '__all__', days: 7 });
    expect(await days('어제 비용 왜 늘었어')).toEqual({ accountId: '__all__', days: 1 });
    expect(await days('하루 새 비용 왜 늘었어')).toEqual({ accountId: '__all__', days: 1 });
    expect(await days('한 달 비용 왜 늘었어')).toEqual({ accountId: '__all__', days: 30 });
    expect(await days('30일 비용 왜 늘었어')).toEqual({ accountId: '__all__', days: 30 });
    expect(await days('17일 비용 왜 늘었어')).toEqual({ accountId: '__all__', days: 7 });
    expect(await days('130일 비용 왜 늘었어')).toEqual({ accountId: '__all__', days: 7 });
  });
  it('repliesWithoutDetailOnFailure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reply = vi.fn(async (_t: string) => {});
    const explain = vi.fn(async () => { throw Object.assign(new Error('secret'), { name: 'Boom' }); });
    expect(await maybeHandleCostQuestion(ev('비용 왜 늘었어'), { reply, explain })).toBe(true);
    expect(reply.mock.calls[0][0]).not.toContain('secret');
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('Boom');
    expect(logged).not.toContain('secret');
  });
});
