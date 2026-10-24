// Ask the dashboard's own AI API from inside the server (localhost — never through the ALB/Cognito).
// 서버 안에서 대시보드 AI API 호출 (localhost — ALB/Cognito를 거치지 않는다).
import type { ChatMessage } from './format';

export interface AskResult { content: string; via?: string }

// AgentCore multi-route answers can take a few minutes. / AgentCore 멀티 라우트는 수 분 걸릴 수 있다
const DEFAULT_TIMEOUT_MS = 240_000;

export async function askAwsops(
  messages: ChatMessage[],
  opts: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<AskResult> {
  const baseUrl = opts.baseUrl ?? `http://127.0.0.1:${process.env.PORT || 3000}`;
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${baseUrl}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, stream: false, lang: 'ko' }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  // /api/ai reports failures as {error} with a 500 — read the body before checking the status.
  // /api/ai는 실패를 500 + {error}로 보낸다 — 상태 코드보다 본문을 먼저 읽는다.
  let data: { content?: string; via?: string; error?: string } = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  const detail = data.error ? `: ${String(data.error).slice(0, 200)}` : '';
  if (!res.ok) throw new Error(`AI API ${res.status}${detail}`);
  if (data.error) throw new Error(`AI API error${detail}`);
  if (!data.content) throw new Error('AI API returned no content');
  return { content: data.content, via: data.via };
}
