import { recordCall } from '@/lib/agentcore-stats';
import { saveConversation } from '@/lib/agentcore-memory';

// ============================================================================
// Helper: 통계 기록 + 대화 저장을 한 번에 / Record stats + save conversation in one call
export function recordAndSave(p: {
  route: string; gateway: string; responseTimeMs: number; usedTools: string[];
  success: boolean; via: string; question: string; summary: string; userId: string;
  inputTokens?: number; outputTokens?: number; model?: string;
}): void {
  recordCall({ timestamp: new Date().toISOString(), route: p.route, gateway: p.gateway, responseTimeMs: p.responseTimeMs, usedTools: p.usedTools, success: p.success, via: p.via, inputTokens: p.inputTokens, outputTokens: p.outputTokens, model: p.model });
  saveConversation({ id: `${Date.now()}`, userId: p.userId, timestamp: new Date().toISOString(), route: p.route, gateway: p.gateway, question: p.question.slice(0, 100), summary: p.summary.slice(0, 200), usedTools: p.usedTools, responseTimeMs: p.responseTimeMs, via: p.via }).catch(() => {});
}
