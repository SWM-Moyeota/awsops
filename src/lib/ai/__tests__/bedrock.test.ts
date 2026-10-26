// invokeText / streamText — request bodies match the inline calls they replaced
// 요청 본문이 대체한 인라인 호출과 바이트 단위로 같은지 고정한다
import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class Cmd { constructor(public input: any) {} }
  return {
    BedrockRuntimeClient: class { send(cmd: any) { return H.send(cmd); } },
    InvokeModelCommand: class InvokeModelCommand extends Cmd {},
    InvokeModelWithResponseStreamCommand: class InvokeModelWithResponseStreamCommand extends Cmd {},
  };
});
vi.mock('@/lib/app-config', () => ({ getConfig: () => ({}), getBedrockModelId: () => 'm' }));

import { invokeText, streamText } from '../bedrock';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const msgs = [{ role: 'user', content: 'hi' }];

async function* iterate<T>(items: T[]) { for (const i of items) yield i; }

beforeEach(() => { H.send.mockReset(); });

describe('invokeText', () => {
  it('sends the exact InvokeModel request the JSON handlers sent inline', async () => {
    H.send.mockResolvedValue({ body: enc({ content: [{ text: 'answer' }], usage: { input_tokens: 3, output_tokens: 5 } }) });
    const r = await invokeText({ modelId: 'model-x', system: 'SYS', messages: msgs });
    const cmd = H.send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('InvokeModelCommand');
    expect(cmd.input.modelId).toBe('model-x');
    expect(cmd.input.contentType).toBe('application/json');
    expect(cmd.input.accept).toBe('application/json');
    expect(dec(cmd.input.body)).toBe(JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: 'SYS', messages: msgs,
    }));
    expect(r).toEqual({ content: 'answer', inputTokens: 3, outputTokens: 5 });
  });

  it('passes maxTokens and an undefined modelId through unchanged', async () => {
    H.send.mockResolvedValue({ body: enc({ content: [] }) });
    const r = await invokeText({ modelId: undefined, system: 'S', messages: msgs, maxTokens: 8192 });
    const cmd = H.send.mock.calls[0][0];
    expect(cmd.input.modelId).toBeUndefined();
    expect(JSON.parse(dec(cmd.input.body)).max_tokens).toBe(8192);
    expect(r).toEqual({ content: '', inputTokens: 0, outputTokens: 0 });
  });
});

describe('streamText', () => {
  it('streams deltas as chunk events and returns content + usage', async () => {
    H.send.mockResolvedValue({ body: iterate([
      { chunk: { bytes: enc({ type: 'message_start', message: { usage: { input_tokens: 7 } } }) } },
      { chunk: { bytes: enc({ type: 'content_block_delta', delta: { text: 'ab' } }) } },
      { chunk: { bytes: enc({ type: 'content_block_delta', delta: { text: 'cd' } }) } },
      { chunk: { bytes: enc({ type: 'message_delta', usage: { output_tokens: 9 } }) } },
    ]) });
    const send = vi.fn();
    const r = await streamText({ modelId: 'model-y', system: 'SYS', messages: msgs, maxTokens: 8192 }, send);
    const cmd = H.send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('InvokeModelWithResponseStreamCommand');
    expect(dec(cmd.input.body)).toBe(JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 8192, system: 'SYS', messages: msgs,
    }));
    expect(send.mock.calls).toEqual([['chunk', { delta: 'ab' }], ['chunk', { delta: 'cd' }]]);
    expect(r).toEqual({ content: 'abcd', inputTokens: 7, outputTokens: 9 });
  });
});
