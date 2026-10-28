import { describe, it, expect } from 'vitest';
import { actionCard, AP, AP_PREFIX } from '../cards';
import type { ActionPlanConfig, ActionRequest, ResolvedStep } from '../types';

const cfg: ActionPlanConfig = {
  approval: { approverIds: ['UAPP'], allowSelfApproval: false, ttlMs: 900_000 },
  maxSteps: 5, maxResources: 3, maxBlastRadius: 5, undoHours: 24, sourceAliases: {},
};
const inv: ResolvedStep = { action: 'tag.remove', target: { type: 'instance', id: 'i-0abc', name: 'web-dev' }, key: 'owner' };
const base = (o: Partial<ActionRequest> = {}): ActionRequest => ({
  id: 'req1', requesterId: 'UREQ', channel: 'C1', threadTs: '1.1', status: 'proposed', createdAt: 0,
  prompt: 'web-dev owner 태그를 jiwoo로', summary: '태그 설정',
  plannerRaw: null,
  changes: [
    { index: 0, step: { action: 'tag.set', target: { type: 'instance', id: 'i-0abc', name: 'web-dev' }, key: 'owner', value: 'jiwoo' }, before: '태그 owner: (없음)', after: 'jiwoo', noop: false, inverse: inv },
    { index: 1, step: { action: 'ec2.stop', target: { type: 'instance', id: 'i-0def', name: 'old' }, }, before: 'stopped', after: 'stopped', noop: true },
  ],
  snapshot: {},
  policy: { ok: true, denials: [] },
  permission: { ok: true },
  ...o,
});
const json = (c: { blocks: unknown[] }) => JSON.stringify(c.blocks);
const buttons = (c: { blocks: unknown[] }) =>
  (c.blocks as any[]).filter(b => b.type === 'actions').flatMap(b => b.elements);

describe('actionCard', () => {
  it('cardShowsDiffBlastAndButtonsPerStatus', () => {
    const snapshot = { 'sg-1': { type: 'security-group' as const, id: 'sg-1', name: 'sg-web', tags: {}, eniCount: 2, attachedInstances: [{ id: 'i-1', name: 'a' }, { id: 'i-2', name: 'b' }] } };
    const sgChange = { index: 2, step: { action: 'sg.ingress.add' as const, target: { type: 'security-group' as const, id: 'sg-1', name: 'sg-web' } }, before: '(없음)', after: '인바운드 추가 tcp 8080 ← 203.0.113.0/24', noop: false };
    const p = actionCard(base({ snapshot, changes: [...base().changes, sgChange] }), cfg);
    const s = json(p);
    expect(s).toContain('(없음) → jiwoo');
    expect(s).toContain('이미 되어 있어요');
    expect(s).toContain('서버 2대: a, b');
    expect(s).toContain('24시간 안');
    expect(buttons(p).map(b => b.action_id)).toEqual([AP.confirm, AP.cancel]);
    expect(buttons(p)[0].value).toBe('req1');

    const pending = actionCard(base({ status: 'pending' }), cfg);
    const bs = buttons(pending);
    expect(bs.map(b => b.action_id)).toEqual([AP.approve, AP.reject]);
    expect(bs[0].confirm).toBeTruthy();
    expect(bs.every(b => b.action_id.startsWith(AP_PREFIX))).toBe(true);

    const stop = actionCard(base({ changes: [{ ...base().changes[1], noop: false, before: 'running', after: 'stopped' }] }), cfg);
    expect(json(stop)).toContain('서버 1대가 꺼져요');

    for (const status of ['executing', 'rejected', 'cancelled', 'expired'] as const) {
      expect(buttons(actionCard(base({ status }), cfg))).toHaveLength(0);
    }
    const done = actionCard(base({ status: 'executed', deciderId: 'UAPP', results: [{ index: 0, status: 'done', inverse: inv }] }), cfg);
    expect(json(done)).toContain('✅ 완료');
    const failed = actionCard(base({ status: 'failed', deciderId: 'UAPP', results: [
      { index: 0, status: 'failed', error: 'AccessDenied' }, { index: 1, status: 'not-run' }] }), cfg);
    expect(json(failed)).toContain('⚠️ 실패 (AccessDenied)');
    const nr = actionCard(base({ status: 'failed', changes: [base().changes[0], { ...base().changes[1], noop: false }], results: [{ index: 0, status: 'done' }] }), cfg);
    expect(json(nr)).toContain('⏸ 실행 안 함');
  });

  it('deniedCardHasNoButtons', () => {
    for (const status of ['proposed', 'pending'] as const) {
      const p = actionCard(base({ status, policy: { ok: false, denials: ['리소스가 너무 많아요'] } }), cfg);
      expect(buttons(p)).toHaveLength(0);
      expect(json(p)).toContain('리소스가 너무 많아요');
      const q = actionCard(base({ status, permission: { ok: false } }), cfg);
      expect(buttons(q)).toHaveLength(0);
      expect(json(q)).toContain('scripts/17-setup-action-executor.sh');
    }
  });

  it('namesAndSummaryAreSanitized', () => {
    const evil = '*evil*`<@U1>`';
    const req = base({
      prompt: evil, summary: evil,
      changes: [{ index: 0, step: { action: 'tag.set', target: { type: 'instance', id: 'i-1', name: evil }, key: 'k', value: evil }, before: evil, after: evil, noop: false }],
    });
    const p = actionCard(req, cfg);
    const text = JSON.stringify([p.text, ...(p.blocks as any[]).map(b => b.text?.text ?? b.elements?.map((e: any) => e.text))]);
    const body = text.replace(/<@U(REQ|APP)>/g, '');
    for (const ch of ['*evil*', '<@U1>', '`<', '>`']) expect(body).not.toContain(ch);
    // only our own formatting characters remain; user content has none of them
    expect(body).toContain('evil@U1');
  });

  it('undoButtonOnlyWhenSomethingCanBeUndone', () => {
    const undoBtn = (r: ActionRequest) => buttons(actionCard(r, cfg)).filter(b => b.action_id === AP.undo);
    const ok = undoBtn(base({ status: 'executed', results: [{ index: 0, status: 'done', inverse: inv }] }));
    expect(ok).toHaveLength(1);
    expect(ok[0].value).toBe('req1');
    expect(undoBtn(base({ status: 'failed', results: [{ index: 0, status: 'done', inverse: inv }, { index: 1, status: 'failed' }] }))).toHaveLength(1);
    expect(undoBtn(base({ status: 'executed', results: [{ index: 0, status: 'done' }] }))).toHaveLength(0);
    expect(undoBtn(base({ status: 'failed', results: [{ index: 0, status: 'failed', inverse: inv }] }))).toHaveLength(0);
    expect(undoBtn(base({ status: 'pending', results: [{ index: 0, status: 'done', inverse: inv }] }))).toHaveLength(0);
  });

  it('listsDriftSkippedForUndo', () => {
    const p = actionCard(base({ undoOf: 'req0', status: 'executed', skippedForDrift: ['web-dev 태그 owner'], results: [] }), cfg);
    expect(json(p)).toContain('web-dev 태그 owner');
    expect(json(p)).toContain('되돌리기 요청');
  });
});
