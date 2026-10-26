// One route, JSON variant — the JSON pipeline's single route and every multi-route participant (both paths)
// 라우트 하나, JSON 변형 — JSON 단일 라우트와 (두 경로의) 멀티 라우트 참여자가 쓴다
// No events (emit is a no-op), InvokeModel (invokeText), today's JSON flag values.
// 이벤트 없음(emit 무동작), InvokeModel(invokeText), JSON 경로의 플래그 값 그대로.
import { resolveModelId, rawModelId } from '../models';
import { ROUTE_REGISTRY, type RouteType } from '../registry';
import { getSystemPrompt } from '../prompts';
import { buildStatus } from '../status';
import { invokeText } from '../bedrock';
import type { PipelineInput } from '../pipeline-input';
import type { StepCtx, StepResult } from './types';
import { codeStep } from './code';
import { topologyStep } from './topology';
import { sqlStep } from './sql';
import { datasourceStep } from './datasource';
import { autoCollectStep } from './auto-collect';
import { gatewayStep } from './gateway';

// null = this route produced nothing (single route → Bedrock fallback; multi-route → left out).
// null = 결과 없음 (단일 라우트는 Bedrock 폴백, 멀티 라우트는 제외).
export async function handleSingleRoute(route: RouteType, input: PipelineInput): Promise<StepResult | null> {
  const { messages, modelKey, lang, accountId, accountAlias, requestId } = input;
  const config = ROUTE_REGISTRY[route];
  const ctx: StepCtx = {
    route, messages, lang, accountId, accountAlias, requestId,
    systemPrompt: getSystemPrompt(lang), status: buildStatus(lang), emit: () => {}, llm: invokeText,
  };

  if (config.handler === 'code') {
    return codeStep(ctx, { variant: 'json', modelId: resolveModelId(modelKey) });
  }

  // SQL — on failure falls through to the gateway below / 실패하면 아래 gateway로
  if (config.handler === 'sql') {
    const r = await sqlStep(ctx, { modelId: resolveModelId(modelKey), emptyContent: '', withSqlTools: false });
    if (r) return r;
  }

  // Topology — no lang → Korean (`lang === 'en'`) / lang이 없으면 한국어
  if (config.handler === 'topology') {
    return topologyStep(ctx, { isEn: lang === 'en' });
  }

  // Datasource — rawModelId: no model fallback / 모델 폴백 없음
  if (config.handler === 'datasource') {
    return datasourceStep(ctx, { variant: 'json', modelId: rawModelId(modelKey), emptyContent: '' });
  }

  // Auto-collect — isEn always true, any error → null / isEn 항상 true, 오류면 null
  if (config.handler === 'auto-collect') {
    try {
      return await autoCollectStep(ctx, { isEn: true, modelId: rawModelId(modelKey) });
    } catch {
      return null;
    }
  }

  return gatewayStep(ctx);
}
