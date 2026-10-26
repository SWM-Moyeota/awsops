// Cost Detective in Slack: "비용 왜 늘었어?" answer and the morning cost line. Rule-based, no LLM.
// explainChange is injected (not imported) so this stays testable and independent of the engine.
// 돈 탐정 Slack 연동: "비용 왜 늘었어?" 답변과 아침 요약의 비용 한 줄. 규칙 기반, AI 미사용.
import type { MentionEvent } from '@/lib/slack-chatops/handle';
import type { ExplainCause, ExplainDays, ExplainResponse } from './types';
import { causeSentence, headline, money } from '@/components/cost-radar/explain-format';

export type ExplainFn = (opts: { accountId: string; days: ExplainDays }) => Promise<ExplainResponse>;

// Wording comes from the shared panel helpers (explain-format); only Slack escaping lives here.
// 문구는 패널과 같은 공용 함수(explain-format)를 쓰고, Slack 이스케이프만 여기서 한다.
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const topCauses = (r: ExplainResponse): ExplainCause[] =>
  [...r.causes].sort((a, b) => Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0));

// A change that already happened (past tense). / 이미 일어난 변화(과거형)
const PAST_CHANGE = /늘었|늘어났|줄었|줄어들었|올랐|내렸|바뀌었|변했|증가했|감소했|많아졌|비싸졌|싸졌/;
// "비용 변화" as a noun, or a change asked about with 원인/이유/왜. / 명사 "변화" 또는 원인을 묻는 "변화"
const CHANGE_NOUN = /(비용|요금|금액|돈)\s*(의\s*)?(변화|변동)|(변화|변동).*(원인|이유)|(원인|이유|왜).*(변화|변동)/;
// Hypothetical / how-to / forecast forms belong to the AI: "바뀌면", "줄이려면", "방안", "추세"…
// 가정·방법·전망 질문은 AI에 맡긴다.
const NOT_EXPLAIN = /면(?=[\s?!.,~]|$)|려면|방법|방안|어떻게|추세|예측|전망|절감|줄이|줄여/;

/**
 * "Why did the cost change?" — a cost word plus a past-tense change ("비용 왜 늘었어", "요금 올랐어?") or a
 * change noun ("요금 변화 (원인) 알려줘"); hypothetical and how-to questions are never taken from the AI.
 * 비용 단어 + 과거형 변화 또는 "변화" 명사. 가정·방법 질문("바뀌면 얼마", "줄이는 방법")은 가로채지 않는다.
 */
export function detectCostQuestion(text: string): boolean {
  const t = text.replace(/<@[^>]+>/g, ' ');
  if (!/비용|돈|요금|금액/.test(t)) return false;
  if (NOT_EXPLAIN.test(t)) return false;
  // "오늘" contains 늘 — strip it before looking for change phrasing. / "오늘"의 '늘' 제외
  const u = t.replace(/오늘/g, ' ');
  return PAST_CHANGE.test(u) || CHANGE_NOUN.test(u);
}

function daysFromText(text: string): ExplainDays {
  if (/한\s*달|(?<!\d)30\s*일|이번\s*달|지난\s*달/.test(text)) return 30;
  if (/일주일|(?<!\d)7\s*일|이번\s*주|지난\s*주|한\s*주/.test(text)) return 7;
  if (/어제|하루|(?<!\d)1\s*일/.test(text)) return 1;
  return 7; // default: "지난 7일 설명" (spec §3 item 7)
}

export function answerCostQuestion(r: ExplainResponse): string {
  const lines: string[] = [];
  const now = r.mode === 'timeline-only' || r.delta === null ? '' : ` (월 예상 ${money(r.currentMonthly, false)})`;
  lines.push(`💸 *${esc(headline(r))}*${now}`);
  const top = topCauses(r).slice(0, 3);
  if (top.length > 0) {
    lines.push('가장 큰 원인');
    for (const c of top) lines.push(`• ${esc(causeSentence(c))} (${money(c.impact, true)})`);
  }
  // Under one cent is rounding noise and is hidden, the same rule as the panel. / 1센트 미만은 숨김 (패널과 동일)
  if (r.unexplained !== null && Number.isFinite(r.unexplained) && Math.abs(r.unexplained) >= 0.01) {
    lines.push(`설명되지 않는 금액: ${money(r.unexplained, true)}`);
  }
  for (const n of r.notes) lines.push(`※ ${esc(n)}`);
  return lines.join('\n');
}

/** Morning line; silent on partial data (anything excluded from the diff) rather than wrong. / 일부 누락이면 생략. */
export function costSummaryLine(r: ExplainResponse | null): string | null {
  if (!r || r.mode === 'timeline-only' || r.delta === null || Math.abs(r.delta) < 1) return null;
  if (r.excluded && r.excluded.length > 0) return null;
  let line = `💸 ${esc(headline(r))}`;
  const c = topCauses(r).find((x) => x.impact !== null);
  if (c) line += ` — 가장 큰 원인: ${esc(causeSentence(c))} (${money(c.impact, true)})`;
  return line;
}

/** Slack hook: answer cost-change questions; true = handled, skip the AI. / true면 AI로 보내지 않는다. */
export async function maybeHandleCostQuestion(
  event: MentionEvent,
  deps: { reply: (text: string) => Promise<void>; explain: ExplainFn },
): Promise<boolean> {
  if (!detectCostQuestion(event.text)) return false;
  try {
    const r = await deps.explain({ accountId: '__all__', days: daysFromText(event.text) });
    await deps.reply(answerCostQuestion(r));
  } catch (e) {
    console.warn(`[cost-radar] cost-question failed (${e instanceof Error ? e.name : 'Error'})`);
    await deps.reply('비용 변화를 계산하지 못했어요. 잠시 후 다시 물어봐 주세요.').catch(() => {});
  }
  return true;
}
