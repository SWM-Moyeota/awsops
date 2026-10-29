// AI fixer tests: validation, scrubbing, usage recording / AI 수정기 테스트: 검증, 비밀 제거, 사용량 기록
import { describe, it, expect, vi } from 'vitest';

vi.mock('../secrets', () => ({ scrubForAi: (t: string) => t.replace(/fake-secret-\d+/g, '[숨김]') }));
vi.mock('@/lib/app-config', () => ({ getBedrockModelId: () => 'm-id', getBedrockModelLabel: () => 'm-label' }));
vi.mock('@/lib/ai/bedrock', () => ({ invokeText: vi.fn() }));
vi.mock('@/lib/root-cause/analyze', () => ({
  withCap: <T,>(fn: () => Promise<T>, ms: number) => Promise.race([Promise.resolve().then(fn), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Timeout')), ms))]),
}));
vi.mock('@/lib/ai/stats', () => ({ recordAndSave: vi.fn() }));

import { validateFix, extractHcl, aiFix, FIX_SYSTEM_PROMPT } from '../ai';

const ADDR = 'aws_security_group.web';
const GOOD = 'resource "aws_security_group" "web" {\n  name = "web"\n  tags = { A = "{x}" }\n}';

describe('validateFix', () => {
  it('accepts a good block', () => {
    const r = validateFix(GOOD, ADDR);
    expect(r.ok).toBe(true);
  });
  it('accepts allowed ignore_changes', () => {
    const b = 'resource "aws_security_group" "web" {\n lifecycle {\n  ignore_changes = [tags_all, user_data]\n }\n}';
    expect(validateFix(b, ADDR).ok).toBe(true);
  });
  it('rejects ignore_changes = [ami] and all', () => {
    expect(validateFix('resource "aws_security_group" "web" {\n lifecycle { ignore_changes = [ami] }\n}', ADDR).ok).toBe(false);
    expect(validateFix('resource "aws_security_group" "web" {\n lifecycle { ignore_changes = all }\n}', ADDR).ok).toBe(false);
  });
  it('rejects provisioner / local-exec', () => {
    expect(validateFix('resource "aws_security_group" "web" {\n provisioner "local-exec" {\n command = "x"\n }\n}', ADDR).ok).toBe(false);
  });
  it('rejects extra provider/module/data blocks and two blocks', () => {
    expect(validateFix(GOOD + '\nprovider "aws" {\n region = "x"\n}', ADDR).ok).toBe(false);
    expect(validateFix(GOOD + '\ndata "http" "x" {\n url = "y"\n}', ADDR).ok).toBe(false);
    expect(validateFix(GOOD + '\n' + GOOD.replace('"web"', '"web2"'), ADDR).ok).toBe(false);
  });
  it('rejects a different address', () => {
    expect(validateFix(GOOD.replace('"web"', '"other"'), ADDR).ok).toBe(false);
    expect(validateFix(GOOD.replace('aws_security_group', 'aws_vpc'), ADDR).ok).toBe(false);
  });
});

describe('extractHcl', () => {
  it('takes the first hcl fence, or a plain fence', () => {
    expect(extractHcl('x\n```hcl\nA\n```\n```hcl\nB\n```')).toBe('A');
    expect(extractHcl('```\nC\n```')).toBe('C');
    expect(extractHcl('no block')).toBeNull();
  });
});

describe('aiFix', () => {
  const input = {
    address: ADDR, block: 'resource "aws_security_group" "web" {\n password = "fake-secret-1"\n}',
    problem: { kind: 'diff' as const, changes: [{ path: 'name', remote: 'fake-secret-2' }] }, userId: 'u@x.com',
  };
  it('scrubs secrets from the prompt, validates and records usage', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: '```hcl\n' + GOOD + '\n```', inputTokens: 10, outputTokens: 5 });
    const record = vi.fn();
    const r = await aiFix(input, { invoke, record });
    const req = invoke.mock.calls[0][0];
    const sent = JSON.stringify(req);
    expect(sent).not.toContain('fake-secret');
    expect(req.maxTokens).toBe(4000);
    expect(JSON.stringify(req.messages).length).toBeLessThan(17000);
    expect(r).toMatchObject({ ok: true, inputTokens: 10, outputTokens: 5 });
    expect(record.mock.calls[0][0]).toMatchObject({ route: 'terraform-export', gateway: 'bedrock', via: 'tf-export', success: true, userId: 'u@x.com' });
  });
  it('rejects an invalid AI answer but still records tokens', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: '```hcl\n' + GOOD.replace('"web"', '"zzz"') + '\n```', inputTokens: 3, outputTokens: 2 });
    const record = vi.fn();
    const r = await aiFix(input, { invoke, record });
    expect(r.ok).toBe(false);
    expect(r.inputTokens).toBe(3);
    expect(record.mock.calls[0][0].success).toBe(false);
  });
  it('invoke throwing gives ok:false', async () => {
    const record = vi.fn();
    const r = await aiFix({ ...input, userId: undefined }, { invoke: vi.fn().mockRejectedValue(new Error('boom')), record });
    expect(r).toMatchObject({ ok: false, inputTokens: 0, outputTokens: 0 });
    expect(record.mock.calls[0][0].userId).toBe('system');
  });
  it('timeout gives ok:false', async () => {
    vi.useFakeTimers();
    const p = aiFix(input, { invoke: () => new Promise(() => {}), record: vi.fn() });
    await vi.advanceTimersByTimeAsync(121_000);
    expect((await p).ok).toBe(false);
    vi.useRealTimers();
  });
  it('prompt mentions the rules', () => {
    expect(FIX_SYSTEM_PROMPT).toContain('ignore_changes');
  });
});
