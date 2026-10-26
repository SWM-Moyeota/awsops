import { describe, it, expect, vi } from 'vitest';
import { handleMention, handleAnalyzeClick, CHANNEL_NOT_ALLOWED_TEXT, type SlackApi, type MentionEvent } from '../handle';
import { ANALYZE_ACTION_ID } from '../alert';
import { PLACEHOLDER_TEXT } from '../format';

function fakeSlack(over: Partial<SlackApi> = {}): SlackApi & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { post: [], update: [], replies: [] };
  return {
    calls,
    postMessage: vi.fn(async (a) => { calls.post.push(a); return { ts: '100.1' }; }),
    update: vi.fn(async (a) => { calls.update.push(a); }),
    replies: vi.fn(async (a) => { calls.replies.push(a); return []; }),
    ...over,
  };
}

const ev = (p: Partial<MentionEvent> = {}): MentionEvent => ({
  type: 'app_mention', user: 'UALICE', text: '<@U0BOT> 지금 켜진 EC2 뭐 있어?', ts: '50.0', channel: 'C1', ...p,
});

const deps = (slack: SlackApi, ask = vi.fn(async () => ({ content: '**2대** 실행 중', via: 'Steampipe' }))) => ({
  slack, ask, botUserId: 'U0BOT', dashboardUrl: 'https://awsops.moyeota.co.kr/',
});

describe('handleMention', () => {
  it('postsPlaceholderInThreadThenUpdatesWithAnswer', async () => {
    const slack = fakeSlack();
    const d = deps(slack);
    await handleMention(ev(), d);
    expect(slack.calls.post[0]).toMatchObject({ channel: 'C1', thread_ts: '50.0', text: PLACEHOLDER_TEXT });
    expect(d.ask).toHaveBeenCalledWith([{ role: 'user', content: '지금 켜진 EC2 뭐 있어?' }]);
    expect(slack.calls.update[0]).toMatchObject({ channel: 'C1', ts: '100.1', text: '*2대* 실행 중' });
    expect(slack.replies).not.toHaveBeenCalled();
  });

  it('usesThreadHistoryWhenMentionedInThread', async () => {
    const slack = fakeSlack({
      replies: vi.fn(async () => [
        { user: 'UALICE', text: '<@U0BOT> EC2 몇 개?', ts: '40.0' },
        { user: 'U0BOT', bot_id: 'B', text: '3개', ts: '41.0' },
        { user: 'UALICE', text: '<@U0BOT> 큰 건?', ts: '50.0' },
      ]),
    });
    const d = deps(slack);
    await handleMention(ev({ thread_ts: '40.0', text: '<@U0BOT> 큰 건?' }), d);
    expect(slack.calls.post[0]).toMatchObject({ thread_ts: '40.0' });
    expect(d.ask).toHaveBeenCalledWith([
      { role: 'user', content: 'EC2 몇 개?' },
      { role: 'assistant', content: '3개' },
      { role: 'user', content: '큰 건?' },
    ]);
  });

  it('fallsBackToQuestionOnlyWhenRepliesFails', async () => {
    const slack = fakeSlack({ replies: vi.fn(async () => { throw new Error('missing_scope'); }) });
    const d = deps(slack);
    await handleMention(ev({ thread_ts: '40.0' }), d);
    expect(d.ask).toHaveBeenCalledWith([{ role: 'user', content: '지금 켜진 EC2 뭐 있어?' }]);
  });

  it('retriesUpdateAsPlainTextWhenBlocksRejected', async () => {
    let n = 0;
    const slack = fakeSlack({
      update: vi.fn(async (a) => { n += 1; if (n === 1) throw new Error('invalid_blocks'); slack.calls.update.push(a); }),
    });
    await handleMention(ev(), deps(slack));
    expect(slack.update).toHaveBeenCalledTimes(2);
    expect(slack.calls.update[0]).not.toHaveProperty('blocks');
    expect((slack.calls.update[0] as { text: string }).text).toContain('*2대* 실행 중');
  });

  it('showsKoreanErrorWhenAiFails', async () => {
    const slack = fakeSlack();
    const ask = vi.fn(async () => { throw new Error('AI API 500'); });
    await handleMention(ev(), deps(slack, ask));
    const text = (slack.calls.update[0] as { text: string }).text;
    expect(text).toContain('답을 만들지 못했어요');
    expect(text).toContain('AI API 500');
  });

  it('repliesWithHelpForEmptyQuestion', async () => {
    const slack = fakeSlack();
    const d = deps(slack);
    await handleMention(ev({ text: '<@U0BOT>' }), d);
    expect(d.ask).not.toHaveBeenCalled();
    expect((slack.calls.post[0] as { text: string }).text).toContain('물어보세요');
  });

  it('ignoresMentionsFromBots', async () => {
    const slack = fakeSlack();
    const d = deps(slack);
    await handleMention(ev({ bot_id: 'B999' }), d);
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(d.ask).not.toHaveBeenCalled();
  });

  it('postsAnswerWhenPlaceholderHasNoTs', async () => {
    const slack = fakeSlack({ postMessage: vi.fn(async (a) => { slack.calls.post.push(a); return {}; }) });
    await handleMention(ev(), deps(slack));
    expect(slack.update).not.toHaveBeenCalled();
    expect(slack.calls.post[1]).toMatchObject({ thread_ts: '50.0', text: '*2대* 실행 중' });
  });
  it('ignoresPeopleFromOtherWorkspaces', async () => {
    const slack = fakeSlack();
    const d = { ...deps(slack), teamId: 'T_OURS' };
    await handleMention(ev({ user_team: 'T_OTHER' }), d);
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(d.ask).not.toHaveBeenCalled();
  });

  it('answersOnlyInAllowedChannels', async () => {
    const slack = fakeSlack();
    const d = { ...deps(slack), teamId: 'T_OURS', allowedChannels: () => ['C_OK'] };
    await handleMention(ev({ user_team: 'T_OURS', channel: 'C1' }), d);
    expect(d.ask).not.toHaveBeenCalled();
    expect(slack.calls.post[0]).toMatchObject({ channel: 'C1', thread_ts: '50.0', text: CHANNEL_NOT_ALLOWED_TEXT });

    const slack2 = fakeSlack();
    const d2 = { ...deps(slack2), allowedChannels: () => ['C_OK'] };
    await handleMention(ev({ channel: 'C_OK' }), d2);
    expect(d2.ask).toHaveBeenCalled();
  });

  it('replacesPlaceholderWithErrorWhenBothRepliesFail', async () => {
    let n = 0;
    const slack = fakeSlack({
      update: vi.fn(async (a) => { n += 1; if (n <= 2) throw new Error('msg_too_long'); slack.calls.update.push(a); }),
    });
    await handleMention(ev(), deps(slack));
    expect(slack.update).toHaveBeenCalledTimes(3);
    expect((slack.calls.update[0] as { text: string }).text).toContain('Slack에 올리지 못했어요');
  });
});

describe('handleAnalyzeClick', () => {
  const click = (p: Record<string, unknown> = {}) => ({
    type: 'block_actions',
    user: { id: 'UALICE', team_id: 'T_OURS' },
    channel: { id: 'C_ALERT' },
    message: { ts: '70.0', text: '🔴 [AWSops] Steampipe 데이터베이스 장애\n• 원인: ECONNREFUSED' },
    actions: [{ action_id: ANALYZE_ACTION_ID }],
    ...p,
  });

  it('marksAlertAsRequestedThenAnswersInAlertThread', async () => {
    const slack = fakeSlack();
    const d = { ...deps(slack), teamId: 'T_OURS' };
    await handleAnalyzeClick(click(), d);
    const marked = slack.calls.update[0] as { ts: string; blocks: unknown[] };
    expect(marked.ts).toBe('70.0');
    expect(JSON.stringify(marked.blocks)).toContain('<@UALICE>');
    expect(JSON.stringify(marked.blocks)).not.toContain(ANALYZE_ACTION_ID);
    expect(slack.calls.post[0]).toMatchObject({ channel: 'C_ALERT', thread_ts: '70.0', text: PLACEHOLDER_TEXT });
    const asked = (d.ask.mock.calls[0] as unknown as [Array<{ content: string }>])[0];
    expect(asked).toHaveLength(1);
    expect(asked[0].content).toContain('ECONNREFUSED');
    expect(slack.calls.update[1]).toMatchObject({ ts: '100.1', text: '*2대* 실행 중' });
  });

  it('stillAnswersWhenMarkingFails', async () => {
    let n = 0;
    const slack = fakeSlack({ update: vi.fn(async (a) => { n += 1; if (n === 1) throw new Error('cant_update_message'); slack.calls.update.push(a); }) });
    const d = deps(slack);
    await handleAnalyzeClick(click(), d);
    expect(d.ask).toHaveBeenCalled();
  });

  it('ignoresOtherActionsAndOtherWorkspaces', async () => {
    const slack = fakeSlack();
    const d = { ...deps(slack), teamId: 'T_OURS' };
    await handleAnalyzeClick(click({ actions: [{ action_id: 'something_else' }] }), d);
    await handleAnalyzeClick(click({ user: { id: 'UX', team_id: 'T_OTHER' } }), d);
    await handleAnalyzeClick(click({ message: { ts: '70.0' } }), d);
    expect(slack.postMessage).not.toHaveBeenCalled();
    expect(slack.update).not.toHaveBeenCalled();
    expect(d.ask).not.toHaveBeenCalled();
  });
});

describe('handleMention change question', () => {
  it('changeQuestionSkipsAi', async () => {
    const slack = fakeSlack();
    const d = { ...deps(slack), tryChangeQuestion: vi.fn(async () => true) };
    await handleMention(ev({ text: '<@U0BOT> moyeota-media 누가 만들었어?' }), d);
    expect(d.tryChangeQuestion).toHaveBeenCalledTimes(1);
    expect(d.ask).not.toHaveBeenCalled();
    expect(slack.calls.post).toHaveLength(0);
  });
});

describe('handleMention cost question', () => {
  it('costQuestionSkipsAi', async () => {
    const slack = fakeSlack();
    const order: string[] = [];
    const d = {
      ...deps(slack),
      tryControl: vi.fn(async () => { order.push('control'); return false; }),
      tryChangeQuestion: vi.fn(async () => { order.push('change'); return false; }),
      tryCostQuestion: vi.fn(async () => { order.push('cost'); return true; }),
    };
    await handleMention(ev({ text: '<@U0BOT> 비용 왜 늘었어?' }), d);
    expect(order).toEqual(['control', 'change', 'cost']);
    expect(d.ask).not.toHaveBeenCalled();
    expect(slack.calls.post).toHaveLength(0);
  });
});
