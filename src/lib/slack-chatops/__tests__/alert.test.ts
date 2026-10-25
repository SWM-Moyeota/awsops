import { describe, it, expect, vi, afterEach } from 'vitest';

const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/lib/app-config', () => ({ getConfig: () => config.value }));

import {
  buildAlertBlocks, buildAnalysisPrompt, postAlertViaBot, setBotHandle, getBotHandle, ANALYZE_ACTION_ID,
} from '../alert';

afterEach(() => {
  setBotHandle(null);
  config.value = {};
});

describe('buildAlertBlocks', () => {
  it('addsAnalyzeButtonWhenRequested', () => {
    const blocks = buildAlertBlocks('🔴 장애', { button: true }) as Array<Record<string, any>>;
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: '🔴 장애' } });
    expect(blocks[1].type).toBe('actions');
    expect(blocks[1].elements[0]).toMatchObject({ type: 'button', action_id: ANALYZE_ACTION_ID });
  });
  it('omitsButtonForRecoveries', () => {
    expect(buildAlertBlocks('🟢 복구', { button: false })).toHaveLength(1);
  });
  it('replacesButtonWithRequesterNote', () => {
    const blocks = buildAlertBlocks('🔴 장애', { button: true, requestedBy: 'UALICE' }) as Array<Record<string, any>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe('context');
    expect(JSON.stringify(blocks[1])).toContain('<@UALICE>');
  });
  it('capsSectionText', () => {
    const blocks = buildAlertBlocks('x'.repeat(5000), { button: false }) as Array<Record<string, any>>;
    expect(blocks[0].text.text.length).toBeLessThanOrEqual(3000);
  });
});

describe('buildAnalysisPrompt', () => {
  it('asksForCauseChecksAndFixWithAlertText', () => {
    const p = buildAnalysisPrompt('🔴 [AWSops] Steampipe 데이터베이스 장애');
    expect(p).toContain('원인');
    expect(p).toContain('조치');
    expect(p).toContain('Steampipe 데이터베이스 장애');
  });
});

describe('postAlertViaBot', () => {
  it('returnsNotConfiguredWithoutChannelOrBot', async () => {
    expect(await postAlertViaBot('t', { button: true })).toEqual({ ok: false });
    setBotHandle({ postMessage: vi.fn(async () => ({ ts: '1' })) });
    expect(await postAlertViaBot('t', { button: true })).toEqual({ ok: false });
    setBotHandle(null);
    config.value = { slackAlertChannelId: 'C_ALERT' };
    expect(await postAlertViaBot('t', { button: true })).toEqual({ ok: false });
  });
  it('postsToAlertChannelWithBlocks', async () => {
    const postMessage = vi.fn(async () => ({ ts: '1' }));
    setBotHandle({ postMessage });
    config.value = { slackAlertChannelId: 'C_ALERT' };
    expect(await postAlertViaBot('🔴 장애', { button: true })).toEqual({ ok: true });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C_ALERT', text: '🔴 장애' }));
  });
  it('reportsSlackErrorCodeOnFailure', async () => {
    setBotHandle({ postMessage: vi.fn(async () => { throw Object.assign(new Error('x'), { data: { error: 'not_in_channel' } }); }) });
    config.value = { slackAlertChannelId: 'C_ALERT' };
    expect(await postAlertViaBot('t', { button: false })).toEqual({ ok: false, error: 'Slack bot post failed (not_in_channel)' });
  });
  it('sharesHandleThroughGlobalThis', () => {
    const h = { postMessage: vi.fn(async () => ({})) };
    setBotHandle(h);
    expect(getBotHandle()).toBe(h);
    expect((globalThis as Record<string, unknown>).__awsopsSlackBotHandle).toBe(h);
  });
});
