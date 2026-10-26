// Shared step contract / 공유 단계 계약
// 한 단계 = 두 경로가 함께 쓰는 처리기 본문. 경로 차이(spec §3)는 호출하는 쪽이 넘기는 opts 플래그로만 표현한다.
// A step is the handler body both paths share. Path differences (spec §3) arrive only as caller-supplied opts flags.
// JSON: emit = () => {}, llm = invokeText. Stream: emit = send, llm = req => streamText(req, send).
import type { LlmRequest, LlmResult } from '../bedrock';
import type { RouteType } from '../registry';
import type { buildStatus } from '../status';

export type ChatMessage = { role: string; content: string };
export type Emit = (event: string, data: any) => void;

export interface StepCtx {
  route: RouteType;                        // the route this step handles (its registry entry)
  messages: ChatMessage[];
  lang?: string;                           // request `lang`, unchanged
  accountId?: string;
  accountAlias?: string;
  requestId: string;                       // one per request (health vote) — every AgentCore call shares it
  systemPrompt: string;                    // getSystemPrompt(lang), computed once by the caller
  status: ReturnType<typeof buildStatus>;  // status-event text; the JSON emit drops it
  emit: Emit;
  llm: (req: LlmRequest) => Promise<LlmResult>;
}

export interface StepResult {
  content: string;
  via: string;
  queriedResources: string[];
  usedTools?: string[];
  route: RouteType;
  inputTokens?: number;                    // from ctx.llm; only the stream pipeline adds them to `done`
  outputTokens?: number;
  extra?: Record<string, unknown>;
}

// Which path is calling — only for text that differs per path (code via, datasource context).
// 호출 경로 — 경로마다 다른 문구(code via, 데이터소스 컨텍스트)에만 쓴다.
export type StepVariant = 'stream' | 'json';

// What an empty LLM answer becomes: stream 'No response', JSON ''.
export type EmptyContent = 'No response' | '';

// Same mapping every handler used inline / 처리기마다 인라인으로 쓰던 그대로
export function recentMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content }));
}

export function lastMessageOf(messages: ChatMessage[]): string {
  return messages[messages.length - 1]?.content || '';
}
