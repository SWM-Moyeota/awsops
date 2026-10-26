// Datasource query generation / 데이터소스 쿼리 생성
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { DatasourceType } from '@/lib/app-config';
import { DATASOURCE_QUERY_PROMPTS } from '@/lib/datasource-prompts';
import { bedrockClient } from './clients';
import { MODELS } from './models';

export async function generateDatasourceQuery(
  messages: Array<{role: string; content: string}>,
  dsType: DatasourceType,
): Promise<string | null> {
  try {
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 300,
      system: DATASOURCE_QUERY_PROMPTS[dsType],
      messages: messages.slice(-6).map(m => ({ role: m.role, content: m.content })),
    });
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: MODELS['opus-4.8'],
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));
    const result = JSON.parse(new TextDecoder().decode(response.body));
    let query = (result.content?.[0]?.text || '').trim();
    query = query.replace(/^```(?:\w+)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    return query || null;
  } catch (err: any) {
    console.error(`[DS Query Gen] Failed for ${dsType}:`, err.message);
    return null;
  }
}
