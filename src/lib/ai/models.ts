import { getBedrockModelId } from '@/lib/app-config';

// Available Bedrock models / 사용 가능한 Bedrock 모델
// Seoul region uses global.* prefix for cross-region inference / 서울 리전은 global.* 접두사 사용
// Opus 4.8 단일 모델 (레거시 키는 과거 요청 호환용) / single model; legacy keys kept for compatibility
// getter로 매 요청마다 config(bedrockModelId)를 반영 / getters pick up config.bedrockModelId per request
export const MODELS: Record<string, string> = {
  get 'opus-4.8'() { return getBedrockModelId(); },
  get 'sonnet-4.6'() { return getBedrockModelId(); },
  get 'opus-4.6'() { return getBedrockModelId(); },
};

// Stream path: unknown/missing key falls back to the default model / 스트림 경로: 키가 없으면 기본 모델로 폴백
export function resolveModelId(key?: string): string {
  return MODELS[key || 'opus-4.8'] || MODELS['opus-4.8'];
}

// JSON datasource/auto-collect path: no fallback (undefined for unknown keys) / 폴백 없음
export function rawModelId(key?: string): string | undefined {
  return MODELS[key || 'opus-4.8'];
}
