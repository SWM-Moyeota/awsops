import { InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from './clients';

// ============================================================================
// SSE helpers / SSE 헬퍼
// ============================================================================
export function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ============================================================================
// Simulated streaming: send pre-generated text as chunks for typing effect
// 시뮬레이션 스트리밍: 완성된 텍스트를 청크로 나눠 타이핑 효과 구현
// ============================================================================
const CHUNK_SIZE = 50;  // Characters per chunk / 청크당 글자 수
const CHUNK_DELAY_MS = 15; // Delay between chunks (ms) / 청크 간 딜레이

export async function simulateStreaming(
  text: string,
  send: (event: string, data: any) => void,
): Promise<void> {
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    const chunk = text.slice(i, i + CHUNK_SIZE);
    send('chunk', { delta: chunk });
    if (i + CHUNK_SIZE < text.length) {
      await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
    }
  }
}

// ============================================================================
// Bedrock streaming helper: stream response chunks as SSE events
// Bedrock 스트리밍 헬퍼: 응답 청크를 SSE 이벤트로 전송
// ============================================================================
export async function streamBedrockToSSE(
  params: { modelId: string | undefined; system: string; messages: Array<{role: string; content: string}>; maxTokens?: number },
  send: (event: string, data: any) => void,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: params.maxTokens || 4096,
    system: params.system,
    messages: params.messages,
  });

  const response = await bedrockClient.send(new InvokeModelWithResponseStreamCommand({
    modelId: params.modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: new TextEncoder().encode(body),
  }));

  let fullContent = '';
  let inputTokens = 0;
  let outputTokens = 0;

  if (response.body) {
    for await (const event of response.body) {
      if (event.chunk?.bytes) {
        const parsed = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
        // content_block_delta contains streaming text / 스트리밍 텍스트 포함
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          fullContent += parsed.delta.text;
          send('chunk', { delta: parsed.delta.text });
        }
        // message_delta contains stop reason / 메시지 종료 정보
        if (parsed.type === 'message_delta' && parsed.usage) {
          outputTokens = parsed.usage.output_tokens || 0;
        }
        // message_start contains input token count / 입력 토큰 수
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          inputTokens = parsed.message.usage.input_tokens || 0;
        }
      }
    }
  }

  return { content: fullContent, inputTokens, outputTokens };
}
