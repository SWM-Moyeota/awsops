// The one Slack card an action request lives in — redrawn on every state change (spec §3.6).
// 실행 요청 카드 하나를 상태가 바뀔 때마다 다시 그린다.
import { safeName } from '@/lib/slack-control/ec2';
import type { ActionPlanConfig, ActionRequest, StepChange, StepResult } from './types';

export const AP_PREFIX = 'awsops_ap_';
export const AP = {
  confirm: 'awsops_ap_confirm',
  cancel: 'awsops_ap_cancel',
  approve: 'awsops_ap_approve',
  reject: 'awsops_ap_reject',
  undo: 'awsops_ap_undo',
} as const;

// Same character stripping as safeName, with a caller-chosen length (quote 200, step lines longer).
// safeName과 같은 문자 제거, 길이만 다르게.
const clean = (raw: unknown, max: number) =>
  String(raw ?? '').replace(/[`<>&*_~|\r\n]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

const btn = (actionId: string, text: string, value: string, style?: 'primary' | 'danger', confirm?: unknown) => ({
  type: 'button', action_id: actionId, value, text: { type: 'plain_text', text, emoji: true },
  ...(style ? { style } : {}), ...(confirm ? { confirm } : {}),
});

const ctx = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

const target = (c: StepChange) => `\`${safeName(c.step.target.name) || safeName(c.step.target.id)}\` (\`${safeName(c.step.target.id)}\`)`;
const stepLine = (c: StepChange) => `${target(c)} · ${clean(c.before, 120)} → ${clean(c.after, 120)}`;

function blastLines(req: ActionRequest): string[] {
  const out: string[] = [];
  const active = req.changes.filter(c => !c.noop);
  const stops = new Set(active.filter(c => c.step.action === 'ec2.stop').map(c => c.step.target.id));
  if (stops.size) out.push(`• 서버 ${stops.size}대가 꺼져요`);
  const sgs = new Set(active.filter(c => c.step.action.startsWith('sg.')).map(c => c.step.target.id));
  for (const id of Array.from(sgs)) {
    const snap = req.snapshot[id];
    const n = snap?.eniCount ?? 0;
    const list = (snap?.attachedInstances ?? []).map(i => safeName(i.name) || safeName(i.id));
    const name = safeName(snap?.name || id);
    out.push(list.length
      ? `• \`${name}\` 보안그룹을 쓰는 서버 ${list.length}대: ${list.join(', ')}`
      : `• \`${name}\` 보안그룹을 쓰는 네트워크 인터페이스 ${n}개`);
  }
  return out;
}

function resultLines(req: ActionRequest): string[] {
  const results = req.results ?? [];
  const byIndex = new Map<number, StepResult>(results.map(r => [r.index, r]));
  const lines: string[] = [];
  for (const c of req.changes.filter(c => !c.noop)) {
    const r = byIndex.get(c.index);
    const status = r?.status ?? 'not-run';
    const mark = status === 'done' ? '✅ 완료' : status === 'failed' ? `⚠️ 실패${r?.error ? ` (${clean(r.error, 64)})` : ''}` : '⏸ 실행 안 함';
    lines.push(`${mark} — ${stepLine(c)}`);
  }
  return lines;
}

const canUndo = (req: ActionRequest) =>
  (req.status === 'executed' || req.status === 'failed') &&
  (req.results ?? []).some(r => r.status === 'done' && !!r.inverse);

export function actionCard(req: ActionRequest, cfg: ActionPlanConfig): { text: string; blocks: unknown[] } {
  const active = req.changes.filter(c => !c.noop);
  const noops = req.changes.filter(c => c.noop);
  const denied = !req.policy.ok || !req.permission.ok;
  const parts: string[] = [
    req.undoOf ? '↩️ *AWS 되돌리기 요청*' : '🛠 *AWS 실행 요청*',
    `• 요청자: <@${req.requesterId}>`,
    `• 요청 내용: "${clean(req.prompt, 200)}"`,
  ];
  if (req.summary) parts.push(`• 요약: ${safeName(req.summary)}`);
  if (active.length) parts.push('', '*바뀌는 내용*', ...active.map((c, i) => `${i + 1}. ${stepLine(c)}`));
  if (noops.length) parts.push('', '*이미 되어 있어요 (건너뜀)*', ...noops.map(c => `• ${stepLine(c)}`));
  const blast = blastLines(req);
  if (blast.length) parts.push('', '*영향 범위*', ...blast);
  if (req.skippedForDrift?.length) {
    parts.push('', '*그 사이 바뀌어서 건너뛴 항목*', ...req.skippedForDrift.map(s => `• ${clean(s, 120)}`));
  }

  parts.push('', '*규칙 검사*');
  parts.push(...(req.policy.ok ? ['• ✅ 통과'] : req.policy.denials.map(d => `• ⛔ ${clean(d, 160)}`)));
  parts.push('*권한 미리 확인*');
  parts.push(req.permission.ok
    ? '• ✅ 실행 권한이 있어요'
    : `• ⛔ 실행 권한이 없어요 — 관리자가 \`scripts/17-setup-action-executor.sh\`에 이 리소스를 등록해야 해요.${req.permission.error ? ` (${clean(req.permission.error, 64)})` : ''}`);
  if (!denied && !req.undoOf && active.every(c => c.inverse || c.step.action === 'sg.ingress.add')) {
    parts.push('', `↩️ 되돌릴 수 있어요 (${cfg.undoHours}시간 안)`);
  }

  const blocks: unknown[] = [section(parts.join('\n'))];
  const minutes = Math.round(cfg.approval.ttlMs / 60_000);
  const approvers = cfg.approval.approverIds.map(id => `<@${id}>`).join(', ');

  if (denied && (req.status === 'proposed' || req.status === 'pending')) {
    blocks.push(ctx('🚫 이 요청은 실행할 수 없어요. 내용을 바꿔서 다시 요청해 주세요.'));
    return { text: `AWS 실행 요청: 실행할 수 없어요 (${req.status})`, blocks };
  }

  switch (req.status) {
    case 'proposed':
      blocks.push(ctx(`*1단계 / 2* — <@${req.requesterId}>님, 내용이 맞는지 확인해 주세요. ${minutes}분 뒤 만료돼요.`));
      blocks.push({ type: 'actions', elements: [
        btn(AP.confirm, '✅ 맞아요, 승인 요청', req.id, 'primary'),
        btn(AP.cancel, '취소', req.id),
      ] });
      break;
    case 'pending':
      blocks.push(ctx(`*2단계 / 2* — 승인자(${approvers}) 중 한 명이 최종 승인해야 실행돼요.${cfg.approval.allowSelfApproval ? '' : ' 요청자 본인은 승인할 수 없어요.'}`));
      blocks.push({ type: 'actions', elements: [
        btn(AP.approve, '✅ 최종 승인', req.id, 'primary', {
          title: { type: 'plain_text', text: '정말 실행할까요?' },
          text: { type: 'mrkdwn', text: `위 ${active.length}개 단계를 순서대로 실행해요.` },
          confirm: { type: 'plain_text', text: '실행' },
          deny: { type: 'plain_text', text: '돌아가기' },
        }),
        btn(AP.reject, '❌ 거절', req.id, 'danger'),
      ] });
      break;
    case 'executing':
      blocks.push(ctx(`⏳ <@${req.deciderId}>님이 승인 — 실행 중이에요...`));
      break;
    case 'executed':
    case 'failed': {
      const head = req.status === 'executed'
        ? `✅ *실행 완료* — 승인: <@${req.deciderId}>`
        : `⚠️ *실행하지 못한 단계가 있어요* — 승인: <@${req.deciderId}>${req.result ? ` · ${clean(req.result, 64)}` : ''}`;
      blocks.push(section([head, ...resultLines(req)].join('\n')));
      if (canUndo(req)) {
        blocks.push({ type: 'actions', elements: [btn(AP.undo, '↩️ 되돌리기', req.id)] });
      }
      break;
    }
    case 'rejected':
      blocks.push(ctx(`❌ <@${req.deciderId}>님이 거절했어요.`));
      break;
    case 'cancelled':
      blocks.push(ctx('🚫 요청자가 취소했어요.'));
      break;
    case 'expired':
      blocks.push(ctx('⌛ 시간이 지나 만료됐어요. 필요하면 다시 요청해 주세요.'));
      break;
  }
  return { text: `AWS 실행 요청: ${safeName(req.summary) || '요청'} (${req.status})`, blocks };
}
