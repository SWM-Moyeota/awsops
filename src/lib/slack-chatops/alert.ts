// Health alerts sent by the bot (not the webhook) so they can carry an "AI로 원인 분석" button.
// 헬스 알림을 웹훅 대신 봇으로 보내 "AI로 원인 분석" 버튼을 단다. 봇이 없으면 호출자가 웹훅으로 폴백한다.
import { getConfig } from '@/lib/app-config';

export const ANALYZE_ACTION_ID = 'awsops_analyze_alert';
// Slack section text limit is 3,000 chars. / Slack section 텍스트 제한 3,000자
const MAX_SECTION_CHARS = 2_900;

/** What the alert path needs from the live bot — shared across Next.js bundles via globalThis. */
export interface BotHandle {
  postMessage(args: { channel: string; text: string; blocks?: unknown[] }): Promise<{ ts?: string }>;
}

// instrumentation.ts and route handlers are separate webpack bundles with separate module state,
// so the connected bot is published on globalThis. / 번들마다 모듈 상태가 달라 globalThis로 공유한다
const HANDLE_KEY = '__awsopsSlackBotHandle';
type GlobalWithHandle = typeof globalThis & { [HANDLE_KEY]?: BotHandle | null };

export function setBotHandle(handle: BotHandle | null): void {
  (globalThis as GlobalWithHandle)[HANDLE_KEY] = handle;
}

export function getBotHandle(): BotHandle | null {
  return (globalThis as GlobalWithHandle)[HANDLE_KEY] ?? null;
}

/** Alert text as a section, plus the analyze button — or, once clicked, a note saying who asked. */
export function buildAlertBlocks(text: string, opts: { button: boolean; requestedBy?: string }): unknown[] {
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, MAX_SECTION_CHARS) } },
  ];
  if (opts.requestedBy) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🤖 <@${opts.requestedBy}>님이 AI 분석을 요청했어요 — 스레드에서 확인하세요` }],
    });
  } else if (opts.button) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: ANALYZE_ACTION_ID,
        style: 'primary',
        text: { type: 'plain_text', text: '🤖 AI로 원인 분석', emoji: true },
        value: 'analyze',
      }],
    });
  }
  return blocks;
}

export function buildAnalysisPrompt(alertText: string): string {
  return [
    '다음은 AWSops 대시보드의 헬스 알림이야. 지금 상태를 확인해서',
    '1) 가장 가능성 높은 원인, 2) 바로 확인할 순서, 3) 조치 방법을 짧게 알려줘.',
    '테스트 알림이면 현재 AWSops 구성 요소 상태를 간단히 점검해줘.',
    '',
    '---',
    alertText,
  ].join('\n');
}

/**
 * Post an alert through the bot to `config.slackAlertChannelId`.
 * `{ok:false}` without `error` means "bot path not configured" — the caller uses the webhook.
 * 봇 경로가 없으면 error 없이 ok:false — 호출자가 웹훅으로 보낸다.
 */
export async function postAlertViaBot(text: string, opts: { button: boolean }): Promise<{ ok: boolean; error?: string }> {
  const channel = getConfig().slackAlertChannelId;
  const bot = getBotHandle();
  if (!channel || !bot) return { ok: false };
  try {
    await bot.postMessage({ channel, text, blocks: buildAlertBlocks(text, opts) });
    return { ok: true };
  } catch (e) {
    const code = (e as { data?: { error?: string } })?.data?.error ?? (e instanceof Error ? e.name : 'Error');
    return { ok: false, error: `Slack bot post failed (${code})` };
  }
}
