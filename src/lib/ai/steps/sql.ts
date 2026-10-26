// SQL step (aws-data) — generate SQL, run it on Steampipe (one retry with the error), analyze with Bedrock
// SQL 단계 — SQL 생성 → Steampipe 실행(오류면 한 번 수정 재시도) → Bedrock 분석
import { ROUTE_REGISTRY } from '../registry';
import { extractUsedTools } from '../tools';
import { generateSQL, queryAWS } from '../sql';
import { recentMessages, type EmptyContent, type StepCtx, type StepResult } from './types';

export interface SqlStepOpts {
  modelId: string;            // resolveModelId(modelKey)
  emptyContent: EmptyContent; // stream 'No response', JSON ''
  withSqlTools: boolean;      // stream: usedTools = tools in the answer + `steampipe: <table>`; JSON: none
}

// null = no usable SQL result; the caller falls through to the gateway.
// null = SQL 결과 없음 — 호출한 쪽이 gateway로 넘어간다.
export async function sqlStep(ctx: StepCtx, opts: SqlStepOpts): Promise<StepResult | null> {
  const { messages, accountId, accountAlias, status: STATUS } = ctx;
  const config = ROUTE_REGISTRY[ctx.route];
  ctx.emit('status', { step: 'sql-generating', message: STATUS.sqlGenerating });
  let sql = await generateSQL(messages, accountId, accountAlias);
  let queryResult: { data: string; rowCount: number; error?: string } | null = null;

  for (let attempt = 0; attempt < 2 && sql; attempt++) {
    ctx.emit('status', { step: 'sql-querying', message: STATUS.sqlQuerying(attempt > 0), sql });
    queryResult = await queryAWS(sql, accountId);
    if (!queryResult.error) break;
    if (attempt === 0) {
      ctx.emit('status', { step: 'sql-retrying', message: STATUS.sqlRetrying });
      const fixMessages = [
        ...messages.slice(-4),
        { role: 'assistant' as const, content: `I generated this SQL: ${sql}` },
        { role: 'user' as const, content: `That SQL failed with error: ${queryResult.error}. Fix the SQL using only valid column names.` },
      ];
      sql = await generateSQL(fixMessages, accountId, accountAlias);
    }
  }

  if (sql && queryResult && !queryResult.error) {
    ctx.emit('status', { step: 'analyzing', message: STATUS.analyzing(queryResult.rowCount) });
    const contextData = `\n\n--- LIVE AWS RESOURCE DATA (${queryResult.rowCount} rows) ---\nSQL: ${sql}\n\`\`\`json\n${queryResult.data}\n\`\`\``;
    const bedrockMessages = recentMessages(messages);
    bedrockMessages[bedrockMessages.length - 1].content += contextData;
    const res = await ctx.llm({ modelId: opts.modelId, system: ctx.systemPrompt, messages: bedrockMessages });
    const content = res.content || opts.emptyContent;
    let usedTools: string[] | undefined;
    if (opts.withSqlTools) {
      usedTools = extractUsedTools(content);
      if (sql) usedTools.push(`steampipe: ${sql.match(/FROM\s+(\w+)/i)?.[1] || 'query'}`);
    }
    return {
      content, via: `${config.display} (${queryResult.rowCount} rows)`, queriedResources: ['steampipe'], usedTools,
      route: ctx.route, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
    };
  }
  ctx.emit('status', { step: 'sql-fallback', message: STATUS.sqlFallback });
  return null;
}
