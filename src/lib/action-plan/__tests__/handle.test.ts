import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/app-config', () => ({ getConfig: () => ({}) }));

import { maybeHandleActionMention, handleActionClick, type ActionDeps } from '../handle';
import { AP } from '../cards';
import { PlannerError } from '../planner';
import { createApprovalStore } from '@/lib/slack-control/requests';
import { CONTROL_DISABLED_TEXT } from '@/lib/slack-control/handle';
import type { ActionPlanConfig, ActionRequest, Ec2Writer, ExecutionRecord, Resource, ResolvedStep, SnapshotRule } from '../types';

const ACCOUNT = '123456789012';
const INST = 'i-0abc1234def567890';
const SG = 'sg-0123456789abcdef0';
const arn = (kind: string, id: string) => `arn:aws:ec2:ap-northeast-2:${ACCOUNT}:${kind}/${id}`;

const cfg: ActionPlanConfig = {
  approval: { approverIds: ['UAPP', 'UREQ'], allowSelfApproval: false, ttlMs: 15 * 60_000 },
  maxSteps: 5, maxResources: 3, maxBlastRadius: 5, undoHours: 24, sourceAliases: { 사무실: ['203.0.113.0/24'] },
};

interface World {
  instances: Resource[];
  groups: Resource[];
  rules: Record<string, SnapshotRule[]>;
}

function world(): World {
  return {
    instances: [{
      type: 'instance', id: INST, name: 'web-dev', state: 'running', securityGroupIds: [SG],
      tags: { Name: 'web-dev', 'awsops:control': 'allow' },
    }],
    groups: [{ type: 'security-group', id: SG, name: 'web-sg', groupName: 'web-sg', tags: { Name: 'web-sg', 'awsops:control': 'allow' } }],
    rules: { [SG]: [] },
  };
}

const tagPlan = { kind: 'plan', summary: 'web-dev 태그 설정', steps: [{ action: 'tag.set', ref: 'web-dev', key: 'owner', value: 'jiwoo' }] };
const twoStepPlan = {
  kind: 'plan', summary: '태그와 포트',
  steps: [
    { action: 'tag.set', ref: 'web-dev', key: 'owner', value: 'jiwoo' },
    { action: 'sg.ingress.add', ref: 'web-sg', protocol: 'tcp', fromPort: 8080, toPort: 8080, source: 'alias:사무실' },
  ],
};

function setup(over: Partial<ActionDeps> = {}, plan: unknown = tagPlan) {
  const w = world();
  const posts: any[] = [];
  const updates: any[] = [];
  const ephemerals: any[] = [];
  const audits: Array<{ id: string; status: string; undoOf?: string }> = [];
  const writerCalls: Array<{ label: string; policy: any }> = [];
  const runs: Array<{ label: string; step: ResolvedStep; dryRun: boolean }> = [];
  const execs = new Map<string, ExecutionRecord>();
  let ruleSeq = 0;

  const find = (id: string) => [...w.instances, ...w.groups].find(r => r.id === id);
  const copy = (r: Resource | undefined) => (r ? { ...r, tags: { ...r.tags } } : null);

  const deps: ActionDeps = {
    slack: {
      postMessage: vi.fn(async (a) => { posts.push(a); return { ts: `card.${posts.length}` }; }),
      update: vi.fn(async (a) => { updates.push(a); }),
      postEphemeral: vi.fn(async (a) => { ephemerals.push(a); }),
    },
    store: createApprovalStore<ActionRequest>(),
    config: () => cfg,
    enabled: () => true,
    planner: vi.fn(async () => plan),
    reader: {
      listTaggedInstances: vi.fn(async () => w.instances.map(r => copy(r)!)),
      listTaggedSecurityGroups: vi.fn(async () => w.groups.map(r => copy(r)!)),
      describeInstance: vi.fn(async (id: string) => copy(w.instances.find(r => r.id === id))),
      describeSecurityGroup: vi.fn(async (id: string) => copy(w.groups.find(r => r.id === id))),
      listIngressRules: vi.fn(async (id: string) => (w.rules[id] ?? []).map(r => ({ ...r }))),
      listEniUsers: vi.fn(async () => ({ eniCount: 1, instances: [{ id: INST, name: 'web-dev' }] })),
    },
    writers: vi.fn(async (label: string, policy: object): Promise<Ec2Writer> => {
      writerCalls.push({ label, policy });
      return {
        async run(step, dryRun) {
          runs.push({ label, step, dryRun });
          if (dryRun) return {};
          const r = find(step.target.id)!;
          switch (step.action) {
            case 'tag.set': r.tags[step.key!] = step.value!; break;
            case 'tag.remove': delete r.tags[step.key!]; break;
            case 'ec2.stop': r.state = 'stopped'; break;
            case 'ec2.start': r.state = 'running'; break;
            case 'sg.ingress.add': {
              const ruleId = `sgr-${++ruleSeq}`;
              w.rules[r.id].push({ ...step.rule!, ruleId });
              return { requestId: `req-${ruleSeq}`, ruleId };
            }
            case 'sg.ingress.remove': w.rules[r.id] = w.rules[r.id].filter(x => x.ruleId !== step.ruleId); break;
          }
          return { requestId: 'req-x' };
        },
      };
    }),
    account: async () => ACCOUNT,
    audit: (req) => { audits.push({ id: req.id, status: req.status, undoOf: req.undoOf }); },
    executions: {
      save: (r) => { execs.set(r.id, JSON.parse(JSON.stringify(r))); },
      load: (id) => (execs.has(id) ? JSON.parse(JSON.stringify(execs.get(id))) : null),
    },
    ...over,
  };
  return { deps, w, posts, updates, ephemerals, audits, writerCalls, runs, execs };
}

const mention = (text: string, user = 'UREQ') => ({ user, text: `<@UBOT> ${text}`, ts: '10.0', channel: 'C1' });
const click = (action_id: string, value: string, user: string) => ({
  user: { id: user }, channel: { id: 'C1' }, message: { ts: 'card.1', thread_ts: '10.0' }, actions: [{ action_id, value }],
});
const buttonsOf = (msg: any) => ((msg?.blocks ?? []) as any[]).filter(b => b.type === 'actions').flatMap(b => b.elements);
const idOf = (msg: any) => buttonsOf(msg)[0].value as string;
const lastCard = (updates: any[]) => JSON.stringify(updates[updates.length - 1]?.blocks);
const TAG_TEXT = 'web-dev에 owner 태그를 jiwoo로 붙여줘';

async function executedTagPlan(plan: unknown = tagPlan) {
  const s = setup({}, plan);
  await maybeHandleActionMention(mention(TAG_TEXT), s.deps);
  const id = idOf(s.posts[0]);
  await handleActionClick(click(AP.confirm, id, 'UREQ'), s.deps);
  await handleActionClick(click(AP.approve, id, 'UAPP'), s.deps);
  return { ...s, id };
}

describe('maybeHandleActionMention', () => {
  it('disabledRepliesWithoutCallingPlanner', async () => {
    const off = setup({ enabled: () => false });
    expect(await maybeHandleActionMention(mention(TAG_TEXT), off.deps)).toBe(true);
    expect(off.posts[0].text).toContain('AI 실행 기능이 꺼져 있어요');
    expect(off.deps.planner).not.toHaveBeenCalled();

    const noApprovers = setup({ config: () => null });
    expect(await maybeHandleActionMention(mention(TAG_TEXT), noApprovers.deps)).toBe(true);
    expect(noApprovers.posts[0].text).toBe(CONTROL_DISABLED_TEXT);
    expect(noApprovers.deps.planner).not.toHaveBeenCalled();
  });

  it('notActionFallsThrough', async () => {
    const s = setup({}, { kind: 'not-action' });
    expect(await maybeHandleActionMention(mention('지금 켜진 EC2 뭐 있어?'), s.deps)).toBe(false);
    expect(s.deps.planner).not.toHaveBeenCalled();
    expect(await maybeHandleActionMention(mention(TAG_TEXT), s.deps)).toBe(false);
    expect(s.deps.planner).toHaveBeenCalledTimes(1);
    expect(s.posts).toHaveLength(0);
  });

  it('plannerGetsOnlyTheMessageAndAliasNames', async () => {
    const s = setup();
    await maybeHandleActionMention(mention(TAG_TEXT), s.deps);
    expect(s.deps.planner).toHaveBeenCalledWith(TAG_TEXT, ['사무실']);
  });

  it('plannerFailureRepliesAndDoesNotFallThrough', async () => {
    const s = setup({ planner: vi.fn(async () => { throw new PlannerError('planner call failed: TimeoutError'); }) });
    expect(await maybeHandleActionMention(mention(TAG_TEXT), s.deps)).toBe(true);
    expect(s.posts[0].text).toContain('계획을 만들지 못했어요 (PlannerError)');
    expect(s.deps.reader.listTaggedInstances).not.toHaveBeenCalled();

    const bad = setup({}, { kind: 'plan', steps: [{ action: 'iam.delete', ref: '*evil*' }] });
    expect(await maybeHandleActionMention(mention(TAG_TEXT), bad.deps)).toBe(true);
    expect(bad.posts[0].text).toContain('알 수 없는 action이에요');
    expect(bad.posts[0].text).not.toContain('*evil*');
    expect(bad.deps.reader.listTaggedInstances).not.toHaveBeenCalled();
  });

  it('clarifyAsksToRewriteInOneSentence', async () => {
    const s = setup({}, { kind: 'clarify', question: '어느 *서버*인가요?' });
    expect(await maybeHandleActionMention(mention(TAG_TEXT), s.deps)).toBe(true);
    expect(s.posts[0].text).toContain('어느 서버인가요?');
    expect(s.posts[0].text).toContain('처음부터 한 문장으로 다시 써 주세요');
  });

  it('notFoundListsSanitizedCappedCandidates', async () => {
    const s = setup({}, { kind: 'plan', summary: '', steps: [{ action: 'ec2.stop', ref: 'api-*prod*' }] });
    s.w.instances = Array.from({ length: 13 }, (_, i) => ({
      type: 'instance' as const, id: `i-0abc1234def5678${String(i).padStart(2, '0')}`, name: `*srv${i}*`, state: 'running', tags: { 'awsops:control': 'allow' },
    }));
    expect(await maybeHandleActionMention(mention('api-prod 태그 지워줘'), s.deps)).toBe(true);
    const text = s.posts[0].text as string;
    expect(text).toContain('srv0');
    expect(text).not.toContain('*srv0*');
    expect(text).not.toContain('*prod*');
    expect(text).toContain('외 3개');
    expect(text).not.toContain('srv12');
  });

  it('serverWithoutTaggedSgSaysSo', async () => {
    const s = setup({}, { kind: 'plan', summary: '', steps: [{ action: 'sg.ingress.add', ref: 'web-dev', protocol: 'tcp', fromPort: 8080, toPort: 8080, source: '10.0.0.0/8' }] });
    s.w.groups = [];
    expect(await maybeHandleActionMention(mention('web-dev 8080 포트 열어줘'), s.deps)).toBe(true);
    expect(s.posts[0].text).toContain('AI 실행이 허용된 보안그룹이 없어요');
  });

  it('allNoopRepliesNothingToChange', async () => {
    const s = setup();
    s.w.instances[0].tags.owner = 'jiwoo';
    expect(await maybeHandleActionMention(mention(TAG_TEXT), s.deps)).toBe(true);
    expect(s.posts[0].text).toContain('바꿀 게 없어요');
    expect(s.deps.writers).not.toHaveBeenCalled();
    expect(s.audits).toHaveLength(0);
  });

  it('policyDeniedCardHasNoButtonsAndNoDryRun', async () => {
    const s = setup();
    s.w.instances[0].tags.env = 'prod';
    expect(await maybeHandleActionMention(mention(TAG_TEXT), s.deps)).toBe(true);
    expect(buttonsOf(s.posts[0])).toHaveLength(0);
    const card = JSON.stringify(s.posts[0].blocks);
    expect(card).toContain('운영(Production)');
    expect(card).not.toContain('scripts/17-setup-action-executor.sh');
    expect(s.deps.writers).not.toHaveBeenCalled();
    expect(s.audits.map(a => a.status)).toEqual(['proposed']);

    // A forged click on the denied request is refused before any state change.
    const id = s.audits[0].id;
    await handleActionClick(click(AP.confirm, id, 'UREQ'), s.deps);
    await handleActionClick(click(AP.approve, id, 'UAPP'), s.deps);
    expect(s.deps.store.get(id)?.status).toBe('proposed');
    expect(s.ephemerals[0].text).toContain('실행할 수 없는 요청');
    expect(s.deps.writers).not.toHaveBeenCalled();
  });

  it('dryRunRejectionMarksPermissionDenied', async () => {
    const s = setup({
      writers: vi.fn(async () => ({ run: async () => { throw Object.assign(new Error('no'), { name: 'UnauthorizedOperation' }); } })),
    });
    await maybeHandleActionMention(mention(TAG_TEXT), s.deps);
    expect(buttonsOf(s.posts[0])).toHaveLength(0);
    expect(JSON.stringify(s.posts[0].blocks)).toContain('UnauthorizedOperation');
  });
});

describe('handleActionClick', () => {
  it('happyPathPlansPreviewsApprovesAndExecutes', async () => {
    const s = setup({}, twoStepPlan);
    expect(await maybeHandleActionMention(mention(TAG_TEXT), s.deps)).toBe(true);
    expect(s.posts[0]).toMatchObject({ channel: 'C1', thread_ts: '10.0' });
    expect(buttonsOf(s.posts[0]).map((b: any) => b.action_id)).toEqual([AP.confirm, AP.cancel]);
    const id = idOf(s.posts[0]);
    expect(s.deps.store.get(id)?.cardTs).toBe('card.1');

    // Preview: dry-run as the requester, scoped to exactly the targets.
    const exactPolicy = {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 'ec2:CreateTags', Resource: [arn('instance', INST)] },
        { Effect: 'Allow', Action: 'ec2:AuthorizeSecurityGroupIngress', Resource: [arn('security-group', SG)] },
      ],
    };
    expect(s.writerCalls).toEqual([{ label: 'slack-UREQ', policy: exactPolicy }]);
    expect(s.runs.map(r => [r.step.action, r.dryRun])).toEqual([['tag.set', true], ['sg.ingress.add', true]]);
    expect(s.w.instances[0].tags.owner).toBeUndefined();

    await handleActionClick(click(AP.confirm, id, 'UREQ'), s.deps);
    expect(lastCard(s.updates)).toContain('2단계');
    expect(s.runs.filter(r => !r.dryRun)).toHaveLength(0);

    await handleActionClick(click(AP.approve, id, 'UAPP'), s.deps);
    expect(s.writerCalls[1]).toEqual({ label: 'slack-UAPP', policy: exactPolicy });
    expect(s.runs.filter(r => !r.dryRun).map(r => [r.label, r.step.action])).toEqual([
      ['slack-UAPP', 'tag.set'], ['slack-UAPP', 'sg.ingress.add'],
    ]);
    expect(s.w.instances[0].tags.owner).toBe('jiwoo');
    expect(s.w.rules[SG]).toEqual([{ protocol: 'tcp', fromPort: 8080, toPort: 8080, source: '203.0.113.0/24', ruleId: 'sgr-1' }]);

    const req = s.deps.store.get(id)!;
    expect(req.status).toBe('executed');
    expect(req.results?.map(r => r.status)).toEqual(['done', 'done']);
    const card = lastCard(s.updates);
    expect(card).toContain('실행 완료');
    expect(card).toContain(AP.undo);
    expect(s.audits.map(a => a.status)).toEqual(['proposed', 'pending', 'executing', 'executed']);

    const rec = s.execs.get(id)!;
    expect(rec).toMatchObject({ id, requesterId: 'UREQ', approverId: 'UAPP', channel: 'C1', threadTs: '10.0' });
    expect(rec.results[1].inverse).toMatchObject({ action: 'sg.ingress.remove', ruleId: 'sgr-1' });
  });

  it('requesterCannotFinalApprove', async () => {
    const s = setup();
    await maybeHandleActionMention(mention(TAG_TEXT), s.deps);
    const id = idOf(s.posts[0]);
    await handleActionClick(click(AP.confirm, id, 'UREQ'), s.deps);
    await handleActionClick(click(AP.approve, id, 'UREQ'), s.deps);
    expect(s.ephemerals[0]).toMatchObject({ user: 'UREQ' });
    expect(s.ephemerals[0].text).toContain('본인');
    expect(s.deps.store.get(id)?.status).toBe('pending');
    expect(s.runs.filter(r => !r.dryRun)).toHaveLength(0);
    expect(s.writerCalls).toHaveLength(1);
  });

  it('driftBetweenPreviewAndApprovalBlocksExecution', async () => {
    const s = setup();
    await maybeHandleActionMention(mention(TAG_TEXT), s.deps);
    const id = idOf(s.posts[0]);
    await handleActionClick(click(AP.confirm, id, 'UREQ'), s.deps);
    s.w.instances[0].tags.owner = 'someone';
    await handleActionClick(click(AP.approve, id, 'UAPP'), s.deps);

    expect(s.runs.filter(r => !r.dryRun)).toHaveLength(0);
    expect(s.writerCalls).toHaveLength(1);
    expect(s.w.instances[0].tags.owner).toBe('someone');
    const req = s.deps.store.get(id)!;
    expect(req.status).toBe('failed');
    const card = lastCard(s.updates);
    expect(card).toContain('그 사이 상태가 바뀌었어요');
    expect(card).toContain('태그 owner 값이 바뀌었어요');
    expect(card).not.toContain(AP.undo);
    expect(s.audits.map(a => a.status)).toEqual(['proposed', 'pending', 'executing', 'failed']);
    expect(s.execs.size).toBe(0);
  });

  it('policyIsReEvaluatedOnTheFreshSnapshotAtApproval', async () => {
    // env=prod added between preview and approval: drift does not see it (owner is the touched key), policy must.
    const prod = setup();
    await maybeHandleActionMention(mention(TAG_TEXT), prod.deps);
    const id = idOf(prod.posts[0]);
    await handleActionClick(click(AP.confirm, id, 'UREQ'), prod.deps);
    prod.w.instances[0].tags.env = 'prod';
    await handleActionClick(click(AP.approve, id, 'UAPP'), prod.deps);
    expect(prod.runs.filter(r => !r.dryRun)).toHaveLength(0);
    expect(prod.writerCalls).toHaveLength(1); // only the preview dry-run session
    expect(prod.w.instances[0].tags.owner).toBeUndefined();
    expect(prod.deps.store.get(id)!.status).toBe('failed');
    let card = lastCard(prod.updates);
    expect(card).toContain('최종 승인 때 다시 검사한 규칙에서 거부');
    expect(card).toContain('운영(Production)');
    expect(card).not.toContain(AP.undo);
    expect(prod.execs.size).toBe(0);

    // ENI count rising above maxBlastRadius blocks a security-group change.
    const eni = setup({}, twoStepPlan);
    await maybeHandleActionMention(mention(TAG_TEXT), eni.deps);
    const id2 = idOf(eni.posts[0]);
    await handleActionClick(click(AP.confirm, id2, 'UREQ'), eni.deps);
    eni.deps.reader.listEniUsers = vi.fn(async () => ({ eniCount: 6, instances: [{ id: INST, name: 'web-dev' }] }));
    await handleActionClick(click(AP.approve, id2, 'UAPP'), eni.deps);
    expect(eni.runs.filter(r => !r.dryRun)).toHaveLength(0);
    expect(eni.w.rules[SG]).toHaveLength(0);
    expect(eni.deps.store.get(id2)!.status).toBe('failed');
    card = lastCard(eni.updates);
    expect(card).toContain('6개라 영향이 너무 커요');
  });

  it('writerFactoryFailureAtApprovalFailsWithoutRunning', async () => {
    const s = setup();
    await maybeHandleActionMention(mention(TAG_TEXT), s.deps);
    const id = idOf(s.posts[0]);
    await handleActionClick(click(AP.confirm, id, 'UREQ'), s.deps);
    s.deps.writers = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AccessDenied' }); });
    await handleActionClick(click(AP.approve, id, 'UAPP'), s.deps);
    expect(s.runs.filter(r => !r.dryRun)).toHaveLength(0);
    expect(s.deps.store.get(id)!.status).toBe('failed');
    expect(lastCard(s.updates)).toContain('실행 권한을 받지 못했어요');
  });

  it('rejectAndCancelEndTheRequest', async () => {
    const a = setup();
    await maybeHandleActionMention(mention(TAG_TEXT), a.deps);
    const ida = idOf(a.posts[0]);
    await handleActionClick(click(AP.confirm, ida, 'UREQ'), a.deps);
    await handleActionClick(click(AP.reject, ida, 'UAPP'), a.deps);
    expect(lastCard(a.updates)).toContain('거절');
    expect(a.audits.map(x => x.status)).toEqual(['proposed', 'pending', 'rejected']);

    const b = setup();
    await maybeHandleActionMention(mention(TAG_TEXT), b.deps);
    const idb = idOf(b.posts[0]);
    await handleActionClick(click(AP.cancel, idb, 'UREQ'), b.deps);
    expect(lastCard(b.updates)).toContain('취소');
    await handleActionClick(click(AP.confirm, idb, 'UREQ'), b.deps);
    expect(b.audits.map(x => x.status)).toEqual(['proposed', 'cancelled']);
  });

  it('expiredClickRedrawsAndAudits', async () => {
    let t = 0;
    const s = setup({ store: createApprovalStore<ActionRequest>({ now: () => t }) });
    await maybeHandleActionMention(mention(TAG_TEXT), s.deps);
    const id = idOf(s.posts[0]);
    t = cfg.approval.ttlMs + 1;
    await handleActionClick(click(AP.confirm, id, 'UREQ'), s.deps);
    expect(s.ephemerals[0].text).toContain('만료');
    expect(lastCard(s.updates)).toContain('만료');
    expect(s.audits.map(a => a.status)).toEqual(['proposed', 'expired']);
  });

  it('undoCreatesNewRequestThroughSamePipeline', async () => {
    const s = await executedTagPlan(twoStepPlan);
    const before = s.writerCalls.length;
    await handleActionClick(click(AP.undo, s.id, 'UOTHER'), s.deps);

    const card = s.posts[s.posts.length - 1];
    expect(card).toMatchObject({ channel: 'C1', thread_ts: '10.0' });
    expect(JSON.stringify(card.blocks)).toContain('되돌리기 요청');
    const undoId = idOf(card);
    const undo = s.deps.store.get(undoId)!;
    expect(undo).toMatchObject({ undoOf: s.id, requesterId: 'UOTHER', status: 'proposed', skippedForDrift: [] });
    expect(undo.changes.map(c => c.step.action)).toEqual(['sg.ingress.remove', 'tag.remove']);
    // same preview pipeline: dry-run as the clicker with an exact session policy
    expect(s.writerCalls[before]).toEqual({
      label: 'slack-UOTHER',
      policy: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 'ec2:RevokeSecurityGroupIngress', Resource: [arn('security-group', SG)] },
          { Effect: 'Allow', Action: 'ec2:DeleteTags', Resource: [arn('instance', INST)] },
        ],
      },
    });
    expect(s.audits[s.audits.length - 1]).toMatchObject({ id: undoId, status: 'proposed', undoOf: s.id });

    await handleActionClick(click(AP.confirm, undoId, 'UOTHER'), s.deps);
    await handleActionClick(click(AP.approve, undoId, 'UAPP'), s.deps);
    expect(s.deps.store.get(undoId)?.status).toBe('executed');
    expect(s.w.instances[0].tags.owner).toBeUndefined();
    expect(s.w.rules[SG]).toEqual([]);
    expect(s.execs.get(undoId)?.undoOf).toBe(s.id);
  });

  it('undoSkipsStepsChangedSinceAndNoticesWhenNothingLeft', async () => {
    const s = await executedTagPlan(twoStepPlan);
    s.w.instances[0].tags.owner = 'someone-else';
    await handleActionClick(click(AP.undo, s.id, 'UOTHER'), s.deps);
    const undo = s.deps.store.get(idOf(s.posts[s.posts.length - 1]))!;
    expect(undo.changes.map(c => c.step.action)).toEqual(['sg.ingress.remove']);
    expect(undo.skippedForDrift).toHaveLength(1);
    expect(JSON.stringify(s.posts[s.posts.length - 1].blocks)).toContain('그 사이 다른 변경이 있어서 되돌리지 않아요');

    const t = await executedTagPlan();
    t.w.instances[0].tags.owner = 'someone-else';
    const posts = t.posts.length;
    await handleActionClick(click(AP.undo, t.id, 'UOTHER'), t.deps);
    expect(t.posts).toHaveLength(posts);
    expect(t.ephemerals[t.ephemerals.length - 1]).toMatchObject({ user: 'UOTHER' });
    expect(t.ephemerals[t.ephemerals.length - 1].text).toContain('되돌릴 게 없어요');
  });

  it('undoOnlyOnce', async () => {
    const s = await executedTagPlan();
    await handleActionClick(click(AP.undo, s.id, 'UOTHER'), s.deps);
    const undoId = idOf(s.posts[s.posts.length - 1]);
    await handleActionClick(click(AP.confirm, undoId, 'UOTHER'), s.deps);
    await handleActionClick(click(AP.approve, undoId, 'UAPP'), s.deps);
    expect(s.deps.store.get(undoId)?.status).toBe('executed');

    const posts = s.posts.length;
    await handleActionClick(click(AP.undo, s.id, 'UOTHER'), s.deps);
    expect(s.posts).toHaveLength(posts);
    expect(s.ephemerals[s.ephemerals.length - 1].text).toContain('이미 되돌렸어요');

    // The undo itself can still be undone (spec §3.11).
    await handleActionClick(click(AP.undo, undoId, 'UOTHER'), s.deps);
    expect(s.posts).toHaveLength(posts + 1);
    expect(s.deps.store.get(idOf(s.posts[posts]))?.undoOf).toBe(undoId);
  });

  it('undoRefusedAfterWindowOrUnknownExecution', async () => {
    const s = await executedTagPlan();
    const late = { ...s.deps, now: () => new Date(Date.now() + 25 * 3600_000) };
    await handleActionClick(click(AP.undo, s.id, 'UOTHER'), late);
    expect(s.ephemerals[s.ephemerals.length - 1].text).toContain('24시간');
    await handleActionClick(click(AP.undo, '00000000-0000-4000-8000-000000000000', 'UOTHER'), s.deps);
    expect(s.ephemerals[s.ephemerals.length - 1].text).toContain('실행 기록을 찾을 수 없어요');
  });

  it('ignoresOtherWorkspacesAndDisabledFeature', async () => {
    const s = setup();
    await maybeHandleActionMention(mention(TAG_TEXT), s.deps);
    const id = idOf(s.posts[0]);
    await handleActionClick({ ...click(AP.confirm, id, 'UREQ'), user: { id: 'UREQ', team_id: 'T_OTHER' } }, { ...s.deps, teamId: 'T_OURS' });
    expect(s.deps.store.get(id)?.status).toBe('proposed');
    await handleActionClick(click(AP.confirm, id, 'UREQ'), { ...s.deps, enabled: () => false });
    expect(s.deps.store.get(id)?.status).toBe('proposed');
    expect(s.ephemerals[0].text).toContain('AI 실행 기능이 꺼져 있어요');
  });
});
