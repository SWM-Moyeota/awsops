// Slack ChatOps bot — Socket Mode connection started once per server process (src/instrumentation.ts).
// Slack ChatOps 봇 — 서버 프로세스당 1회 Socket Mode 연결 (src/instrumentation.ts에서 기동).
// Tokens live only in SSM SecureString and are never logged. / 토큰은 SSM SecureString에만 있고 로그에 남기지 않는다.
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { SocketModeClient, LogLevel } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { getConfig } from '@/lib/app-config';
import { askAwsops } from './ask';
import { createLimiter, createRecentSet } from './concurrency';
import { handleMention, handleAnalyzeClick, type AnalyzeClick, type MentionEvent, type SlackApi } from './handle';
import { setBotHandle } from './alert';
import { createRequestStore } from '@/lib/slack-control/requests';
import { maybeHandleControlMention, handleControlAction, getControlConfig, type ControlDeps } from '@/lib/slack-control/handle';
import { listControllableInstances, describeControllable, executeControl } from '@/lib/slack-control/ec2';
import { appendAudit } from '@/lib/slack-control/audit';
import { CTL_PREFIX } from '@/lib/slack-control/cards';
import type { ThreadMessage } from './format';

export const BOT_TOKEN_PARAM = '/ops/awsops/slack-bot-token';
export const APP_TOKEN_PARAM = '/ops/awsops/slack-app-token';
const SSM_REGION = 'ap-northeast-2';
const SSM_TIMEOUT_MS = 10_000;
// Each answer may run several Steampipe queries — keep the pg pool (max 10) free for the dashboard.
// 답변마다 Steampipe 쿼리가 돌 수 있어 동시 2건으로 제한 (pg 풀 max 10 보호)
const MAX_CONCURRENT_ANSWERS = 2;
const DEFAULT_DASHBOARD_URL = 'https://awsops.moyeota.co.kr/';
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const FATAL_SLACK_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'not_allowed_token_type']);

let started = false;
let status: { connected: boolean; reason?: string } = { connected: false, reason: 'not started' };

export function getSlackChatopsStatus() {
  return { ...status };
}

async function loadTokens(): Promise<{ botToken: string; appToken: string } | null> {
  const client = new SSMClient({ region: SSM_REGION });
  const out = await client.send(
    new GetParametersCommand({ Names: [BOT_TOKEN_PARAM, APP_TOKEN_PARAM], WithDecryption: true }),
    { abortSignal: AbortSignal.timeout(SSM_TIMEOUT_MS) },
  );
  const byName = new Map((out.Parameters ?? []).map(p => [p.Name, p.Value?.trim() ?? '']));
  const botToken = byName.get(BOT_TOKEN_PARAM) ?? '';
  const appToken = byName.get(APP_TOKEN_PARAM) ?? '';
  if (!botToken.startsWith('xoxb-') || !appToken.startsWith('xapp-')) return null;
  return { botToken, appToken };
}

function slackApi(web: WebClient): SlackApi {
  return {
    async postMessage(args) {
      const r = await web.chat.postMessage(args as Parameters<WebClient['chat']['postMessage']>[0]);
      return { ts: r.ts };
    },
    async update(args) {
      return web.chat.update(args as Parameters<WebClient['chat']['update']>[0]);
    },
    async replies({ channel, ts }) {
      // Replies come oldest-first — page through so long threads still give the latest context.
      // 오래된 순으로 오므로 페이지를 넘겨 긴 스레드에서도 최근 맥락을 얻는다 (최대 5페이지)
      const all: ThreadMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const r = await web.conversations.replies({ channel, ts, limit: 200, cursor });
        all.push(...((r.messages ?? []) as ThreadMessage[]));
        cursor = r.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      return all;
    },
  };
}

function errName(e: unknown): string {
  const data = (e as { data?: { error?: string } })?.data;
  return data?.error ?? (e instanceof Error ? e.name : 'Error');
}

class TokensMissing extends Error { name = 'TokensMissing'; }

async function connect(): Promise<void> {
  const tokens = await loadTokens();
  if (!tokens) throw new TokensMissing();
  // Cap Slack API retries so a rate-limited reply can't hold an answer slot for many minutes.
  // Slack API 재시도 상한 — 레이트 리밋 시 답변 슬롯을 오래 붙잡지 않도록
  const web = new WebClient(tokens.botToken, { logLevel: LogLevel.ERROR, retryConfig: { retries: 2 } });
  const auth = await web.auth.test();
  const botUserId = auth.user_id ?? '';

  const socket = new SocketModeClient({ appToken: tokens.appToken, logLevel: LogLevel.WARN });
  const limit = createLimiter(MAX_CONCURRENT_ANSWERS);
  const seen = createRecentSet(500);
  const control: ControlDeps = {
    slack: {
      postMessage: args => slackApi(web).postMessage(args),
      update: args => web.chat.update(args as Parameters<WebClient['chat']['update']>[0]),
      postEphemeral: args => web.chat.postEphemeral(args as Parameters<WebClient['chat']['postEphemeral']>[0]),
    },
    store: createRequestStore(),
    config: getControlConfig,
    ec2: { list: listControllableInstances, describe: describeControllable, execute: executeControl },
    audit: req => appendAudit(req),
    teamId: auth.team_id,
  };
  const deps = {
    tryControl: (event: MentionEvent) => maybeHandleControlMention(event, control),
    slack: slackApi(web),
    ask: askAwsops,
    botUserId,
    teamId: auth.team_id,
    allowedChannels: () => getConfig().slackAllowedChannelIds,
    dashboardUrl: getConfig().appUrl || DEFAULT_DASHBOARD_URL,
  };

  socket.on('app_mention', async ({ ack, event, body }: { ack: () => Promise<void>; event: MentionEvent; body?: { event_id?: string } }) => {
    // Ack within 3s or Slack redelivers; the answer is posted later. / 3초 안에 ack — 답은 나중에 게시
    await ack();
    if (!seen.addIfNew(body?.event_id ?? `${event.channel}:${event.ts}`)) return;
    // Channel IDs are not secret — logged so an admin can find the alert channel for config.json.
    // 채널 ID는 비밀이 아니다 — slackAlertChannelId 설정용으로 남긴다
    console.log(`[slack-chatops] mention in channel ${event.channel}`);
    limit(() => handleMention(event, deps)).catch(e => {
      console.warn(`[slack-chatops] mention handling failed (${errName(e)})`);
    });
  });

  // Button clicks ("AI로 원인 분석") arrive over the same socket as `interactive` envelopes.
  // 버튼 클릭도 같은 소켓으로 들어온다 (interactive). 알림 1건당 분석은 1번만.
  const analyzed = createRecentSet(500);
  socket.on('interactive', async ({ ack, body }: { ack: () => Promise<void>; body: AnalyzeClick }) => {
    await ack();
    // Control buttons: repeated clicks on one card are legitimate (step 1, then step 2) — the request
    // store's state machine guarantees single execution, so no message-level dedupe here.
    // 제어 버튼은 한 카드에서 여러 번 눌리는 게 정상 — 1회 실행은 요청 저장소가 보장한다.
    const ctl = body as AnalyzeClick & { actions?: Array<{ action_id?: string; value?: string }> };
    if (body.type === 'block_actions' && ctl.actions?.some(a => a.action_id?.startsWith(CTL_PREFIX))) {
      handleControlAction(ctl, control).catch(e => {
        console.warn(`[slack-control] action failed (${errName(e)})`);
      });
      return;
    }
    const key = `${body.channel?.id}:${body.message?.ts}`;
    if (body.type !== 'block_actions' || !analyzed.addIfNew(key)) return;
    limit(() => handleAnalyzeClick(body, deps)).catch(e => {
      console.warn(`[slack-chatops] alert analysis failed (${errName(e)})`);
    });
  });
  socket.on('connected', () => { status = { connected: true }; });
  socket.on('disconnected', () => { status = { connected: false, reason: 'disconnected (auto-reconnecting)' }; });

  try {
    await socket.start();
  } catch (e) {
    // Don't leave a half-open client auto-reconnecting next to the retry's new one.
    await socket.disconnect().catch(() => {});
    throw e;
  }
  status = { connected: true };
  // Let the health monitor post alerts (with the analyze button) through this bot.
  setBotHandle({
    async postMessage(args) {
      const r = await web.chat.postMessage(args as Parameters<WebClient['chat']['postMessage']>[0]);
      return { ts: r.ts };
    },
  });
  console.log(`[slack-chatops] connected as ${auth.user ?? botUserId} (Socket Mode)`);
}

/**
 * Idempotent, never throws. Production server only — `next dev` on a laptop would open a second
 * Socket Mode connection and Slack would split mentions between the two.
 * Missing tokens → stays off (one log line). Other boot failures (SSM/network not ready) retry with backoff.
 * 프로덕션 서버에서만 동작 — dev 서버가 두 번째 연결을 열면 Slack이 멘션을 나눠 보낸다.
 * 토큰 없음 → 꺼진 채로 둠. 그 외 기동 실패는 점점 길게 기다리며 재시도.
 */
export async function startSlackChatops(): Promise<void> {
  if (started) return;
  started = true;
  if (process.env.NODE_ENV !== 'production' || process.env.SLACK_CHATOPS_DISABLED === '1') {
    status = { connected: false, reason: 'disabled (non-production or SLACK_CHATOPS_DISABLED)' };
    return;
  }
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      await connect();
      return;
    } catch (e) {
      if (e instanceof TokensMissing) {
        status = { connected: false, reason: 'tokens not configured' };
        console.log(`[slack-chatops] off — SSM ${BOT_TOKEN_PARAM} / ${APP_TOKEN_PARAM} not set (scripts/15-setup-slack-chatops.sh)`);
        return;
      }
      // Wrong/revoked tokens won't fix themselves — stop instead of retrying.
      const delay = FATAL_SLACK_ERRORS.has(errName(e)) ? undefined : RETRY_DELAYS_MS[attempt];
      status = { connected: false, reason: `start failed (${errName(e)})` };
      if (delay === undefined) {
        console.warn(`[slack-chatops] start failed (${errName(e)}) — giving up, restart the server to retry`);
        return;
      }
      console.warn(`[slack-chatops] start failed (${errName(e)}) — retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
