// Cost Detective in Slack: "비용 왜 늘었어?" answer and the morning cost line. Rule-based, no LLM.
// explainChange is injected (not imported) so this stays testable and independent of the engine.
// 돈 탐정 Slack 연동: "비용 왜 늘었어?" 답변과 아침 요약의 비용 한 줄. 규칙 기반, AI 미사용.
import type { MentionEvent } from '@/lib/slack-chatops/handle';
import type { CategoryId, ExplainCause, ExplainDays, ExplainResponse } from './types';

export type ExplainFn = (opts: { accountId: string; days: ExplainDays }) => Promise<ExplainResponse>;

// TODO(integration): dedupe with explain-format
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n: number): string => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
const signed = (n: number): string => `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`;
const CAT: Record<CategoryId, string> = {
  ec2: 'EC2', loadbalancer: '로드밸런서', nat: 'NAT', 'vpc-endpoint': 'VPC 엔드포인트',
  'public-ip': '퍼블릭 IP', storage: '스토리지', rds: 'RDS', elasticache: 'ElastiCache',
};
const sinceLabel = (days: ExplainDays): string => (days === 1 ? '어제' : `${days}일 전`);
const actorLabel = (a: NonNullable<ExplainCause['actor']>): string => (a.kind === 'person' ? `${a.name}님` : a.name);
const ACTION: Record<string, string> = { create: '생성', delete: '삭제', stop: '중지', start: '시작', modify: '변경' };
const topCauses = (r: ExplainResponse): ExplainCause[] =>
  [...r.causes].sort((a, b) => Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0));

export function detectCostQuestion(text: string): boolean {
  const t = text.replace(/<@[^>]+>/g, ' ');
  if (!/비용|돈|요금|금액/.test(t)) return false;
  // "오늘" contains 늘 — strip it before looking for change phrasing. / "오늘"의 '늘' 제외
  const u = t.replace(/오늘/g, ' ');
  return /늘었|줄었|올랐|내렸|늘어|줄어|증가|감소|변화|바뀌|왜.*(늘|올|증가|많아졌|비싸졌)/.test(u);
}

function daysFromText(text: string): ExplainDays {
  if (/한\s*달|(?<!\d)30\s*일|이번\s*달|지난\s*달/.test(text)) return 30;
  if (/일주일|(?<!\d)7\s*일|이번\s*주|지난\s*주|한\s*주/.test(text)) return 7;
  if (/어제|하루|(?<!\d)1\s*일/.test(text)) return 1;
  return 7; // default: "지난 7일 설명" (spec §3 item 7)
}

export function answerCostQuestion(r: ExplainResponse): string {
  const lines: string[] = [];
  if (r.mode === 'timeline-only' || r.delta === null) {
    lines.push('💸 *비용이 얼마나 바뀌었는지는 아직 정확히 알 수 없어요*');
  } else if (Math.abs(r.delta) < 1) {
    lines.push(`💸 *${sinceLabel(r.days)}와 월 예상 비용이 거의 같아요* (${signed(r.delta)})`);
  } else {
    lines.push(`💸 *${sinceLabel(r.days)}보다 월 예상 비용이 ${signed(r.delta)} ${r.delta > 0 ? '늘었어요' : '줄었어요'}* (${money(r.currentMonthly)})`);
  }
  const top = topCauses(r).slice(0, 3);
  if (top.length > 0) {
    lines.push('가장 큰 원인');
    for (const c of top) {
      const who = c.actor ? `${esc(actorLabel(c.actor))}${c.actor.kind === 'person' ? '이' : ''} ` : '누가 했는지 기록 없음 · ';
      const a = c.action ? ACTION[c.action] : undefined;
      const act = a ? ` ${a}` : '';
      lines.push(`• ${who}${CAT[c.category] ?? c.category} ${esc(c.name)}${act} (${c.impact === null ? '금액 미상' : signed(c.impact)})`);
    }
  }
  if (r.unexplained !== null) lines.push(`설명되지 않는 금액: ${signed(r.unexplained)}`);
  for (const n of r.notes) lines.push(`※ ${esc(n)}`);
  return lines.join('\n');
}

export function costSummaryLine(r: ExplainResponse | null): string | null {
  if (!r || r.mode === 'timeline-only' || r.delta === null || Math.abs(r.delta) < 1) return null;
  let line = `💸 ${sinceLabel(r.days)}보다 월 예상 비용 ${signed(r.delta)}`;
  const c = topCauses(r).find((x) => x.impact !== null);
  if (c) {
    const who = c.actor ? `${actorLabel(c.actor)} ` : '';
    line += ` — 가장 큰 원인: ${esc(`${who}${CAT[c.category] ?? c.category} ${c.name}`)} (${signed(c.impact as number)})`;
  }
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
