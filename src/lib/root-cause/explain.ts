// Cited AI explanation: ask Bedrock, then verify every citation against the bundle.
// 인용 검증 AI 설명 — Bedrock에 묻고 모든 인용을 근거 묶음과 대조한다.
import { invokeText } from '@/lib/ai/bedrock';
import { getBedrockModelId } from '@/lib/app-config';
import type { AiCause, AiResult } from './types';

export const ROOT_CAUSE_SYSTEM_PROMPT = [
  '당신은 AWS 장애 원인 분석 보조자입니다.',
  '아래 근거 묶음에 있는 내용만으로 답하세요. 묶음에 없는 사실은 추측하지 마세요.',
  '원인을 말할 때는 반드시 근거 묶음의 eventId를 글자 그대로 인용하세요.',
  '근거가 약하면 약하다고 분명히 말하고 confidence를 low로 두세요.',
  'AWS를 변경하는 명령은 절대 제안하지 마세요. 확인할 것(checks)은 읽기 전용 점검만 쓰세요.',
  '출력은 다음 JSON 객체 하나뿐입니다. 다른 글은 쓰지 마세요.',
  '{"summary":"한두 문장","causes":[{"eventId":"…","reason":"…","confidence":"high|medium|low"}],"checks":["확인할 것"]}',
].join('\n');

const CONF = new Set(['high', 'medium', 'low']);

export function parseAiAnswer(text: string, eventIds: string[]): AiResult {
  const failed: AiResult = { status: 'failed', droppedCitations: 0 };
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return failed;
  let o: any;
  try { o = JSON.parse(text.slice(a, b + 1)); } catch { return failed; }
  if (!o || typeof o !== 'object' || typeof o.summary !== 'string' || !o.summary.trim()) return failed;
  const known = new Set(eventIds);
  const causes: AiCause[] = [];
  let dropped = 0;
  for (const c of Array.isArray(o.causes) ? o.causes : []) {
    if (!c || typeof c.eventId !== 'string' || !known.has(c.eventId)) { dropped++; continue; }
    causes.push({ eventId: c.eventId, reason: typeof c.reason === 'string' ? c.reason : '', confidence: CONF.has(c.confidence) ? c.confidence : 'low' });
  }
  if (causes.length === 0) return { status: 'unverified', droppedCitations: dropped };
  const checks = (Array.isArray(o.checks) ? o.checks : []).filter((x: unknown): x is string => typeof x === 'string').slice(0, 5);
  return { status: 'ok', summary: o.summary, causes, checks, droppedCitations: dropped };
}

export async function explain(
  bundle: { text: string; eventIds: string[] },
  deps: { invoke?: typeof invokeText; record?: (r: { inputTokens: number; outputTokens: number; ms: number; ok: boolean }) => void } = {},
): Promise<AiResult> {
  if (bundle.eventIds.length === 0) return { status: 'skipped', droppedCitations: 0 };
  const invoke = deps.invoke ?? invokeText;
  const t0 = Date.now();
  try {
    const r = await invoke({ modelId: getBedrockModelId(), system: ROOT_CAUSE_SYSTEM_PROMPT, messages: [{ role: 'user', content: bundle.text }], maxTokens: 1200 });
    const out = parseAiAnswer(r.content, bundle.eventIds);
    deps.record?.({ inputTokens: r.inputTokens, outputTokens: r.outputTokens, ms: Date.now() - t0, ok: out.status !== 'failed' });
    return out;
  } catch (e) {
    console.error('[root-cause] explain failed:', e instanceof Error ? e.name : 'Error');
    deps.record?.({ inputTokens: 0, outputTokens: 0, ms: Date.now() - t0, ok: false });
    return { status: 'failed', droppedCitations: 0 };
  }
}
