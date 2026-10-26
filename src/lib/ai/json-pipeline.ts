// JSON (non-streaming) pipeline / JSON(비스트리밍) 파이프라인
// Handler bodies live in steps/ (handleSingleRoute = their JSON variant). This file keeps only the JSON
// fall-through: single route → Bedrock fallback; multi-route → 0 / 1 / many successes.
// 처리기 본문은 steps/에 있다. 여기에는 JSON 경로의 폴백 순서만 남긴다.
import { NextResponse } from 'next/server';
import { getBedrockModelLabel } from '@/lib/app-config';
import { resolveModelId } from './models';
import { getSystemPrompt, SYNTHESIS_PROMPT_SUFFIX } from './prompts';
import { invokeText } from './bedrock';
import { classifyIntent } from './classify';
import type { PipelineInput } from './pipeline-input';
import { recentMessages } from './steps/types';
import { handleSingleRoute } from './steps/single-route';

// ============================================================================
// Synthesize multi-route responses / 멀티 라우트 응답 합성
// Non-streaming version for handleNonStreaming / 비스트리밍용 (InvokeModel)
// ============================================================================
async function synthesizeResponses(
  question: string, responses: { route: string; content: string; via: string }[], modelKey?: string, lang?: string
): Promise<string> {
  const SYSTEM_PROMPT = getSystemPrompt(lang);
  const modelId = resolveModelId(modelKey);
  const parts = responses.map(r => `--- ${r.via} ---\n${r.content}`).join('\n\n');
  const result = await invokeText({
    modelId,
    system: SYSTEM_PROMPT + SYNTHESIS_PROMPT_SUFFIX,
    messages: [
      { role: 'user', content: `Question: ${question}\n\nMultiple agents responded:\n\n${parts}\n\nPlease synthesize into one comprehensive answer.` },
    ],
  });
  return result.content || responses.map(r => r.content).join('\n\n---\n\n');
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
      const fallbackResult = await invokeText({
        modelId: resolveModelId(modelKey), system: SYSTEM_PROMPT, messages: recentMessages(messages),
      });
      return NextResponse.json({
        content: fallbackResult.content || 'No response', model: getBedrockModelLabel(),
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
