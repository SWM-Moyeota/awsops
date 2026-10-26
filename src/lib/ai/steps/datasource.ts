// Datasource step — detect datasource types, query each in parallel (one retry), analyze with Bedrock
// 데이터소스 단계 — 타입 감지 → 타입별 병렬 쿼리(한 번 수정 재시도) → Bedrock 분석
import { getDefaultDatasource } from '@/lib/app-config';
import type { DatasourceType } from '@/lib/app-config';
import { queryDatasource } from '@/lib/datasource-client';
import { detectDatasourceTypes, DATASOURCE_TYPES } from '@/lib/datasource-registry';
import { generateDatasourceQuery } from '../datasource-query';
import { recentMessages, lastMessageOf, type EmptyContent, type StepCtx, type StepResult, type StepVariant } from './types';

export interface DatasourceStepOpts {
  // Context formatting: stream 100 rows + `ds.url`, each block prefixed '\n\n', joined '\n', plus the
  // cross-source correlation hint; JSON 80 rows, no URL, '\n\n' + blocks joined '\n\n', no hint.
  // 컨텍스트 형식: 스트림 100행 + URL + 상관 분석 힌트, JSON 80행·URL 없음.
  variant: StepVariant;
  modelId: string | undefined; // stream resolveModelId (fallback), JSON rawModelId (no fallback → may be undefined)
  emptyContent: EmptyContent;  // stream 'No response', JSON ''
}

type DsSuccess = { dsType: DatasourceType; ds: any; dsQuery: string; result: any };

// `extra.statsVia` = the bare via (without 'Datasource Analytics: ') that the stream records in stats.
export type DatasourceStepResult = StepResult & { usedTools: string[]; extra: { statsVia: string } };

// null = no type detected or every query failed; the caller decides where to go next.
// null = 타입 감지 실패 또는 모든 쿼리 실패 — 다음 행선지는 호출한 쪽이 정한다.
export async function datasourceStep(ctx: StepCtx, opts: DatasourceStepOpts): Promise<DatasourceStepResult | null> {
  const { messages } = ctx;
  const dsTypes = detectDatasourceTypes(lastMessageOf(messages));
  if (dsTypes.length === 0) {
    ctx.emit('status', { step: 'datasource-no-type', message: '데이터소스 타입을 감지할 수 없습니다. 프로메테우스, 로키, 템포, 클릭하우스 중 하나를 지정해주세요.' });
    return null;
  }

  // Parallel query generation + execution for all detected types
  // 감지된 모든 타입에 대해 병렬 쿼리 생성 + 실행
  const dsResults = await Promise.allSettled(
    dsTypes.map(async (dsType) => {
      const ds = getDefaultDatasource(dsType);
      if (!ds) {
        ctx.emit('status', { step: 'datasource-not-found', message: `${DATASOURCE_TYPES[dsType].label} 데이터소스가 설정되지 않았습니다.` });
        return null;
      }
      ctx.emit('status', { step: 'datasource-generating', message: `${DATASOURCE_TYPES[dsType].label} ${DATASOURCE_TYPES[dsType].queryLanguage} 쿼리 생성 중...` });
      let dsQuery: string | null = await generateDatasourceQuery(messages, dsType);
      if (!dsQuery) return null;
      for (let attempt = 0; attempt < 2 && dsQuery; attempt++) {
        ctx.emit('status', { step: 'datasource-querying', message: `${ds.name}에 쿼리 실행 중${attempt > 0 ? ' (재시도)' : ''}...`, query: dsQuery });
        try {
          const result = await queryDatasource(ds, dsQuery, { start: '1h' });
          return { dsType, ds, dsQuery, result };
        } catch (err: any) {
          if (attempt === 0) {
            ctx.emit('status', { step: 'datasource-retrying', message: `${DATASOURCE_TYPES[dsType].label} 쿼리 오류 수정 중...` });
            const fixMessages = [
              ...messages.slice(-4),
              { role: 'assistant' as const, content: `I generated this ${DATASOURCE_TYPES[dsType].queryLanguage} query: ${dsQuery}` },
              { role: 'user' as const, content: `That query failed with error: ${err.message}. Fix the query.` },
            ];
            dsQuery = await generateDatasourceQuery(fixMessages, dsType);
          }
        }
      }
      return null;
    })
  );

  const successResults = dsResults
    .filter((r): r is PromiseFulfilledResult<DsSuccess> => r.status === 'fulfilled' && r.value != null)
    .map(r => r.value);
  if (successResults.length === 0) {
    ctx.emit('status', { step: 'datasource-fallback', message: '데이터소스 쿼리 실패. Bedrock으로 폴백합니다.' });
    return null;
  }

  const isMultiDs = successResults.length > 1;
  ctx.emit('status', { step: 'datasource-analyzing', message: isMultiDs
    ? `${successResults.length}개 데이터소스 상관 분석 중...`
    : `${successResults[0].result.metadata?.totalRows || successResults[0].result.rows.length}건 결과 분석 중...` });

  const bedrockMessages = recentMessages(messages);
  let system = ctx.systemPrompt;
  if (opts.variant === 'stream') {
    bedrockMessages[bedrockMessages.length - 1].content += successResults.map(s =>
      `\n\n--- LIVE ${DATASOURCE_TYPES[s.dsType].label.toUpperCase()} DATA (${s.result.rows.length} rows) ---\n` +
      `Datasource: ${s.ds.name} (${s.ds.url})\n${DATASOURCE_TYPES[s.dsType].queryLanguage}: ${s.dsQuery}\n` +
      `\`\`\`json\n${JSON.stringify(s.result.rows.slice(0, 100), null, 2)}\n\`\`\``
    ).join('\n');
    if (isMultiDs) system += '\n\nIMPORTANT: The user asked about multiple datasources. Provide cross-source correlation analysis — identify patterns, correlations, and potential root causes across the different data sources.';
  } else {
    bedrockMessages[bedrockMessages.length - 1].content += '\n\n' + successResults.map(s =>
      `--- LIVE ${DATASOURCE_TYPES[s.dsType].label.toUpperCase()} DATA (${s.result.rows.length} rows) ---\n` +
      `Datasource: ${s.ds.name}\n${DATASOURCE_TYPES[s.dsType].queryLanguage}: ${s.dsQuery}\n` +
      `\`\`\`json\n${JSON.stringify(s.result.rows.slice(0, 80), null, 2)}\n\`\`\``
    ).join('\n\n');
  }

  const res = await ctx.llm({ modelId: opts.modelId, system, messages: bedrockMessages });
  const viaStr = successResults.map(s => `${DATASOURCE_TYPES[s.dsType].label} (${s.result.rows.length} rows)`).join(' + ');
  return {
    content: res.content || opts.emptyContent,
    via: `Datasource Analytics: ${viaStr}`,
    queriedResources: successResults.map(s => s.dsType),
    usedTools: successResults.map(s => `${s.dsType}: ${s.dsQuery}`),
    route: ctx.route, inputTokens: res.inputTokens, outputTokens: res.outputTokens,
    extra: { statsVia: viaStr },
  };
}
