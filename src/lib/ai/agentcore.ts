// AgentCore Runtime / AgentCore 런타임
import { InvokeAgentRuntimeCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'crypto';
import { reportAgentcoreInvoke } from '@/lib/health/monitor';
import { agentCoreClient, getAgentRuntimeArn } from './clients';

export const AGENTCORE_TIMEOUT_MS = 90000; // 90초 — Gateway 도구 실행 시간 고려 / 90s for tool execution

export async function invokeAgentCore(
  messages: Array<{role: string; content: string}>,
  gateway: string,
  accountId?: string,
  accountAlias?: string,
  skill?: string,
  requestId: string = randomUUID(),
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const recentMessages = messages.slice(-10);
    const payload: Record<string, any> = {
      messages: recentMessages,
      gateway,
      accountId: accountId || '',
      accountAlias: accountAlias || '',
    };
    if (skill) payload.skill = skill;
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: getAgentRuntimeArn(),
      qualifier: 'DEFAULT',
      payload: JSON.stringify(payload),
    });

    const timeoutPromise = new Promise<null>((resolve) =>
      timer = setTimeout(() => {
        console.warn(`[AgentCore] Timeout after ${AGENTCORE_TIMEOUT_MS}ms for gateway=${gateway}`);
        reportAgentcoreInvoke(requestId, 'timeout');
        resolve(null);
      }, AGENTCORE_TIMEOUT_MS)
    );

    const agentPromise = (async () => {
      const response = await agentCoreClient.send(command);
      const sessionId = response.runtimeSessionId;
      const body = await streamToString(response.response);
      const text = body.startsWith('"') ? JSON.parse(body) : body;
      if (sessionId) {
        try {
          await agentCoreClient.send(new StopRuntimeSessionCommand({
            agentRuntimeArn: getAgentRuntimeArn(), runtimeSessionId: sessionId, qualifier: 'DEFAULT',
          }));
        } catch {}
      }
      return text as string;
    })();

    const result = await Promise.race([agentPromise, timeoutPromise]);
    if (result) reportAgentcoreInvoke(requestId, 'success');
    return result;
  } catch (err: any) {
    console.error('[AgentCore Error]', err?.message || err);
    // ValidationException = bad client-side request (e.g. payload/session id), not an AgentCore outage:
    // log only, don't count it. / 클라이언트 측 요청 오류는 장애로 집계하지 않는다.
    if (err?.name !== 'ValidationException') {
      reportAgentcoreInvoke(requestId, 'error', `${err?.name || 'Error'}: ${err?.message || err}`);
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function streamToString(stream: any): Promise<string> {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  if (typeof stream.transformToString === 'function') return stream.transformToString();
  if (typeof stream.transformToByteArray === 'function') {
    const bytes = await stream.transformToByteArray();
    return new TextDecoder().decode(bytes);
  }
  if (typeof stream.read === 'function') return stream.read().toString('utf-8');
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    }
    return chunks.join('');
  }
  return String(stream);
}
