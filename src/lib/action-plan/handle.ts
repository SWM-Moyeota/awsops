// Slack entry points for safe AI actions: a mention runs plan → validate → resolve → snapshot → policy → dry-run
// and posts one card; button clicks move it through the shared two-step store, re-check drift and execute
// with a session-policy-scoped writer. Undo builds a new request from stored inverses through the same steps.
// 멘션 → 계획·검사·미리 보기 카드, 버튼 → 2단계 승인·재확인·좁은 권한 실행. 되돌리기도 같은 단계를 거친다.
import { detectActionIntent } from './detect';
import { validatePlannerOutput } from './validate';
import { resolveSteps, type ResolveResult } from './resolve';
import { takeSnapshot, SnapshotError } from './snapshot';
import { computeChanges } from './changes';
import { evaluatePolicy } from './policy';
import { buildSessionPolicy, findDrift } from './session-policy';
import { dryRunAll, executeChanges } from './execute';
import { checkUndo, isUndoAvailable, undoSteps } from './undo';
import { actionCard, AP } from './cards';
import { CONTROL_DISABLED_TEXT, type ControlClick, type ControlSlackApi } from '@/lib/slack-control/handle';
import { safeName, sessionLabel } from '@/lib/slack-control/ec2';
import type { ApprovalStore, Transition } from '@/lib/slack-control/requests';
import type {
  ActionPlanConfig, ActionRequest, Ec2Reader, ExecutionRecord, ResolvedStep, Snapshot, TargetRef, WriterFactory,
} from './types';

export interface ActionDeps {
  slack: ControlSlackApi;
  store: ApprovalStore<ActionRequest>;
  config: () => ActionPlanConfig | null;
  enabled: () => boolean;
  planner: (message: string, aliasNames: string[]) => Promise<unknown>;
  reader: Ec2Reader;
  writers: WriterFactory;
  account: () => Promise<string>;
  audit: (req: ActionRequest) => void;
  executions: { save(r: ExecutionRecord): void; load(id: string): ExecutionRecord | null };
  teamId?: string;
  now?: () => Date;
}

export const ACTION_DISABLED_TEXT = 'AI 실행 기능이 꺼져 있어요.';
const REGION = 'ap-northeast-2';
const REWRITE = '처음부터 한 문장으로 다시 써 주세요 (예: "web-dev에 owner 태그를 jiwoo로 붙여줘").';
const MAX_LISTED = 10;
const MAX_PROMPT = 1000;

/** Set on an execution record once an undo built from it has executed — an execution is undone at most once. */
type StoredExecution = ExecutionRecord & { undoneBy?: string };

function errName(e: unknown): string {
  const data = (e as { data?: { error?: string } })?.data;
  return safeName(String(data?.error ?? (e instanceof Error ? e.name : 'Error')));
}

const stripMentions = (text: string) => text.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function candidateList(cands: TargetRef[]): string {
  const shown = cands.slice(0, MAX_LISTED).map(c => `\`${safeName(c.name) || safeName(c.id)}\` (\`${safeName(c.id)}\`)`);
  if (cands.length > MAX_LISTED) shown.push(`외 ${cands.length - MAX_LISTED}개`);
  return shown.join(', ');
}

/** Reply text for a resolve result that is not ok. Names only through safeName; lists capped. */
function resolveProblem(r: Exclude<ResolveResult, { kind: 'ok' }>, cfg: ActionPlanConfig): string {
  if (r.kind === 'too-many-resources') {
    return `한 번에 바꿀 수 있는 리소스는 최대 ${cfg.maxResources}개예요 (이번 요청: ${r.count}개). 나눠서 요청해 주세요.`;
  }
  const ref = safeName(r.ref);
  if (r.kind === 'ambiguous' && r.candidates.length === 0) {
    return `\`${ref}\` 서버에는 AI 실행이 허용된 보안그룹이 없어요 (보안그룹에 태그 \`awsops:control=allow\`가 있어야 해요).`;
  }
  if (r.kind === 'ambiguous') {
    return `\`${ref}\`에 해당하는 대상이 여러 개예요: ${candidateList(r.candidates)}\n하나만 골라서 ${REWRITE}`;
  }
  if (r.candidates.length === 0) {
    return `\`${ref}\`을(를) 찾지 못했어요. 아직 AI로 바꿀 수 있는 리소스가 없어요 (태그 \`awsops:control=allow\`가 있어야 해요).`;
  }
  return `\`${ref}\`을(를) 찾지 못했어요. 바꿀 수 있는 대상: ${candidateList(r.candidates)}\n${REWRITE}`;
}

interface PlanInput {
  steps: ResolvedStep[];
  prompt: string;
  summary: string;
  plannerRaw: unknown;
  requesterId: string;
  channel: string;
  threadTs: string;
  undoOf?: string;
  skippedForDrift?: string[];
  /** Undo already re-read its targets; reuse that read as the plan-time snapshot. */
  snapshot?: Snapshot;
}

/** Spec §3.4–§3.7: snapshot, changes, policy, dry-run, then create the request and post its card. */
async function planAndPost(input: PlanInput, cfg: ActionPlanConfig, deps: ActionDeps, reply: (t: string) => Promise<unknown>): Promise<void> {
  let snapshot: Snapshot;
  try {
    snapshot = input.snapshot ?? await takeSnapshot(input.steps, deps.reader);
  } catch (e) {
    await reply(e instanceof SnapshotError ? `⚠️ ${e.message}` : `⚠️ 현재 상태를 읽지 못했어요 (${errName(e)}).`);
    return;
  }

  const { changes, errors } = computeChanges(input.steps, snapshot);
  if (errors.length) {
    await reply(`계획대로 바꿀 수 없어요: ${errors.map(safeName).join(', ')}`);
    return;
  }
  const active = changes.filter(c => !c.noop);
  if (!active.length) {
    await reply('바꿀 게 없어요. 이미 원하는 상태예요.');
    return;
  }

  const policy = evaluatePolicy(changes, snapshot, cfg);
  // The dry-run is skipped when policy already denied: nothing will run, so no session is assumed.
  let permission: ActionRequest['permission'] = { ok: false, error: 'NotChecked' };
  if (policy.ok) {
    try {
      const sessionPolicy = buildSessionPolicy(active.map(c => c.step), await deps.account(), REGION);
      const writer = await deps.writers(sessionLabel(input.requesterId), sessionPolicy);
      permission = await dryRunAll(changes, writer);
    } catch (e) {
      permission = { ok: false, error: errName(e) };
    }
  }

  const req = deps.store.create({
    prompt: input.prompt,
    summary: input.summary,
    plannerRaw: input.plannerRaw,
    changes,
    snapshot,
    policy,
    permission,
    ...(input.undoOf ? { undoOf: input.undoOf, skippedForDrift: input.skippedForDrift ?? [] } : {}),
    requesterId: input.requesterId,
    channel: input.channel,
    threadTs: input.threadTs,
  });
  const card = actionCard(req, cfg);
  const posted = await deps.slack.postMessage({ channel: input.channel, thread_ts: input.threadTs, text: card.text, blocks: card.blocks });
  if (posted.ts) deps.store.setCardTs(req.id, posted.ts);
  deps.audit(req);
}

/**
 * Returns true when the mention was an action request (handled here, not sent to the AI).
 * 실행 요청이면 여기서 처리하고 true. 플래너가 not-action이라고 하면 false로 다음 단계에 넘긴다.
 */
export async function maybeHandleActionMention(
  event: { user?: string; text: string; ts: string; thread_ts?: string; channel: string },
  deps: ActionDeps,
): Promise<boolean> {
  if (!event.user || !detectActionIntent(event.text)) return false;
  const channel = event.channel;
  const threadTs = event.thread_ts ?? event.ts;
  const say = (text: string) => deps.slack.postMessage({ channel, thread_ts: threadTs, text });

  if (!deps.enabled()) {
    await say(ACTION_DISABLED_TEXT);
    return true;
  }
  const cfg = deps.config();
  if (!cfg) {
    await say(CONTROL_DISABLED_TEXT);
    return true;
  }

  const message = stripMentions(event.text).slice(0, MAX_PROMPT);
  let raw: unknown;
  let validated: ReturnType<typeof validatePlannerOutput>;
  try {
    raw = await deps.planner(message, Object.keys(cfg.sourceAliases));
    validated = validatePlannerOutput(raw, { aliases: cfg.sourceAliases, maxSteps: cfg.maxSteps });
  } catch (e) {
    await say(`계획을 만들지 못했어요 (${errName(e)}).`);
    return true;
  }
  if (!validated.ok) {
    await say(`계획을 만들지 못했어요: ${safeName(validated.error)}\n${REWRITE}`);
    return true;
  }
  const plan = validated.value;
  if (plan.kind === 'not-action') return false;
  if (plan.kind === 'clarify') {
    await say(`${safeName(plan.question)}\n${REWRITE}`);
    return true;
  }

  let resolved: ResolveResult;
  try {
    const [instances, groups] = [await deps.reader.listTaggedInstances(), await deps.reader.listTaggedSecurityGroups()];
    resolved = resolveSteps(plan.steps, { instances, groups }, cfg.maxResources);
  } catch (e) {
    await say(`⚠️ 바꿀 수 있는 리소스 목록을 가져오지 못했어요 (${errName(e)}).`);
    return true;
  }
  if (resolved.kind !== 'ok') {
    await say(resolveProblem(resolved, cfg));
    return true;
  }

  await planAndPost({
    steps: resolved.steps, prompt: message, summary: plan.summary, plannerRaw: raw,
    requesterId: event.user, channel, threadTs,
  }, cfg, deps, say);
  return true;
}

async function redraw(req: ActionRequest, cfg: ActionPlanConfig, deps: ActionDeps): Promise<void> {
  deps.audit(req);
  if (!req.cardTs) return;
  const card = actionCard(req, cfg);
  try {
    await deps.slack.update({ channel: req.channel, ts: req.cardTs, text: card.text, blocks: card.blocks });
  } catch (e) {
    console.warn(`[action-plan] card update failed (${errName(e)})`);
  }
}

/** Approve click that passed beginApproval: re-snapshot, refuse on drift or a policy denial, else execute as the approver. */
async function execute(req: ActionRequest, approverId: string, cfg: ActionPlanConfig, deps: ActionDeps): Promise<void> {
  const active = req.changes.filter(c => !c.noop);
  let fresh: Snapshot;
  try {
    fresh = await takeSnapshot(active.map(c => c.step), deps.reader);
  } catch (e) {
    deps.store.finish(req.id, 'failed', e instanceof SnapshotError ? e.message : `상태를 다시 읽지 못했어요 (${errName(e)})`);
    return;
  }
  const drift = findDrift(req.changes, req.snapshot, fresh);
  if (drift.length) {
    // Reasons carry target names — shown only through the card's sanitizing path (skippedForDrift lines).
    req.skippedForDrift = [...(req.skippedForDrift ?? []), ...drift];
    deps.store.finish(req.id, 'failed', '그 사이 상태가 바뀌었어요, 다시 요청해 주세요');
    return;
  }
  // Rules are re-evaluated on the fresh state: env=prod added or ENIs grown past maxBlastRadius since the
  // preview must still block (drift only looks at the fields the steps touch). Denials carry names — shown only
  // through the card's sanitizing path. 승인 시점 상태로 규칙을 다시 검사한다.
  const recheck = evaluatePolicy(req.changes, fresh, cfg);
  if (!recheck.ok) {
    req.approvalDenials = recheck.denials;
    deps.store.finish(req.id, 'failed', '최종 승인 시점의 규칙 검사에서 거부됐어요');
    return;
  }

  let writer;
  try {
    writer = await deps.writers(sessionLabel(approverId), buildSessionPolicy(active.map(c => c.step), await deps.account(), REGION));
  } catch (e) {
    deps.store.finish(req.id, 'failed', `실행 권한을 받지 못했어요 (${errName(e)})`);
    return;
  }
  const results = await executeChanges(req.changes, writer);
  req.results = results;
  const ok = results.every(r => r.status === 'done');
  deps.store.finish(req.id, ok ? 'executed' : 'failed', ok ? `${results.length}개 단계 완료` : '중간에 실패해서 멈췄어요');

  const now = deps.now?.() ?? new Date();
  try {
    deps.executions.save({
      id: req.id, executedAt: now.toISOString(), requesterId: req.requesterId, approverId,
      channel: req.channel, threadTs: req.threadTs, results, ...(req.undoOf ? { undoOf: req.undoOf } : {}),
    });
    if (ok && req.undoOf) {
      const original = deps.executions.load(req.undoOf);
      if (original) deps.executions.save({ ...original, undoneBy: req.id } as StoredExecution);
    }
  } catch (e) {
    console.warn(`[action-plan] execution record save failed (${errName(e)})`);
  }
}

/** Undo click: a new request from the stored inverses, minus steps changed since, through §3.4–§3.7. */
async function startUndo(execId: string, userId: string, cfg: ActionPlanConfig, deps: ActionDeps, tell: (t: string) => Promise<unknown>): Promise<void> {
  const rec = deps.executions.load(execId) as StoredExecution | null;
  if (!rec) {
    await tell('⛔ 되돌릴 실행 기록을 찾을 수 없어요.');
    return;
  }
  if (rec.undoneBy) {
    await tell('⛔ 이미 되돌렸어요.');
    return;
  }
  if (!isUndoAvailable(rec, cfg.undoHours, deps.now?.() ?? new Date())) {
    await tell(`⛔ 되돌릴 수 있는 시간(${cfg.undoHours}시간)이 지났거나 되돌릴 단계가 없어요.`);
    return;
  }
  let fresh: Snapshot;
  try {
    fresh = await takeSnapshot(undoSteps(rec), deps.reader);
  } catch (e) {
    await tell(e instanceof SnapshotError ? `⚠️ ${e.message}` : `⚠️ 현재 상태를 읽지 못했어요 (${errName(e)}).`);
    return;
  }
  const { steps, skipped } = checkUndo(rec, fresh);
  if (!steps.length) {
    await tell('되돌릴 게 없어요. 그 사이 모든 단계에 다른 변경이 있었어요.');
    return;
  }
  await planAndPost({
    steps, prompt: `되돌리기: 실행 ${rec.id.slice(0, 8)}`, summary: '이전 실행 되돌리기', plannerRaw: null,
    requesterId: userId, channel: rec.channel, threadTs: rec.threadTs,
    undoOf: rec.id, skippedForDrift: skipped, snapshot: fresh,
  }, cfg, deps, tell);
}

export async function handleActionClick(p: ControlClick, deps: ActionDeps): Promise<void> {
  const action = p.actions?.[0];
  const userId = p.user?.id;
  const channel = p.channel?.id;
  const id = action?.value;
  if (!action?.action_id || !userId || !channel || !id) return;
  if (deps.teamId && p.user?.team_id && p.user.team_id !== deps.teamId) return;

  const threadTs = p.message?.thread_ts ?? p.message?.ts;
  const tell = (text: string) => deps.slack.postEphemeral({ channel, user: userId, text, ...(threadTs ? { thread_ts: threadTs } : {}) }).catch(() => {});
  if (!deps.enabled()) {
    await tell(ACTION_DISABLED_TEXT);
    return;
  }
  const cfg = deps.config();
  if (!cfg) {
    await tell(CONTROL_DISABLED_TEXT);
    return;
  }

  if (action.action_id === AP.undo) {
    await startUndo(id, userId, cfg, deps, tell);
    return;
  }

  // A denied card has no buttons; refuse a forged click on it before touching the store.
  if (action.action_id === AP.confirm || action.action_id === AP.approve) {
    const existing = deps.store.get(id);
    if (existing && (!existing.policy.ok || !existing.permission.ok)) {
      await tell('⛔ 규칙 검사나 권한 확인에서 거부돼서 실행할 수 없는 요청이에요.');
      return;
    }
  }

  let t: Transition<ActionRequest>;
  switch (action.action_id) {
    case AP.confirm: t = deps.store.confirm(id, userId, cfg.approval.ttlMs); break;
    case AP.cancel: t = deps.store.cancel(id, userId, cfg.approval); break;
    case AP.reject: t = deps.store.reject(id, userId, cfg.approval); break;
    case AP.approve: t = deps.store.beginApproval(id, userId, cfg.approval); break;
    default: return;
  }

  if (!t.ok) {
    await tell(`⛔ ${t.reason}`);
    const req = deps.store.get(id);
    if (req?.status === 'expired') await redraw(req, cfg, deps);
    return;
  }

  await redraw(t.req, cfg, deps);
  if (action.action_id !== AP.approve) return;

  try {
    await execute(t.req, userId, cfg, deps);
  } catch (e) {
    deps.store.finish(t.req.id, 'failed', `실행 중 오류 (${errName(e)})`);
  }
  await redraw(t.req, cfg, deps);
}
