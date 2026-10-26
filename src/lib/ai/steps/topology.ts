// Topology step — resolve the target VPC, answer with a Topology View deep link
// 토폴로지 단계 — 대상 VPC를 정하고 토폴로지뷰 딥링크로 답한다
import { ROUTE_REGISTRY } from '../registry';
import { generateTopologyParams, topologyContent } from '../topology';
import type { StepCtx, StepResult } from './types';

export interface TopologyStepOpts {
  // Caller's per-path rule (no lang → stream English, JSON Korean):
  // stream `lang !== 'ko'`, JSON `lang === 'en'` / 경로별 규칙 그대로
  isEn: boolean;
}

export async function topologyStep(ctx: StepCtx, opts: TopologyStepOpts): Promise<StepResult> {
  ctx.emit('status', { step: 'topology-resolving', message: ctx.status.topologyResolving });
  const { params, vpcs, error } = await generateTopologyParams(ctx.messages, ctx.accountId);
  return {
    content: topologyContent(params, vpcs, opts.isEn, error),
    via: ROUTE_REGISTRY[ctx.route].display,
    queriedResources: ['steampipe'],
    route: ctx.route,
  };
}
