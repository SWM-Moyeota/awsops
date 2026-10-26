// One @AWSops mention (or one "AI로 원인 분석" click) → placeholder reply in the thread → AI answer replaces it.
// @AWSops 멘션 또는 알림 버튼 클릭 1건 처리: 스레드에 "확인 중" 답글 → AI 답으로 교체.
import {
  extractQuestion, buildConversation, toSlackMessage, footerText,
  PLACEHOLDER_TEXT, HELP_TEXT, type ChatMessage, type ThreadMessage,
} from './format';
import type { AskResult } from './ask';
import { ANALYZE_ACTION_ID, buildAlertBlocks, buildAnalysisPrompt } from './alert';

export interface MentionEvent {
  type: 'app_mention';
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  user_team?: string;
}

/** The three Slack Web API calls the handler needs (wrapped so tests can fake them). */
export interface SlackApi {
  postMessage(args: { channel: string; thread_ts: string; text: string; blocks?: unknown[] }): Promise<{ ts?: string }>;
  update(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
  replies(args: { channel: string; ts: string }): Promise<ThreadMessage[]>;
}

export interface HandleDeps {
  slack: SlackApi;
  ask: (messages: ChatMessage[]) => Promise<AskResult>;
  botUserId: string;
  dashboardUrl?: string;
  /** The bot's own workspace — people from other workspaces (Slack Connect) are ignored. */
  teamId?: string;
  /** Channel allowlist, read per mention so config.json edits apply without a restart. Empty = any channel. */
  allowedChannels?: () => string[] | undefined;
  /** Approval-gated control commands (src/lib/slack-control); true = handled, skip the AI. */
  tryControl?: (event: MentionEvent) => Promise<boolean>;
  /** Rule-based change-timeline answers ("누가 만들었어?"); true = handled, skip the AI. */
  tryChangeQuestion?: (event: MentionEvent) => Promise<boolean>;
  /** Rule-based cost-change answers ("비용 왜 늘었어?"); true = handled, skip the AI. */
  tryCostQuestion?: (event: MentionEvent) => Promise<boolean>;
}

export const CHANNEL_NOT_ALLOWED_TEXT = '이 채널에서는 AWSops에게 물어볼 수 없어요. 관리자에게 채널 추가를 요청해 주세요.';

function describeError(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return '시간 초과';
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

function logName(e: unknown): string {
  const data = (e as { data?: { error?: string } })?.data;
  return data?.error ?? (e instanceof Error ? e.name : 'Error');
}

export async function handleMention(event: MentionEvent, deps: HandleDeps): Promise<void> {
  // Never answer other bots — avoids bot-to-bot loops. / 다른 봇에는 답하지 않는다 (무한 루프 방지)
  if (event.bot_id) return;
  // The bot bypasses Cognito, so only our own workspace and allowed channels may ask.
  // 봇은 Cognito를 거치지 않으므로 우리 워크스페이스와 허용된 채널에서만 답한다.
  if (deps.teamId && event.user_team && event.user_team !== deps.teamId) return;
  const { slack } = deps;
  const channel = event.channel;
  const threadTs = event.thread_ts ?? event.ts;
  const allowed = deps.allowedChannels?.() ?? [];
  if (allowed.length > 0 && !allowed.includes(channel)) {
    await slack.postMessage({ channel, thread_ts: threadTs, text: CHANNEL_NOT_ALLOWED_TEXT });
    return;
  }
  const question = extractQuestion(event.text);

  if (!question) {
    await slack.postMessage({ channel, thread_ts: threadTs, text: HELP_TEXT });
    return;
  }

  // Control commands ("k8s-practice 꺼줘") never reach the AI — they go through the two-step approval.
  // 제어 명령은 AI로 보내지 않고 2단계 승인 흐름으로 처리한다.
  if (deps.tryControl && await deps.tryControl(event)) return;
  // "누가 만들었어?" is answered from CloudTrail records, never by the AI.
  // 생성자 질문은 기록으로만 답한다 (AI 추측 금지).
  if (deps.tryChangeQuestion && await deps.tryChangeQuestion(event)) return;
  // "비용 왜 늘었어?" is answered from snapshots + change records, never by the AI.
  // 비용 변화 질문도 스냅샷·변경 기록으로만 답한다.
  if (deps.tryCostQuestion && await deps.tryCostQuestion(event)) return;

  let messages: ChatMessage[] = [{ role: 'user', content: question }];
  if (event.thread_ts) {
    try {
      const thread = await slack.replies({ channel, ts: event.thread_ts });
      messages = buildConversation(thread, { botUserId: deps.botUserId, currentTs: event.ts, question });
    } catch (e) {
      console.warn(`[slack-chatops] thread history unavailable (${logName(e)}) — answering the question alone`);
    }
  }
  await answerInThread(channel, threadTs, messages, deps);
}

/** Block-actions payload fields we use (Socket Mode `interactive` envelope body). */
export interface AnalyzeClick {
  type: string;
  user?: { id?: string; team_id?: string };
  channel?: { id?: string };
  message?: { ts?: string; text?: string };
  actions?: Array<{ action_id?: string }>;
}

/**
 * "AI로 원인 분석" click on a bot-posted health alert: swap the button for "who asked",
 * then answer in the alert's thread with the alert text as the question.
 * 버튼을 "누가 요청했는지"로 바꾸고, 알림 스레드에 원인 분석을 단다.
 */
export async function handleAnalyzeClick(p: AnalyzeClick, deps: HandleDeps): Promise<void> {
  if (p.type !== 'block_actions' || !p.actions?.some(a => a.action_id === ANALYZE_ACTION_ID)) return;
  if (deps.teamId && p.user?.team_id && p.user.team_id !== deps.teamId) return;
  const channel = p.channel?.id;
  const ts = p.message?.ts;
  const text = p.message?.text;
  if (!channel || !ts || !text) return;

  try {
    await deps.slack.update({ channel, ts, text, blocks: buildAlertBlocks(text, { button: false, requestedBy: p.user?.id }) });
  } catch (e) {
    console.warn(`[slack-chatops] could not mark alert as requested (${logName(e)})`);
  }
  await answerInThread(channel, ts, [{ role: 'user', content: buildAnalysisPrompt(text) }], deps);
}

/** Placeholder in the thread → ask the AI → replace the placeholder; never leaves it hanging. */
async function answerInThread(channel: string, threadTs: string, messages: ChatMessage[], deps: HandleDeps): Promise<void> {
  const { slack } = deps;
  const placeholder = await slack.postMessage({ channel, thread_ts: threadTs, text: PLACEHOLDER_TEXT });
  const reply = async (text: string, blocks?: unknown[]) => {
    if (placeholder.ts) await slack.update({ channel, ts: placeholder.ts, text, ...(blocks ? { blocks } : {}) });
    else await slack.postMessage({ channel, thread_ts: threadTs, text, ...(blocks ? { blocks } : {}) });
  };

  const started = Date.now();
  let answer: AskResult;
  try {
    answer = await deps.ask(messages);
  } catch (e) {
    console.warn(`[slack-chatops] AI request failed (${logName(e)})`);
    await reply(`⚠️ 답을 만들지 못했어요. 잠시 후 다시 물어봐 주세요. (원인: ${describeError(e)})`);
    return;
  }

  const msg = toSlackMessage(answer.content, {
    via: answer.via, seconds: (Date.now() - started) / 1000, dashboardUrl: deps.dashboardUrl,
  });
  try {
    await reply(msg.text, msg.blocks);
  } catch (e) {
    // e.g. invalid_blocks — retry as plain mrkdwn text. / 블록 거부 시 일반 텍스트로 재시도
    console.warn(`[slack-chatops] block reply rejected (${logName(e)}) — retrying as text`);
    try {
      await reply(`${msg.text}\n\n${footerText(msg)}`);
    } catch (e2) {
      // Never leave the "checking" placeholder hanging. / "확인 중" 답글을 그대로 두지 않는다
      console.warn(`[slack-chatops] text reply failed (${logName(e2)})`);
      await reply(`⚠️ 답은 만들었지만 Slack에 올리지 못했어요 (${logName(e2)}). 대시보드 AI 화면에서 다시 물어봐 주세요.`);
    }
  }
}
