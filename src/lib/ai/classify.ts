// Intent classification / 의도 분류
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from './clients';
import { MODELS } from './models';
import { CLASSIFICATION_PROMPT } from './prompts';
import { VALID_ROUTES, type RouteType } from './registry';

// Pure parse of the classifier reply / 분류 응답 순수 파싱
export function parseClassification(text: string): RouteType[] {
  // Parse multi-route: {"routes": ["network", "cost"]} / 멀티 라우트 파싱
  const multiMatch = text.match(/\{[^}]*"routes"\s*:\s*\[([^\]]+)\][^}]*\}/);
  if (multiMatch) {
    const routes = multiMatch[1].match(/"([^"]+)"/g)?.map((s: string) => s.replace(/"/g, '')) || [];
    const valid = routes.filter((r: string) => VALID_ROUTES.includes(r as RouteType)).slice(0, 3) as RouteType[];
    if (valid.length > 0) {
      console.log(`[Intent] Classified as: ${valid.join(', ')}`);
      return valid;
    }
  }

  // Fallback: single route {"route": "xxx"} / 폴백: 단일 라우트
  const singleMatch = text.match(/\{[^}]*"route"\s*:\s*"([^"]+)"[^}]*\}/);
  if (singleMatch && VALID_ROUTES.includes(singleMatch[1] as RouteType)) {
    console.log(`[Intent] Classified as: ${singleMatch[1]}`);
    return [singleMatch[1] as RouteType];
  }

  console.warn(`[Intent] Could not parse: ${text}, fallback to general`);
  return ['general'];
}

export async function classifyIntent(messages: Array<{role: string; content: string}>): Promise<{ routes: RouteType[]; inputTokens: number; outputTokens: number }> {
  try {
    const recentMessages = messages.slice(-10);
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 100,
      system: CLASSIFICATION_PROMPT,
      messages: recentMessages.map(m => ({ role: m.role, content: m.content })),
    });

    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: MODELS['opus-4.8'],
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));

    const result = JSON.parse(new TextDecoder().decode(response.body));
    const text = result.content?.[0]?.text || '';
    const usage = { inputTokens: result.usage?.input_tokens || 0, outputTokens: result.usage?.output_tokens || 0 };

    return { routes: parseClassification(text), ...usage };
  } catch (err: any) {
    console.error(`[Intent] Failed: ${err.message}, fallback to general`);
    return { routes: ['general'], inputTokens: 0, outputTokens: 0 };
  }
}
