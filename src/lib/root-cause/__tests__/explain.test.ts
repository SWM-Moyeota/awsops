// Tests for the evidence bundle and citation-verified explanation (no real Bedrock).
// 근거 묶음과 인용 검증 설명 시험 — 실제 Bedrock 호출 없음.
import { describe, it, expect, vi } from 'vitest';
import { buildBundle } from '../bundle';
import { parseAiAnswer, explain, ROOT_CAUSE_SYSTEM_PROMPT } from '../explain';
import type { Suspect, Signal } from '../types';

const ctx = { signals: [{ kind: 'alb-5xx', accountId: '1', region: 'ap-northeast-2', resourceArn: null, startedAt: '2026-10-29T06:00:00Z', detail: '5분 5xx 312건, 평소 2건' } as Signal], resourceName: 'mo', startedAt: '2026-10-29T06:00:00Z', graph: { from: null, to: null } };

function sus(i: number, params = '{"a":1}'): Suspect {
  return { event: { eventId: `ev-${i}`, eventName: 'RevokeSecurityGroupIngress', eventSource: 'ec2.amazonaws.com', time: '2026-10-29T05:50:00Z', accountId: '1', region: 'ap-northeast-2', actor: { kind: 'user', name: 'kim' } as any, tool: 'console', refs: [{ type: 'sg', id: 'sg-1' }], params },
    proximity: { distance: 1, path: ['mo(lb)', 'sg-1(sg)'], matchedArn: null }, weights: { time: 0.8, graph: 0.85, kind: 1 }, score: 0.68, rank: i + 1 };
}

describe('buildBundle', () => {
  it('excludes IP / userAgent / secrets present in params', () => {
    const p = '{"sourceIPAddress":"203.0.113.9","userAgent":"aws-cli/2","password":"hunter2","AccessKeyId":"AKIAABCDEFGHIJKLMNOP","ok":1}';
    const { text } = buildBundle(ctx, [sus(0, p)]);
    expect(text).not.toContain('203.0.113.9');
    expect(text).not.toContain('aws-cli');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('AKIA');
    expect(text).toContain('ev-0');
  });
  it('caps size and keeps eventIds consistent', () => {
    const big = JSON.stringify({ x: 'y'.repeat(590) });
    const many = Array.from({ length: 50 }, (_, i) => sus(i, big));
    const r = buildBundle(ctx, many, { maxChars: 3000 });
    expect(r.text.length).toBeLessThanOrEqual(3000);
    expect(r.eventIds.length).toBeGreaterThan(0);
    for (const id of r.eventIds) expect(r.text).toContain(id);
    expect(r.text).not.toContain('ev-9');
    const d = buildBundle(ctx, many);
    expect(d.eventIds.length).toBeLessThanOrEqual(8);
    expect(d.text.length).toBeLessThanOrEqual(24000);
  });
});

describe('parseAiAnswer', () => {
  const ids = ['ev-0', 'ev-1'];
  it('parses fenced json', () => {
    const t = '```json\n{"summary":"s","causes":[{"eventId":"ev-0","reason":"r","confidence":"high"}],"checks":["a",1]}\n```';
    const r = parseAiAnswer(t, ids);
    expect(r.status).toBe('ok');
    expect(r.causes).toHaveLength(1);
    expect(r.checks).toEqual(['a']);
  });
  it('drops unknown ids and counts', () => {
    const r = parseAiAnswer('{"summary":"s","causes":[{"eventId":"ev-0","reason":"r","confidence":"zzz"},{"eventId":"nope","reason":"r","confidence":"high"}]}', ids);
    expect(r.status).toBe('ok');
    expect(r.droppedCitations).toBe(1);
    expect(r.causes![0].confidence).toBe('low');
  });
  it('all unknown -> unverified', () => {
    const r = parseAiAnswer('{"summary":"s","causes":[{"eventId":"x","reason":"r","confidence":"high"}]}', ids);
    expect(r.status).toBe('unverified');
    expect(r.droppedCitations).toBe(1);
    expect(r.summary).toBeUndefined();
    expect(r.causes).toBeUndefined();
  });
  it('prose only -> failed', () => {
    expect(parseAiAnswer('잘 모르겠습니다', ids)).toEqual({ status: 'failed', droppedCitations: 0 });
  });
});

describe('explain', () => {
  it('skips with no suspects', async () => {
    const invoke = vi.fn();
    const r = await explain({ text: '', eventIds: [] }, { invoke });
    expect(r).toEqual({ status: 'skipped', droppedCitations: 0 });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('failed when invoke throws', async () => {
    const r = await explain({ text: 't', eventIds: ['ev-0'] }, { invoke: vi.fn().mockRejectedValue(new Error('x')) });
    expect(r.status).toBe('failed');
  });
  it('passes maxTokens and model id, records usage', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: '{"summary":"s","causes":[{"eventId":"ev-0","reason":"r","confidence":"high"}]}', inputTokens: 5, outputTokens: 7 });
    const record = vi.fn();
    const r = await explain({ text: 't', eventIds: ['ev-0'] }, { invoke, record });
    expect(r.status).toBe('ok');
    const req = invoke.mock.calls[0][0];
    expect(req.maxTokens).toBe(1200);
    expect(typeof req.modelId).toBe('string');
    expect(req.system).toBe(ROOT_CAUSE_SYSTEM_PROMPT);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 5, outputTokens: 7, ok: true }));
  });
});
