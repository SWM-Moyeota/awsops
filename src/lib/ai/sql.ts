// SQL generation + Steampipe query / SQL 생성 + Steampipe 쿼리
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { runQuery } from '@/lib/steampipe';
import { bedrockClient } from './clients';
import { MODELS } from './models';
import { SQL_GEN_PROMPT } from './prompts';

export async function generateSQL(messages: Array<{role: string; content: string}>, accountId?: string, accountAlias?: string): Promise<string | null> {
  try {
    let systemPrompt = SQL_GEN_PROMPT;
    if (accountId) {
      systemPrompt += `\n\nNote: Query targets AWS account ${accountAlias || accountId}. The search_path is already set for this account, so use standard table names (no account prefix needed).`;
    }
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 500,
      system: systemPrompt,
      messages: messages.slice(-6).map(m => ({ role: m.role, content: m.content })),
    });
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: MODELS['opus-4.8'],
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));
    const result = JSON.parse(new TextDecoder().decode(response.body));
    let sql = (result.content?.[0]?.text || '').trim();
    sql = sql.replace(/^```(?:sql)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    if (!sql.toLowerCase().startsWith('select')) return null;
    return sql;
  } catch (err: any) {
    console.error('[SQL Gen] Failed:', err.message);
    return null;
  }
}

export async function queryAWS(sql: string, accountId?: string): Promise<{ data: string; rowCount: number; error?: string }> {
  try {
    const result = await runQuery(sql, { accountId });
    if (result.error) return { data: `Query error: ${result.error}`, rowCount: 0, error: result.error };
    if (result.rows.length === 0) return { data: 'No results found.', rowCount: 0 };
    return { data: JSON.stringify(result.rows, null, 2), rowCount: result.rows.length };
  } catch (e: any) {
    return { data: `Error: ${e.message}`, rowCount: 0, error: e.message };
  }
}
