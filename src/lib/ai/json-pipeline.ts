// JSON (non-streaming) pipeline — moved verbatim from route.ts
// JSON(비스트리밍) 파이프라인 — route.ts에서 그대로 옮김
import { NextResponse } from 'next/server';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getBedrockModelLabel } from '@/lib/app-config';
import { resolveModelId, rawModelId } from './models';
import { bedrockClient } from './clients';
import { ROUTE_REGISTRY, type RouteType } from './registry';
import { getSystemPrompt, SYNTHESIS_PROMPT_SUFFIX } from './prompts';
import { buildStatus } from './status';
import { invokeText } from './bedrock';
import { extractUsedTools } from './tools';
import { classifyIntent } from './classify';
import { invokeAgentCore } from './agentcore';
import type { PipelineInput } from './pipeline-input';
import type { StepCtx } from './steps/types';
import { codeStep } from './steps/code';
import { topologyStep } from './steps/topology';
import { sqlStep } from './steps/sql';
import { datasourceStep } from './steps/datasource';
import { autoCollectStep } from './steps/auto-collect';

// ============================================================================
// Single route handler / 단일 라우트 핸들러
// ============================================================================
// JSON variant of every step: no events (emit is a no-op), InvokeModel (invokeText).
// JSON 변형: 이벤트 없음(emit 무동작), InvokeModel(invokeText). 스트림 멀티 라우트 참여자도 이것을 쓴다.
export async function handleSingleRoute(
  route: RouteType, input: PipelineInput,
): Promise<{ content: string; via: string; queriedResources: string[]; usedTools?: string[] } | null> {
  const { messages, modelKey, lang, accountId, accountAlias, requestId } = input;
  const SYSTEM_PROMPT = getSystemPrompt(lang);
  const config = ROUTE_REGISTRY[route];
  const ctx: StepCtx = {
    route, messages, lang, accountId, accountAlias, requestId,
    systemPrompt: SYSTEM_PROMPT, status: buildStatus(lang), emit: () => {}, llm: invokeText,
  };

  // Code handler / 코드 핸들러
  if (config.handler === 'code') {
    return codeStep(ctx, { variant: 'json', modelId: resolveModelId(modelKey) });
  }

  // SQL handler — on failure falls through to the gateway below / SQL 핸들러 — 실패하면 아래 gateway로
  if (config.handler === 'sql') {
    const r = await sqlStep(ctx, { modelId: resolveModelId(modelKey), emptyContent: '', withSqlTools: false });
    if (r) return r;
  }

  // Topology View handler (non-streaming, for multi-route participation)
  // 토폴로지뷰 핸들러 (비스트리밍, 멀티 라우트 참여용)
  if (config.handler === 'topology') {
    return topologyStep(ctx, { isEn: lang === 'en' });
  }

  // Datasource handler (non-streaming, for multi-route participation)
  // 데이터소스 핸들러 (비스트리밍, 멀티 라우트 참여용) — 실패하면 null → 단일 라우트는 Bedrock 폴백
  if (config.handler === 'datasource') {
    return datasourceStep(ctx, { variant: 'json', modelId: rawModelId(modelKey), emptyContent: '' });
  }

  // Auto-collect handler (non-streaming, for multi-route participation) — any error → null
  // 자동 수집 핸들러 (비스트리밍, 멀티 라우트 참여용) — 오류면 null
  if (config.handler === 'auto-collect') {
    try {
      return await autoCollectStep(ctx, { isEn: true, modelId: rawModelId(modelKey) });
    } catch {
      return null;
    }
  }

  // AgentCore Gateway / AgentCore 게이트웨이
  const gateway = config.gateway || 'ops';
  const agentResponse = await invokeAgentCore(messages, gateway, accountId, accountAlias, config.skill, requestId);
  if (agentResponse) {
    const usedTools = extractUsedTools(agentResponse);
    const cleaned = agentResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/g, '').replace(/<tool_response>[\s\S]*?<\/tool_response>\s*/g, '').trim();
    return { content: cleaned || agentResponse, via: `AgentCore → ${config.display}`, queriedResources: [`${gateway}-gateway`], usedTools };
  }
  return null;
}

// ============================================================================
// Synthesize multi-route responses / 멀티 라우트 응답 합성
// Non-streaming version for handleNonStreaming / 비스트리밍용
// ============================================================================
async function synthesizeResponses(
  question: string, responses: { route: string; content: string; via: string }[], modelKey?: string, lang?: string
): Promise<string> {
  const SYSTEM_PROMPT = getSystemPrompt(lang);
  const modelId = resolveModelId(modelKey);
  const parts = responses.map(r => `--- ${r.via} ---\n${r.content}`).join('\n\n');
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    system: SYSTEM_PROMPT + SYNTHESIS_PROMPT_SUFFIX,
    messages: [
      { role: 'user', content: `Question: ${question}\n\nMultiple agents responded:\n\n${parts}\n\nPlease synthesize into one comprehensive answer.` },
    ],
  });
  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId, contentType: 'application/json', accept: 'application/json',
    body: new TextEncoder().encode(body),
  }));
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.content?.[0]?.text || responses.map(r => r.content).join('\n\n---\n\n');
}

// ============================================================================
// Non-streaming handler — supports multi-route / 비스트리밍 — 멀티 라우트 지원
// ============================================================================
export async function handleNonStreaming(input: PipelineInput) {
  const { messages, modelKey, lang } = input;
  const SYSTEM_PROMPT = getSystemPrompt(lang);
  try {
    const classifyResult = await classifyIntent(messages);
    const routes = classifyResult.routes;
    const primaryRoute = routes[0];
    const _primaryConfig = ROUTE_REGISTRY[primaryRoute];

    // Single route (most common) / 단일 라우트 (일반적)
    if (routes.length === 1) {
      const result = await handleSingleRoute(primaryRoute, input);
      if (result) {
        return NextResponse.json({
          content: result.content, model: getBedrockModelLabel(),
          via: result.via, queriedResources: result.queriedResources,
          usedTools: result.usedTools || [], route: primaryRoute, routes,
        });
      }
      // Fallback / 폴백
      const modelId = resolveModelId(modelKey);
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: SYSTEM_PROMPT,
        messages: messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content })),
      });
      const response = await bedrockClient.send(new InvokeModelCommand({
        modelId, contentType: 'application/json', accept: 'application/json',
        body: new TextEncoder().encode(body),
      }));
      const fallbackResult = JSON.parse(new TextDecoder().decode(response.body));
      return NextResponse.json({
        content: fallbackResult.content?.[0]?.text || 'No response', model: getBedrockModelLabel(),
        via: `Bedrock Direct (fallback)`, queriedResources: [], route: primaryRoute, routes,
      });
    }

    // Multi-route: parallel execution + synthesis / 멀티 라우트: 병렬 실행 + 합성
    console.log(`[Multi-Route] ${routes.join(' + ')}`);
    const results = await Promise.allSettled(
      routes.map(r => handleSingleRoute(r, input))
    );

    const successful: { route: string; content: string; via: string }[] = [];
    const allResources: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        successful.push({ route: routes[i], content: r.value.content, via: r.value.via });
        allResources.push(...r.value.queriedResources);
      }
    });

    if (successful.length === 0) {
      return NextResponse.json({
        content: 'All routes failed. Please try again.', model: getBedrockModelLabel(),
        via: 'Multi-route (all failed)', queriedResources: [], route: primaryRoute, routes,
      });
    }

    // Single success → return directly / 1개만 성공 → 직접 반환
    if (successful.length === 1) {
      return NextResponse.json({
        content: successful[0].content, model: getBedrockModelLabel(),
        via: successful[0].via, queriedResources: allResources, route: primaryRoute, routes,
      });
    }

    // Multiple successes → synthesize / 복수 성공 → 합성
    const lastMsg = messages[messages.length - 1]?.content || '';
    const synthesized = await synthesizeResponses(lastMsg, successful, modelKey, lang);
    const viaList = successful.map(s => s.via).join(' + ');

    return NextResponse.json({
      content: synthesized, model: getBedrockModelLabel(),
      via: `Multi-Route: ${viaList}`, queriedResources: allResources, route: primaryRoute, routes,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'AI request failed' }, { status: 500 });
  }
}
