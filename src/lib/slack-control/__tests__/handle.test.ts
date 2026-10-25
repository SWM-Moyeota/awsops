import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/app-config', () => ({ getConfig: () => ({}) }));

import { maybeHandleControlMention, handleControlAction, CONTROL_DISABLED_TEXT, type ControlDeps } from '../handle';
import { createRequestStore } from '../requests';
import { CTL } from '../cards';
import type { ControlConfig, ControllableInstance } from '../types';

const cfg: ControlConfig = { approverIds: ['UBOSS'], allowSelfApproval: false, ttlMs: 15 * 60_000 };
const k8s: ControllableInstance = { id: 'i-0aaa1111bbbb2222c', name: 'k8s-practice', state: 'running' };

function setup(over: Partial<ControlDeps> = {}) {
  const posts: any[] = [];
  const updates: any[] = [];
  const ephemerals: any[] = [];
  const audits: string[] = [];
  const deps: ControlDeps = {
    slack: {
      postMessage: vi.fn(async (a) => { posts.push(a); return { ts: 'card.1' }; }),
      update: vi.fn(async (a) => { updates.push(a); }),
      postEphemeral: vi.fn(async (a) => { ephemerals.push(a); }),
    },
    store: createRequestStore(),
    config: () => cfg,
    ec2: {
      list: vi.fn(async () => [k8s]),
      describe: vi.fn(async () => ({ ...k8s })),
      execute: vi.fn(async () => ({ previous: 'running', current: 'stopping' })),
    },
    audit: (req) => { audits.push(req.status); },
    ...over,
  };
  return { deps, posts, updates, ephemerals, audits };
}

const mention = (text: string, user = 'UALICE') => ({ user, text: `<@UBOT> ${text}`, ts: '10.0', channel: 'C1' });
const click = (action_id: string, value: string, user: string) => ({
  user: { id: user }, channel: { id: 'C1' }, actions: [{ action_id, value }],
});
const lastCard = (updates: any[]) => JSON.stringify(updates[updates.length - 1]?.blocks);

describe('maybeHandleControlMention', () => {
  it('ignoresNonCommands', async () => {
    const { deps } = setup();
    expect(await maybeHandleControlMention(mention('지금 켜진 EC2 뭐 있어?'), deps)).toBe(false);
    expect(deps.ec2.list).not.toHaveBeenCalled();
  });

  it('postsStep1CardInThread', async () => {
    const { deps, posts, audits } = setup();
    expect(await maybeHandleControlMention(mention('k8s-practice 꺼줘'), deps)).toBe(true);
    expect(posts[0]).toMatchObject({ channel: 'C1', thread_ts: '10.0' });
    const blocks = JSON.stringify(posts[0].blocks);
    expect(blocks).toContain('1단계');
    expect(blocks).toContain(CTL.confirm);
    expect(blocks).toContain('i-0aaa1111bbbb2222c');
    expect(audits).toEqual(['proposed']);
  });

  it('saysDisabledWithoutApprovers', async () => {
    const { deps, posts } = setup({ config: () => null });
    expect(await maybeHandleControlMention(mention('k8s-practice 꺼줘'), deps)).toBe(true);
    expect(posts[0].text).toBe(CONTROL_DISABLED_TEXT);
  });

  it('listsControllableServersForUnknownTarget', async () => {
    const { deps, posts } = setup();
    await maybeHandleControlMention(mention('moyeota-backend-prod-a 꺼줘'), deps);
    expect(posts[0].text).toContain('제어할 수 있는 서버가 아니에요');
    expect(posts[0].text).toContain('k8s-practice');
  });
});

describe('handleControlAction — two-step flow', () => {
  async function proposed() {
    const s = setup();
    await maybeHandleControlMention(mention('k8s-practice 꺼줘'), s.deps);
    const id = (s.posts[0].blocks as any[])[2].elements[0].value as string;
    return { ...s, id };
  }

  it('runsOnlyAfterRequesterConfirmsAndAnotherApproverApproves', async () => {
    const { deps, id, updates, audits } = await proposed();
    await handleControlAction(click(CTL.confirm, id, 'UALICE'), deps);
    expect(lastCard(updates)).toContain('2단계');
    expect(lastCard(updates)).toContain(CTL.approve);
    expect(deps.ec2.execute).not.toHaveBeenCalled();

    await handleControlAction(click(CTL.approve, id, 'UBOSS'), deps);
    expect(deps.ec2.execute).toHaveBeenCalledWith('stop', 'i-0aaa1111bbbb2222c', 'UBOSS');
    expect(lastCard(updates)).toContain('실행 완료');
    expect(lastCard(updates)).toContain('running → stopping');
    expect(audits).toEqual(['proposed', 'pending', 'executing', 'executed']);
  });

  it('requesterCannotApproveOwnRequest', async () => {
    const { deps, id, ephemerals } = await proposed();
    await handleControlAction(click(CTL.confirm, id, 'UALICE'), deps);
    await handleControlAction(click(CTL.approve, id, 'UALICE'), deps);
    expect(deps.ec2.execute).not.toHaveBeenCalled();
    expect(ephemerals[0]).toMatchObject({ user: 'UALICE' });
    expect(ephemerals[0].text).toContain('본인');
  });

  it('othersCannotDoStep1', async () => {
    const { deps, id, ephemerals } = await proposed();
    await handleControlAction(click(CTL.confirm, id, 'UBOSS'), deps);
    expect(ephemerals[0].text).toContain('요청한 사람');
  });

  it('doubleApproveExecutesOnce', async () => {
    const { deps, id } = await proposed();
    await handleControlAction(click(CTL.confirm, id, 'UALICE'), deps);
    await Promise.all([
      handleControlAction(click(CTL.approve, id, 'UBOSS'), deps),
      handleControlAction(click(CTL.approve, id, 'UBOSS'), deps),
    ]);
    expect(deps.ec2.execute).toHaveBeenCalledTimes(1);
  });

  it('failsSafelyWhenTagRemovedOrStateChanged', async () => {
    const a = await proposed();
    (a.deps.ec2.describe as any).mockResolvedValueOnce(null);
    await handleControlAction(click(CTL.confirm, a.id, 'UALICE'), a.deps);
    await handleControlAction(click(CTL.approve, a.id, 'UBOSS'), a.deps);
    expect(a.deps.ec2.execute).not.toHaveBeenCalled();
    expect(lastCard(a.updates)).toContain('태그');

    const b = await proposed();
    (b.deps.ec2.describe as any).mockResolvedValueOnce({ ...k8s, state: 'stopped' });
    await handleControlAction(click(CTL.confirm, b.id, 'UALICE'), b.deps);
    await handleControlAction(click(CTL.approve, b.id, 'UBOSS'), b.deps);
    expect(b.deps.ec2.execute).not.toHaveBeenCalled();
    expect(lastCard(b.updates)).toContain('stopped');
  });

  it('showsAwsErrorCodeOnFailure', async () => {
    const { deps, id, updates } = await proposed();
    (deps.ec2.execute as any).mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'UnauthorizedOperation' }));
    await handleControlAction(click(CTL.confirm, id, 'UALICE'), deps);
    await handleControlAction(click(CTL.approve, id, 'UBOSS'), deps);
    expect(lastCard(updates)).toContain('UnauthorizedOperation');
  });

  it('rejectAndCancelEndTheRequest', async () => {
    const a = await proposed();
    await handleControlAction(click(CTL.confirm, a.id, 'UALICE'), a.deps);
    await handleControlAction(click(CTL.reject, a.id, 'UBOSS'), a.deps);
    expect(lastCard(a.updates)).toContain('거절');

    const b = await proposed();
    await handleControlAction(click(CTL.cancel, b.id, 'UALICE'), b.deps);
    expect(lastCard(b.updates)).toContain('취소');
    await handleControlAction(click(CTL.confirm, b.id, 'UALICE'), b.deps);
    expect(b.deps.ec2.execute).not.toHaveBeenCalled();
  });

  it('ignoresOtherWorkspaces', async () => {
    const { deps, id } = await proposed();
    const d = { ...deps, teamId: 'T_OURS' };
    await handleControlAction({ ...click(CTL.confirm, id, 'UALICE'), user: { id: 'UALICE', team_id: 'T_OTHER' } }, d);
    expect(deps.store.get(id)?.status).toBe('proposed');
  });
});
