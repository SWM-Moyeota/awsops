// Gateway step — call AgentCore with the route's gateway (+ skill), strip tool-call tags
// 게이트웨이 단계 — 라우트의 gateway(+skill)로 AgentCore 호출, tool-call 태그 제거
// The stream pipeline keeps its own 15 s keepalive, simulated streaming and recordAndSave around this call.
// 15초 keepalive, 흉내 스트리밍, recordAndSave는 스트림 파이프라인이 이 호출 바깥에서 그대로 한다.
import { ROUTE_REGISTRY } from '../registry';
import { extractUsedTools } from '../tools';
import { invokeAgentCore } from '../agentcore';
import type { StepCtx, StepResult } from './types';

export type GatewayStepResult = StepResult & { usedTools: string[] };

// null = AgentCore failed or timed out (90 s); the caller falls back to Bedrock.
// null = AgentCore 실패 또는 90초 타임아웃 — 호출한 쪽이 Bedrock으로 폴백한다.
export async function gatewayStep(ctx: StepCtx): Promise<GatewayStepResult | null> {
  const config = ROUTE_REGISTRY[ctx.route];
  const gateway = config.gateway || 'ops';
  const agentResponse = await invokeAgentCore(ctx.messages, gateway, ctx.accountId, ctx.accountAlias, config.skill, ctx.requestId);
  if (!agentResponse) return null;
  const usedTools = extractUsedTools(agentResponse);
  const cleaned = agentResponse
    .replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/g, '')
    .replace(/<tool_response>[\s\S]*?<\/tool_response>\s*/g, '')
    .trim();
  return {
    content: cleaned || agentResponse, via: `AgentCore → ${config.display}`,
    queriedResources: [`${gateway}-gateway`], usedTools, route: ctx.route,
  };
}
