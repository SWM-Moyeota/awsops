// Pure helpers for Slack ChatOps: question parsing, thread → AI conversation, answer formatting.
// Slack ChatOps 순수 함수: 질문 추출, 스레드 → AI 대화 변환, 답변 포맷.

export type ChatRole = 'user' | 'assistant';
export interface ChatMessage { role: ChatRole; content: string }

export interface ThreadMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
}

export const PLACEHOLDER_TEXT = '🔍 확인 중이에요... 잠시만 기다려 주세요.';
export const HELP_TEXT = '무엇이든 물어보세요. 예: `@AWSops 지금 켜진 EC2 뭐 있어?`';
// Slack markdown block allows 12,000 chars cumulative — keep headroom for the truncation note.
// Slack markdown 블록은 누적 12,000자 제한 — 잘림 안내 문구 여유분을 남긴다.
export const MAX_ANSWER_CHARS = 11_000;
const MAX_PRIOR_MESSAGES = 10;
const TRUNCATED_NOTE = '\n\n…(답이 길어서 잘렸어요. 대시보드 AI 화면에서 다시 물어보면 전체를 볼 수 있어요)';

/** Remove `<@U123>` / `<@U123|name>` mentions and collapse whitespace. */
export function extractQuestion(text: string): string {
  return text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Turn a Slack thread into the `messages` array `/api/ai` expects.
 * Only our bot's messages are `assistant`; everyone else — including other bots such as
 * the health-alert webhook — is `user`, so replying in an alert thread carries the alert as context.
 * 우리 봇 메시지만 assistant — 헬스 알림 웹훅 같은 다른 봇은 user로 넣어 알림 스레드에서 물으면 알림 내용이 맥락이 된다.
 */
export function buildConversation(
  thread: ThreadMessage[],
  opts: { botUserId: string; currentTs: string; question: string },
): ChatMessage[] {
  const current = Number(opts.currentTs);
  const prior = thread
    .filter(m => Number(m.ts) < current && m.text && m.text !== PLACEHOLDER_TEXT)
    .slice(-MAX_PRIOR_MESSAGES)
    .map((m): ChatMessage => ({
      role: m.user === opts.botUserId ? 'assistant' : 'user',
      content: m.user === opts.botUserId ? (m.text ?? '').trim() : extractQuestion(m.text ?? ''),
    }))
    .filter(m => m.content);

  const merged: ChatMessage[] = [];
  for (const m of [...prior, { role: 'user' as const, content: opts.question }]) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  // Bedrock requires the conversation to start with a user turn. / Bedrock은 user 턴으로 시작해야 한다
  while (merged.length > 1 && merged[0].role === 'assistant') merged.shift();
  return merged;
}

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Best-effort Markdown → Slack mrkdwn for the plain-text fallback. Code fences are left as-is. */
export function markdownToMrkdwn(md: string): string {
  return md.split('```').map((part, i) => {
    const escaped = escapeMrkdwn(part);
    if (i % 2 === 1) return escaped;
    return escaped
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/^#{1,6}\s+(.+)$/gm, (_, h: string) => `*${h.replace(/\*/g, '')}*`);
  }).join('```');
}

export interface SlackMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

/** Answer as a `markdown` block + a small context footer; `text` is the mrkdwn fallback. */
export function toSlackMessage(
  answer: string,
  meta: { via?: string; seconds: number; dashboardUrl?: string },
): SlackMessage {
  const body = answer.length > MAX_ANSWER_CHARS ? answer.slice(0, MAX_ANSWER_CHARS) + TRUNCATED_NOTE : answer;
  const footer = [
    meta.via ? escapeMrkdwn(meta.via) : null,
    `${Math.round(meta.seconds)}초`,
    meta.dashboardUrl ? `<${meta.dashboardUrl.replace(/\/+$/, '')}/ai|대시보드 AI에서 이어 묻기>` : null,
  ].filter(Boolean).join(' · ');
  return {
    text: markdownToMrkdwn(body),
    blocks: [
      { type: 'markdown', text: body },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] },
    ],
  };
}

/** Plain-text version (no blocks) used when Slack rejects the markdown block. */
export function footerText(msg: SlackMessage): string {
  const ctx = msg.blocks[1] as { elements?: Array<{ text?: string }> } | undefined;
  return ctx?.elements?.[0]?.text ?? '';
}
