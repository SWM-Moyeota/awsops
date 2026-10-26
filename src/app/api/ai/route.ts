// AI routing API: Tool-based route registry + Sonnet intent classification + conversation history
// AI 라우팅 API: 도구 기반 라우트 레지스트리 + Sonnet 의도 분류 + 대화 히스토리
// Flow: classify intent (from registry) → route to handler → fallback
// 흐름: 의도 분류 (레지스트리 기반) → 핸들러 라우팅 → 폴백
import { NextRequest, NextResponse } from 'next/server';
import { validateAccountId, getAccountById, getBedrockModelLabel } from '@/lib/app-config';
import { getUserFromRequest } from '@/lib/auth-utils';
import { randomUUID } from 'crypto';
import { getSystemPrompt } from '@/lib/ai/prompts';
import { buildStatus } from '@/lib/ai/status';
import { handleNonStreaming } from '@/lib/ai/json-pipeline';
import { runStreaming } from '@/lib/ai/stream-pipeline';
import type { PipelineInput } from '@/lib/ai/pipeline-input';
// POST handler — SSE streaming with step-by-step progress events
// POST 핸들러 — 단계별 진행 이벤트를 포함한 SSE 스트리밍
// ============================================================================
// 실제 사용 중인 모델을 UI에 알려준다 (config.bedrockModelId 반영) / tells the UI which model is actually in use
export async function GET() {
  return NextResponse.json({ model: getBedrockModelLabel() });
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID(); // health hook: all AgentCore calls of this request count once
  let reqBody;
  try {
    reqBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { messages, model: modelKey, stream: useStream, lang: clientLang, accountId: rawAccountId } = reqBody;

  // Account context / 계정 컨텍스트
  const accountId = rawAccountId && validateAccountId(rawAccountId) ? rawAccountId : undefined;
  const account = accountId ? getAccountById(accountId) : undefined;

  // i18n status messages / 다국어 상태 메시지 (ko/en/zh)
  const isEn = clientLang !== 'ko'; // collectors fall back to English for zh
  const STATUS = buildStatus(clientLang);

  const SYSTEM_PROMPT = getSystemPrompt(clientLang);

  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return NextResponse.json({ error: 'Messages required' }, { status: 400 });

  // Cognito 사용자 정보 추출 / Extract Cognito user from JWT
  const currentUser = getUserFromRequest(request);

  const input: PipelineInput = {
    messages, modelKey, lang: clientLang, accountId, accountAlias: account?.alias, requestId, user: currentUser,
  };

  // Non-streaming mode: return JSON (backward compatible for test scripts)
  // 비스트리밍 모드: JSON 반환 (테스트 스크립트 하위 호환)
  if (!useStream) {
    return handleNonStreaming(input);
  }

  // Streaming mode: SSE events / 스트리밍 모드: SSE 이벤트
  const readable = runStreaming({ ...input, account, status: STATUS, systemPrompt: SYSTEM_PROMPT, isEn });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
