// Bedrock text calls shared by the steps / 단계들이 함께 쓰는 Bedrock 텍스트 호출
// invokeText = JSON 경로(InvokeModel), streamText = 스트림 경로(InvokeModelWithResponseStream, 청크를 send로 흘림).
// Request bodies are byte-identical to the inline calls they replace. / 요청 본문은 대체한 인라인 호출과 바이트 단위로 같다.
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from './clients';
import { streamBedrockToSSE } from './sse';

export interface LlmRequest {
  modelId: string | undefined;   // undefined only on the JSON datasource/auto-collect path (rawModelId)
  system: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;            // default 4096
}

export interface LlmResult { content: string; inputTokens: number; outputTokens: number }

// JSON path: one InvokeModel call. content = `content[0].text || ''`, as the inline JSON calls read it.
// JSON 경로: InvokeModel 한 번. 본문은 `{anthropic_version, max_tokens, system, messages}` 순서 그대로.
export async function invokeText(req: LlmRequest): Promise<LlmResult> {
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31', max_tokens: req.maxTokens || 4096, system: req.system, messages: req.messages,
  });
  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: req.modelId, contentType: 'application/json', accept: 'application/json',
    body: new TextEncoder().encode(body),
  }));
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return {
    content: result.content?.[0]?.text || '',
    inputTokens: result.usage?.input_tokens || 0,
    outputTokens: result.usage?.output_tokens || 0,
  };
}

// Stream path: streams each delta as a `chunk` event through `send` (= streamBedrockToSSE).
// 스트림 경로: 델타마다 `chunk` 이벤트를 send로 보낸다 (streamBedrockToSSE 그대로).
export function streamText(req: LlmRequest, send: (event: string, data: any) => void): Promise<LlmResult> {
  return streamBedrockToSSE(req, send);
}
