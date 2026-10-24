import { describe, it, expect } from 'vitest';
import {
  extractQuestion, buildConversation, toSlackMessage, markdownToMrkdwn,
  PLACEHOLDER_TEXT, MAX_ANSWER_CHARS,
} from '../format';

describe('extractQuestion', () => {
  it('stripsMentionsAndTrims', () => {
    expect(extractQuestion('<@U0BOT123> 지금 켜진 EC2 뭐 있어?')).toBe('지금 켜진 EC2 뭐 있어?');
  });
  it('stripsLabelledMentionsAnywhere', () => {
    expect(extractQuestion('hey <@U0BOT123|awsops>   moyeota-backend   왜 느려?')).toBe('hey moyeota-backend 왜 느려?');
  });
  it('returnsEmptyForMentionOnly', () => {
    expect(extractQuestion('<@U0BOT123>  ')).toBe('');
  });
});

describe('buildConversation', () => {
  const bot = 'U0BOT123';
  it('returnsOnlyQuestionWithoutThread', () => {
    expect(buildConversation([], { botUserId: bot, currentTs: '10.0', question: 'q' }))
      .toEqual([{ role: 'user', content: 'q' }]);
  });
  it('mapsThreadRolesSkipsPlaceholderAndCurrentMessage', () => {
    const thread = [
      { user: 'UALICE', text: '<@U0BOT123> EC2 몇 개야?', ts: '1.0' },
      { user: bot, bot_id: 'B1', text: '3개예요', ts: '2.0' },
      { user: bot, bot_id: 'B1', text: PLACEHOLDER_TEXT, ts: '3.0' },
      { user: 'UALICE', text: '<@U0BOT123> 그 중 큰 건?', ts: '10.0' },
    ];
    expect(buildConversation(thread, { botUserId: bot, currentTs: '10.0', question: '그 중 큰 건?' })).toEqual([
      { role: 'user', content: 'EC2 몇 개야?' },
      { role: 'assistant', content: '3개예요' },
      { role: 'user', content: '그 중 큰 건?' },
    ]);
  });
  it('mergesConsecutiveSameRoleAndDropsLeadingAssistant', () => {
    const thread = [
      { user: bot, bot_id: 'B1', text: '알림 원문', ts: '1.0' },
      { user: 'UA', text: '첫째', ts: '2.0' },
      { user: 'UB', text: '둘째', ts: '3.0' },
    ];
    expect(buildConversation(thread, { botUserId: bot, currentTs: '9.0', question: '셋째' })).toEqual([
      { role: 'user', content: '첫째\n\n둘째\n\n셋째' },
    ]);
  });
  it('keepsAtMostTenPriorMessages', () => {
    const thread = Array.from({ length: 30 }, (_, i) => ({
      user: i % 2 ? bot : 'UA', text: `m${i}`, ts: `${i + 1}.0`,
    }));
    const conv = buildConversation(thread, { botUserId: bot, currentTs: '99.0', question: 'last' });
    expect(conv.length).toBeLessThanOrEqual(11);
    expect(conv[0].role).toBe('user');
    expect(conv[conv.length - 1]).toEqual({ role: 'user', content: 'last' });
  });
  it('ignoresMessagesAfterCurrent', () => {
    const thread = [{ user: 'UA', text: 'later', ts: '20.0' }];
    expect(buildConversation(thread, { botUserId: bot, currentTs: '10.0', question: 'q' }))
      .toEqual([{ role: 'user', content: 'q' }]);
  });
});

describe('markdownToMrkdwn', () => {
  it('convertsBoldHeadingsAndLinks', () => {
    expect(markdownToMrkdwn('## 요약\n**3개** 실행 중, [보기](https://x.y/z)'))
      .toBe('*요약*\n*3개* 실행 중, <https://x.y/z|보기>');
  });
  it('leavesCodeBlocksAlone', () => {
    const md = '```\n**not bold**\n```';
    expect(markdownToMrkdwn(md)).toBe(md);
  });
});

describe('toSlackMessage', () => {
  it('buildsMarkdownBlockAndContextFooter', () => {
    const m = toSlackMessage('**답**', { via: 'Steampipe <SQL>', seconds: 4.2, dashboardUrl: 'https://awsops.moyeota.co.kr/' });
    expect(m.blocks[0]).toEqual({ type: 'markdown', text: '**답**' });
    const ctx = JSON.stringify(m.blocks[1]);
    expect(ctx).toContain('Steampipe &lt;SQL&gt;');
    expect(ctx).toContain('4초');
    expect(ctx).toContain('<https://awsops.moyeota.co.kr/ai|대시보드 AI에서 이어 묻기>');
    expect(m.text).toBe('*답*');
  });
  it('truncatesLongAnswers', () => {
    const m = toSlackMessage('가'.repeat(MAX_ANSWER_CHARS + 500), { seconds: 1 });
    const md = (m.blocks[0] as { text: string }).text;
    expect(md.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS + 100);
    expect(md).toContain('잘렸어요');
  });
});
