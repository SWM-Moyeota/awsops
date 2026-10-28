// Slack alert/question tests with faked deps — nothing is posted anywhere. / Slack 시험 — 가짜 의존성만, 실제 전송 없음.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({}) as { appUrl?: string; rootCause?: { slackAlerts?: boolean } });
vi.mock('@/lib/app-config', async (orig) => ({ ...(await orig<object>()), getConfig: () => cfg }));

import { detectRcaQuestion, formatIncidentAlert, maybeHandleRcaQuestion, notifyIncident } from '../slack';
import type { Incident, Suspect } from '../types';
import type { MentionEvent } from '@/lib/slack-chatops/handle';

const suspect = (): Suspect => ({
  event: { eventId: 'e1', eventName: 'RevokeSecurityGroupIngress', eventSource: 'ec2.amazonaws.com', time: '2026-10-29T05:50:00Z', accountId: '1', region: 'r', actor: { kind: 'person', name: 'kim' }, tool: 'console', refs: [{ type: 'sg', id: 'sg-0ab' }], params: '' },
  proximity: { distance: 1, path: [], matchedArn: null }, weights: { time: 1, graph: 1, kind: 1 }, score: 1, rank: 1,
});
const inc = (over: Partial<Incident> = {}): Incident => ({
  id: 'inc-1', key: 'k', accountId: '1', region: 'r', resourceArn: 'arn:aws:elasticloadbalancing:r:1:loadbalancer/app/mo/x', resourceName: 'mo',
  signals: [{ kind: 'alb-5xx', accountId: '1', region: 'r', resourceArn: null, startedAt: '2026-10-29T06:02:00Z', detail: '5xx 급증' }],
  startedAt: '2026-10-29T06:02:00Z', firstSeenAt: '', lastSeenAt: '', status: 'open', source: 'auto',
  analysis: { analyzedAt: '', windowFrom: '', windowTo: '', graph: { from: null, to: null, count: 0 }, eventsSeen: 1, truncated: false, failedRegions: [], suspects: [suspect()], ai: { status: 'ok', summary: 'SG 규칙 삭제가 원인으로 보여요', droppedCitations: 0 } },
  ...over,
});
const ev = (text: string): MentionEvent => ({ type: 'app_mention', user: 'U1', text, ts: '1', channel: 'C' });

beforeEach(() => { delete cfg.appUrl; delete cfg.rootCause; });

describe('formatIncidentAlert', () => {
  it('full alert with link', () => {
    const t = formatIncidentAlert(inc({ signals: [...inc().signals, { ...inc().signals[0], kind: 'tg-unhealthy' }] }), 'https://a.io/');
    expect(t).toContain('🔎 장애 감지: mo(ALB) 5xx 급증 외 신호 1개 (15:02부터)');
    expect(t).toContain('의심 1위: 14:50 kim님이 sg-0ab RevokeSecurityGroupIngress (콘솔)');
    expect(t).toContain('SG 규칙 삭제가 원인으로 보여요');
    expect(t).toContain('https://a.io/root-cause?id=inc-1');
  });
  it('no link without appUrl; no AI line when unverified', () => {
    const i = inc(); i.analysis!.ai = { status: 'unverified', summary: 'x', droppedCitations: 1 };
    const t = formatIncidentAlert(i);
    expect(t).not.toContain('root-cause?id');
    expect(t).not.toContain('x\n');
    expect(t.split('\n')).toHaveLength(2);
  });
  it('no suspects', () => {
    const i = inc(); i.analysis!.suspects = [];
    expect(formatIncidentAlert(i)).toContain('직전 60분에 관련 변경이 없어요');
  });
});

describe('notifyIncident', () => {
  it('bot ok, button false', async () => {
    const viaBot = vi.fn(async () => ({ ok: true })); const post = vi.fn();
    expect(await notifyIncident(inc(), { viaBot, post })).toBe(true);
    expect(viaBot).toHaveBeenCalledWith(expect.any(String), { button: false });
    expect(post).not.toHaveBeenCalled();
  });
  it('bot unconfigured falls back to webhook', async () => {
    const post = vi.fn(async () => ({ ok: true }));
    expect(await notifyIncident(inc(), { viaBot: async () => ({ ok: false }), webhook: async () => 'https://hook', post })).toBe(true);
    expect(post).toHaveBeenCalledWith('https://hook', { text: expect.stringContaining('장애 감지') });
  });
  it('no webhook -> false', async () => {
    expect(await notifyIncident(inc(), { viaBot: async () => ({ ok: false }), webhook: async () => null })).toBe(false);
  });
  it('slackAlerts false -> no calls', async () => {
    cfg.rootCause = { slackAlerts: false };
    const viaBot = vi.fn();
    expect(await notifyIncident(inc(), { viaBot })).toBe(false);
    expect(viaBot).not.toHaveBeenCalled();
  });
});

describe('detectRcaQuestion', () => {
  it('positives', () => {
    expect(detectRcaQuestion('<@U0> 왜 고장났어 sg-0abc1')).toEqual({ query: 'sg-0abc1' });
    expect(detectRcaQuestion('web-prod 원인이 뭐야?')).toEqual({ query: 'web-prod' });
    expect(detectRcaQuestion('why is i-0123 down')).toEqual({ query: 'i-0123' });
    expect(detectRcaQuestion('mo-alb 뭐가 바뀌었어')).toEqual({ query: 'mo-alb' });
  });
  it('negatives', () => {
    expect(detectRcaQuestion('누가 sg-1 만들었어?')).toBeNull();
    expect(detectRcaQuestion('왜 고장났어')).toBeNull();
    expect(detectRcaQuestion('why is it down')).toBeNull();
  });
});

describe('maybeHandleRcaQuestion', () => {
  const node = { arn: 'arn:x', type: 'sg' as const, id: 'sg-1', name: 'sg-1', accountId: '1', region: 'r', attrs: {} };
  it('no detection -> false', async () => {
    expect(await maybeHandleRcaQuestion(ev('안녕'), { reply: vi.fn() })).toBe(false);
  });
  it('not found -> false, no reply', async () => {
    const reply = vi.fn();
    expect(await maybeHandleRcaQuestion(ev('왜 고장났어 sg-9'), { reply, search: async () => [] })).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
  it('found -> progress + alert', async () => {
    const reply = vi.fn(); const analyze = vi.fn(async () => inc());
    expect(await maybeHandleRcaQuestion(ev('왜 고장났어 sg-1'), { reply, search: async () => [node], analyze })).toBe(true);
    expect(analyze).toHaveBeenCalledWith({ accountId: '1', resourceArn: 'arn:x', userId: 'U1' });
    expect(reply.mock.calls[0][0]).toBe('분석 중이에요…');
    expect(reply.mock.calls[1][0]).toContain('장애 감지');
  });
  it.each([
    ['RateLimited', '방금 분석했어요. 30초 뒤에 다시 물어봐 주세요.'],
    ['Timeout', '분석이 오래 걸려요. 끝나면 /root-cause 화면에서 볼 수 있어요.'],
  ])('%s', async (name, text) => {
    const reply = vi.fn();
    const analyze = vi.fn(async () => { throw Object.assign(new Error(name), { name }); });
    expect(await maybeHandleRcaQuestion(ev('왜 고장났어 sg-1'), { reply, search: async () => [node], analyze })).toBe(true);
    expect(reply).toHaveBeenLastCalledWith(text);
  });
  it('other error -> fallback, true', async () => {
    const reply = vi.fn();
    expect(await maybeHandleRcaQuestion(ev('왜 고장났어 sg-1'), { reply, search: async () => [node], analyze: async () => { throw new Error('x'); } })).toBe(true);
    expect(reply).toHaveBeenCalledTimes(2);
  });
});
