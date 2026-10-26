// Auto-collect step (eks-optimize, db-optimize, msk-optimize, idle-scan, trace-analyze, incident)
// 자동 수집 단계 — collector 파일을 route key로 동적 import → 수집 → Bedrock 분석
import type { Collector } from '@/lib/collectors/types';
import { pick } from '../status';
import { recentMessages, type StepCtx, type StepResult } from './types';

export interface AutoCollectStepOpts {
  isEn: boolean;               // passed to collector.collect: stream `lang !== 'ko'`, JSON always true
  modelId: string | undefined; // stream resolveModelId (fallback), JSON rawModelId (no fallback)
}

export type AutoCollectStepResult = StepResult & { usedTools: string[] };

// Throws on any error — the caller owns the error path (stream: `${route}-error` status, then the gateway;
// JSON: null → Bedrock fallback). `content` is the raw analysis ('' when empty); the stream turns an empty
// answer into 'No response' in `done` only, while its stats summary keeps ''.
// 오류는 그대로 던진다 — 오류 처리는 호출한 쪽 몫. content는 원문 그대로('' 가능).
export async function autoCollectStep(ctx: StepCtx, opts: AutoCollectStepOpts): Promise<AutoCollectStepResult> {
  const route = ctx.route;
  const collectorModule = await import(`@/lib/collectors/${route}`);
  const collector = collectorModule.default as Collector;

  // Stream: collector progress goes to the client; JSON: emit is a no-op / JSON은 아무것도 안 하는 send
  const data = await collector.collect(ctx.emit, ctx.accountId, opts.isEn);
  const context = collector.formatContext(data);

  ctx.emit('status', { step: `${route}-analyzing`, message: pick(ctx.lang,
    `🤖 Analyzing with ${collector.displayName}...`,
    `🤖 ${collector.displayName} 분석 중...`,
    `🤖 正在使用 ${collector.displayName} 分析...`) });

  const bedrockMessages = recentMessages(ctx.messages);
  bedrockMessages[bedrockMessages.length - 1].content += context;
  const res = await ctx.llm({ modelId: opts.modelId, system: collector.analysisPrompt, messages: bedrockMessages, maxTokens: 8192 });
  return {
    content: res.content, via: data.viaSummary, queriedResources: data.queriedResources, usedTools: data.usedTools,
    route, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
  };
}
