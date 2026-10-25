// Slack entry points for approval-gated EC2 control: a mention creates a request card, button clicks move it
// through the two steps. All permission rules live in requests.ts; this file only routes and redraws.
// 멘션 → 요청 카드 생성, 버튼 클릭 → 2단계 진행. 권한 규칙은 requests.ts에만 있고 여기서는 연결·다시 그리기만 한다.
import { getConfig } from '@/lib/app-config';
import { detectAction, parseControlRequest } from './parse';
import { controlCard, CTL } from './cards';
import { ALLOWED_FROM } from './ec2';
import type { RequestStore, Transition } from './requests';
import type { ControlAction, ControlConfig, ControlRequest, ControllableInstance } from './types';

export interface ControlSlackApi {
  postMessage(args: { channel: string; thread_ts: string; text: string; blocks?: unknown[] }): Promise<{ ts?: string }>;
  update(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
  postEphemeral(args: { channel: string; user: string; text: string; thread_ts?: string }): Promise<unknown>;
}

export interface ControlDeps {
  slack: ControlSlackApi;
  store: RequestStore;
  config: () => ControlConfig | null;
  ec2: {
    list(): Promise<ControllableInstance[]>;
    describe(id: string): Promise<ControllableInstance | null>;
    execute(action: ControlAction, instanceId: string, approverId: string): Promise<{ previous: string; current: string }>;
  };
  audit: (req: ControlRequest) => void;
  teamId?: string;
}

export const CONTROL_DISABLED_TEXT = 'Slack 제어가 아직 설정되지 않았어요 (승인자 미지정). 관리자에게 문의해 주세요.';
const DEFAULT_TTL_MINUTES = 15;

/** `config.json` → `slackControl`; null (disabled) until at least one approver is set. */
export function getControlConfig(): ControlConfig | null {
  const c = getConfig().slackControl;
  const approverIds = (c?.approverIds ?? []).filter(Boolean);
  if (approverIds.length === 0) return null;
  return {
    approverIds,
    allowSelfApproval: c?.allowSelfApproval === true,
    ttlMs: Math.max(1, c?.requestTtlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000,
  };
}

function errName(e: unknown): string {
  const data = (e as { data?: { error?: string } })?.data;
  return data?.error ?? (e instanceof Error ? e.name : 'Error');
}

/**
 * Returns true when the mention was a control command (handled here, not sent to the AI).
 * 제어 명령이면 여기서 처리하고 true — AI에게 보내지 않는다.
 */
export async function maybeHandleControlMention(
  event: { user?: string; text: string; ts: string; thread_ts?: string; channel: string },
  deps: ControlDeps,
): Promise<boolean> {
  if (!event.user || !detectAction(event.text)) return false;
  const channel = event.channel;
  const threadTs = event.thread_ts ?? event.ts;
  const say = (text: string) => deps.slack.postMessage({ channel, thread_ts: threadTs, text });

  const cfg = deps.config();
  if (!cfg) {
    await say(CONTROL_DISABLED_TEXT);
    return true;
  }

  let instances: ControllableInstance[];
  try {
    instances = await deps.ec2.list();
  } catch (e) {
    await say(`⚠️ 제어 가능한 서버 목록을 가져오지 못했어요 (${errName(e)}).`);
    return true;
  }

  const parsed = parseControlRequest(event.text, instances);
  const names = instances.map(i => `\`${i.name || i.id}\``).join(', ');
  if (parsed.kind === 'none') return false;
  if (parsed.kind === 'no-target') {
    await say(instances.length
      ? `제어할 수 있는 서버가 아니에요. 제어 가능한 서버: ${names}\n(태그 \`awsops:control=allow\`가 붙은 서버만 Slack에서 제어할 수 있어요.)`
      : '아직 Slack에서 제어할 수 있는 서버가 없어요. 서버에 태그 `awsops:control=allow`를 붙이면 제어할 수 있어요.');
    return true;
  }
  if (parsed.kind === 'ambiguous') {
    await say(`서버를 하나만 지정해 주세요: ${parsed.candidates.map(i => `\`${i.name || i.id}\``).join(', ')}`);
    return true;
  }

  const req = deps.store.create({ action: parsed.action, instance: parsed.instance, requesterId: event.user, channel, threadTs });
  const card = controlCard(req, cfg);
  const posted = await deps.slack.postMessage({ channel, thread_ts: threadTs, text: card.text, blocks: card.blocks });
  if (posted.ts) deps.store.setCardTs(req.id, posted.ts);
  deps.audit(req);
  return true;
}

export interface ControlClick {
  user?: { id?: string; team_id?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}

async function redraw(req: ControlRequest, cfg: ControlConfig, deps: ControlDeps): Promise<void> {
  deps.audit(req);
  if (!req.cardTs) return;
  const card = controlCard(req, cfg);
  try {
    await deps.slack.update({ channel: req.channel, ts: req.cardTs, text: card.text, blocks: card.blocks });
  } catch (e) {
    console.warn(`[slack-control] card update failed (${errName(e)})`);
  }
}

export async function handleControlAction(p: ControlClick, deps: ControlDeps): Promise<void> {
  const action = p.actions?.[0];
  const userId = p.user?.id;
  const channel = p.channel?.id;
  const id = action?.value;
  if (!action?.action_id || !userId || !channel || !id) return;
  if (deps.teamId && p.user?.team_id && p.user.team_id !== deps.teamId) return;

  const threadTs = p.message?.thread_ts ?? p.message?.ts;
  const tell = (text: string) => deps.slack.postEphemeral({ channel, user: userId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }).catch(() => {});
  const cfg = deps.config();
  if (!cfg) {
    await tell(CONTROL_DISABLED_TEXT);
    return;
  }

  let t: Transition;
  switch (action.action_id) {
    case CTL.confirm: t = deps.store.confirm(id, userId, cfg.ttlMs); break;
    case CTL.cancel: t = deps.store.cancel(id, userId, cfg); break;
    case CTL.reject: t = deps.store.reject(id, userId, cfg); break;
    case CTL.approve: t = deps.store.beginApproval(id, userId, cfg); break;
    default: return;
  }

  if (!t.ok) {
    await tell(`⛔ ${t.reason}`);
    const req = deps.store.get(id);
    if (req?.status === 'expired') await redraw(req, cfg, deps);
    return;
  }

  await redraw(t.req, cfg, deps);
  if (action.action_id !== CTL.approve) return;

  // Re-check right before executing: still tagged, and in a state the action makes sense for.
  // 실행 직전 재확인 — 태그가 그대로인지, 지금 상태에서 할 수 있는 작업인지.
  const req = t.req;
  const fresh = await deps.ec2.describe(req.instance.id);
  if (!fresh) {
    deps.store.finish(req.id, 'failed', '서버가 없거나 제어 허용 태그가 빠졌어요');
  } else if (!ALLOWED_FROM[req.action].includes(fresh.state)) {
    deps.store.finish(req.id, 'failed', `지금 상태(${fresh.state})에서는 이 작업을 할 수 없어요`);
  } else {
    try {
      const r = await deps.ec2.execute(req.action, req.instance.id, userId);
      deps.store.finish(req.id, 'executed', `${r.previous} → ${r.current}`);
    } catch (e) {
      deps.store.finish(req.id, 'failed', `AWS 오류 (${errName(e)})`);
    }
  }
  await redraw(req, cfg, deps);
}
