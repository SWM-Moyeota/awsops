// The one Slack card a control request lives in — redrawn on every state change.
// 제어 요청 카드 하나를 상태가 바뀔 때마다 다시 그린다.
import type { ControlAction, ControlConfig, ControlRequest } from './types';

export const CTL_PREFIX = 'awsops_ctl_';
export const CTL = {
  confirm: 'awsops_ctl_confirm',
  cancel: 'awsops_ctl_cancel',
  approve: 'awsops_ctl_approve',
  reject: 'awsops_ctl_reject',
} as const;

export const ACTION_LABEL: Record<ControlAction, string> = {
  start: '켜기 (시작)',
  stop: '끄기 (정지) — 언제든 다시 켤 수 있어요',
  reboot: '재부팅',
};

const btn = (actionId: string, text: string, value: string, style?: 'primary' | 'danger', confirm?: unknown) => ({
  type: 'button', action_id: actionId, value, text: { type: 'plain_text', text, emoji: true },
  ...(style ? { style } : {}), ...(confirm ? { confirm } : {}),
});

const ctx = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

export function controlCard(req: ControlRequest, cfg: ControlConfig): { text: string; blocks: unknown[] } {
  const name = req.instance.name ? `\`${req.instance.name}\` ` : '';
  const summary = [
    '🛠 *AWS 제어 요청*',
    `• 작업: *${ACTION_LABEL[req.action]}*`,
    `• 대상: ${name}(\`${req.instance.id}\`)`,
    `• 요청 당시 상태: ${req.instance.state}`,
    `• 요청자: <@${req.requesterId}>`,
  ].join('\n');
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: summary } }];
  const minutes = Math.round(cfg.ttlMs / 60_000);
  const approvers = cfg.approverIds.map(id => `<@${id}>`).join(', ');

  switch (req.status) {
    case 'proposed':
      blocks.push(ctx(`*1단계 / 2* — <@${req.requesterId}>님, 대상이 맞는지 확인해 주세요. ${minutes}분 뒤 만료돼요.`));
      blocks.push({ type: 'actions', elements: [
        btn(CTL.confirm, '✅ 맞아요, 승인 요청', req.id, 'primary'),
        btn(CTL.cancel, '취소', req.id),
      ] });
      break;
    case 'pending':
      blocks.push(ctx(`*2단계 / 2* — 승인자(${approvers}) 중 한 명이 최종 승인해야 실행돼요.${cfg.allowSelfApproval ? '' : ' 요청자 본인은 승인할 수 없어요.'}`));
      blocks.push({ type: 'actions', elements: [
        btn(CTL.approve, '✅ 최종 승인', req.id, 'primary', {
          title: { type: 'plain_text', text: '정말 실행할까요?' },
          text: { type: 'mrkdwn', text: `${name}(\`${req.instance.id}\`) — *${ACTION_LABEL[req.action]}*` },
          confirm: { type: 'plain_text', text: '실행' },
          deny: { type: 'plain_text', text: '돌아가기' },
        }),
        btn(CTL.reject, '❌ 거절', req.id, 'danger'),
      ] });
      break;
    case 'executing':
      blocks.push(ctx(`⏳ <@${req.deciderId}>님이 승인 — 실행 중이에요...`));
      break;
    case 'executed':
      blocks.push(ctx(`✅ *실행 완료* — 승인: <@${req.deciderId}> · 상태: ${req.result ?? ''}`));
      break;
    case 'failed':
      blocks.push(ctx(`⚠️ *실행하지 못했어요* — ${req.result ?? ''}`));
      break;
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
  return { text: `AWS 제어 요청: ${req.instance.name || req.instance.id} ${ACTION_LABEL[req.action]} (${req.status})`, blocks };
}
