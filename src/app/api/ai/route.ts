// AI routing API: Tool-based route registry + Sonnet intent classification + conversation history
// AI 라우팅 API: 도구 기반 라우트 레지스트리 + Sonnet 의도 분류 + 대화 히스토리
// Flow: classify intent (from registry) → route to handler → fallback
// 흐름: 의도 분류 (레지스트리 기반) → 핸들러 라우팅 → 폴백
import { NextRequest, NextResponse } from 'next/server';
import { InvokeModelCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { runQuery } from '@/lib/steampipe';
import { validateAccountId, getAccountById, getBedrockModelLabel } from '@/lib/app-config';
import { getUserFromRequest } from '@/lib/auth-utils';
import { getDefaultDatasource } from '@/lib/app-config';
import type { DatasourceType } from '@/lib/app-config';
import { queryDatasource } from '@/lib/datasource-client';
import { detectDatasourceTypes, DATASOURCE_TYPES } from '@/lib/datasource-registry';
import { DATASOURCE_QUERY_PROMPTS } from '@/lib/datasource-prompts';
import { reportAgentcoreInvoke } from '@/lib/health/monitor';
import { randomUUID } from 'crypto';
import { MODELS, resolveModelId, rawModelId } from '@/lib/ai/models';
import { bedrockClient, agentCoreClient, getAgentRuntimeArn, getCodeInterpreterName } from '@/lib/ai/clients';
import { ROUTE_REGISTRY, VALID_ROUTES, type RouteType } from '@/lib/ai/registry';
import { CLASSIFICATION_PROMPT, getSystemPrompt, SQL_GEN_PROMPT, CODE_PROMPT_SUFFIX, SYNTHESIS_PROMPT_SUFFIX, TOPOLOGY_PROMPT } from '@/lib/ai/prompts';
import { buildStatus, pick } from '@/lib/ai/status';
import { extractUsedTools } from '@/lib/ai/tools';
import { sseEvent, simulateStreaming, streamBedrockToSSE } from '@/lib/ai/sse';
import { recordAndSave } from '@/lib/ai/stats';

// ============================================================================
// Intent classification / 의도 분류
// ============================================================================
async function classifyIntent(messages: Array<{role: string; content: string}>): Promise<{ routes: RouteType[]; inputTokens: number; outputTokens: number }> {
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

    // Parse multi-route: {"routes": ["network", "cost"]} / 멀티 라우트 파싱
    const multiMatch = text.match(/\{[^}]*"routes"\s*:\s*\[([^\]]+)\][^}]*\}/);
    if (multiMatch) {
      const routes = multiMatch[1].match(/"([^"]+)"/g)?.map((s: string) => s.replace(/"/g, '')) || [];
      const valid = routes.filter((r: string) => VALID_ROUTES.includes(r as RouteType)).slice(0, 3) as RouteType[];
      if (valid.length > 0) {
        console.log(`[Intent] Classified as: ${valid.join(', ')}`);
        return { routes: valid, ...usage };
      }
    }

    // Fallback: single route {"route": "xxx"} / 폴백: 단일 라우트
    const singleMatch = text.match(/\{[^}]*"route"\s*:\s*"([^"]+)"[^}]*\}/);
    if (singleMatch && VALID_ROUTES.includes(singleMatch[1] as RouteType)) {
      console.log(`[Intent] Classified as: ${singleMatch[1]}`);
      return { routes: [singleMatch[1] as RouteType], ...usage };
    }

    console.warn(`[Intent] Could not parse: ${text}, fallback to general`);
    return { routes: ['general'], ...usage };
  } catch (err: any) {
    console.error(`[Intent] Failed: ${err.message}, fallback to general`);
    return { routes: ['general'], inputTokens: 0, outputTokens: 0 };
  }
}

async function generateSQL(messages: Array<{role: string; content: string}>, accountId?: string, accountAlias?: string): Promise<string | null> {
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

async function queryAWS(sql: string, accountId?: string): Promise<{ data: string; rowCount: number; error?: string }> {
  try {
    const result = await runQuery(sql, { accountId });
    if (result.error) return { data: `Query error: ${result.error}`, rowCount: 0, error: result.error };
    if (result.rows.length === 0) return { data: 'No results found.', rowCount: 0 };
    return { data: JSON.stringify(result.rows, null, 2), rowCount: result.rows.length };
  } catch (e: any) {
    return { data: `Error: ${e.message}`, rowCount: 0, error: e.message };
  }
}

// Topology View handler: resolve target VPC from conversation + live VPC list
// 토폴로지뷰 핸들러: 대화 + 실시간 VPC 목록에서 대상 VPC 결정
interface TopologyParams {
  vpcId: string | null;
  vpcName: string | null;
  vpcCidr: string | null;
  includeEmpty: boolean;
}

async function generateTopologyParams(
  messages: Array<{role: string; content: string}>, accountId?: string
): Promise<{ params: TopologyParams | null; vpcs: Array<{vpc_id: string; name: string | null; cidr: string}>; error?: string }> {
  const vpcRes = await runQuery(
    `SELECT vpc_id, tags ->> 'Name' AS name, cidr_block AS cidr FROM aws_vpc ORDER BY name NULLS LAST`,
    { accountId }
  );
  if (vpcRes.error) return { params: null, vpcs: [], error: vpcRes.error };
  const vpcs = vpcRes.rows as Array<{vpc_id: string; name: string | null; cidr: string}>;
  if (vpcs.length === 0) return { params: null, vpcs: [], error: 'no VPCs found' };
  try {
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 200,
      system: TOPOLOGY_PROMPT(vpcs),
      messages: messages.slice(-6).map(m => ({ role: m.role, content: m.content })),
    });
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: MODELS['opus-4.8'],
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));
    const text = JSON.parse(new TextDecoder().decode(response.body)).content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    const row = vpcs.find(v => v.vpc_id === parsed.vpc_id);
    return {
      params: {
        vpcId: row?.vpc_id || null,
        vpcName: row?.name || row?.vpc_id || null,
        vpcCidr: row?.cidr || null,
        includeEmpty: Boolean(parsed.include_empty),
      },
      vpcs,
    };
  } catch (err: any) {
    console.error('[Topology] Param resolution failed:', err.message);
    return { params: null, vpcs };
  }
}

function topologyContent(
  params: TopologyParams | null,
  vpcs: Array<{vpc_id: string; name: string | null; cidr: string}>,
  isEn: boolean,
  error?: string
): string {
  if (error) {
    return isEn
      ? `Could not load the VPC list (${error}). Please open the Topology View tab directly: [/topology-view](/topology-view)`
      : `VPC 목록을 불러오지 못했습니다 (${error}). 토폴로지뷰 탭에서 직접 확인해주세요: [/topology-view](/topology-view)`;
  }
  if (params?.vpcId) {
    const link = `/topology-view?vpc=${params.vpcId}${params.includeEmpty ? '&empty=1' : ''}`;
    const title = `**${params.vpcName}** (${params.vpcCidr || ''})`;
    const emptyNote = params.includeEmpty
      ? (isEn ? ' Empty subnets are included.' : ' 빈 서브넷도 포함했습니다.')
      : '';
    return isEn
      ? `Prepared the AWSops topology for ${title}.${emptyNote}\n\n➡️ [Open Topology View](${link})`
      : `${title} AWSops 토폴로지를 준비했습니다.${emptyNote}\n\n➡️ [토폴로지뷰 열기](${link})`;
  }
  const rows = vpcs.map(v => `| ${v.name || '-'} | \`${v.vpc_id}\` | ${v.cidr} | [${isEn ? 'Open' : '열기'}](/topology-view?vpc=${v.vpc_id}) |`).join('\n');
  const header = isEn
    ? 'Multiple VPCs found — which one would you like to see?\n\n| Name | VPC ID | CIDR | Topology |\n|---|---|---|---|\n'
    : '여러 VPC가 있습니다 — 어느 VPC를 보시겠어요?\n\n| 이름 | VPC ID | CIDR | 토폴로지 |\n|---|---|---|---|\n';
  return header + rows;
}

async function generateDatasourceQuery(
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

// ============================================================================
// Code Interpreter / 코드 인터프리터
// ============================================================================
function extractPythonCode(text: string): string | null {
  const match = text.match(/```python\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

async function executeCodeInterpreter(code: string): Promise<{ output: string; exitCode: number }> {
  let sessionId: string | undefined;
  try {
    const startResp = await agentCoreClient.send(
      new StartCodeInterpreterSessionCommand({ codeInterpreterIdentifier: getCodeInterpreterName() })
    );
    sessionId = startResp.sessionId;
    if (!sessionId) throw new Error('No sessionId returned');

    const invokeResp = await agentCoreClient.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: getCodeInterpreterName(),
        sessionId,
        name: 'executeCode',
        arguments: { code, language: 'python' } as any,
      })
    );

    let output = '';
    let exitCode = 0;
    if (invokeResp.stream) {
      for await (const event of invokeResp.stream) {
        if (event.result) {
          const content = event.result.content;
          if (Array.isArray(content)) {
            for (const block of content) { if (block.text) output += block.text; }
          }
        }
        if ('error' in event) { output += `Error: ${JSON.stringify((event as any).error)}`; exitCode = 1; }
      }
    }

    await agentCoreClient.send(
      new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: getCodeInterpreterName(), sessionId })
    ).catch(() => {});
    return { output: output || '(no output)', exitCode };
  } catch (err: any) {
    if (sessionId) {
      await agentCoreClient.send(
        new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: getCodeInterpreterName(), sessionId })
      ).catch(() => {});
    }
    return { output: `Code execution failed: ${err.message}`, exitCode: 1 };
  }
}

// ============================================================================
// AgentCore Runtime / AgentCore 런타임
// ============================================================================
const AGENTCORE_TIMEOUT_MS = 90000; // 90초 — Gateway 도구 실행 시간 고려 / 90s for tool execution

async function invokeAgentCore(
  messages: Array<{role: string; content: string}>,
  gateway: string,
  accountId?: string,
  accountAlias?: string,
  skill?: string,
  requestId: string = randomUUID(),
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const recentMessages = messages.slice(-10);
    const payload: Record<string, any> = {
      messages: recentMessages,
      gateway,
      accountId: accountId || '',
      accountAlias: accountAlias || '',
    };
    if (skill) payload.skill = skill;
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: getAgentRuntimeArn(),
      qualifier: 'DEFAULT',
      payload: JSON.stringify(payload),
    });

    const timeoutPromise = new Promise<null>((resolve) =>
      timer = setTimeout(() => {
        console.warn(`[AgentCore] Timeout after ${AGENTCORE_TIMEOUT_MS}ms for gateway=${gateway}`);
        reportAgentcoreInvoke(requestId, 'timeout');
        resolve(null);
      }, AGENTCORE_TIMEOUT_MS)
    );

    const agentPromise = (async () => {
      const response = await agentCoreClient.send(command);
      const sessionId = response.runtimeSessionId;
      const body = await streamToString(response.response);
      const text = body.startsWith('"') ? JSON.parse(body) : body;
      if (sessionId) {
        try {
          await agentCoreClient.send(new StopRuntimeSessionCommand({
            agentRuntimeArn: getAgentRuntimeArn(), runtimeSessionId: sessionId, qualifier: 'DEFAULT',
          }));
        } catch {}
      }
      return text as string;
    })();

    const result = await Promise.race([agentPromise, timeoutPromise]);
    if (result) reportAgentcoreInvoke(requestId, 'success');
    return result;
  } catch (err: any) {
    console.error('[AgentCore Error]', err?.message || err);
    // ValidationException = bad client-side request (e.g. payload/session id), not an AgentCore outage:
    // log only, don't count it. / 클라이언트 측 요청 오류는 장애로 집계하지 않는다.
    if (err?.name !== 'ValidationException') {
      reportAgentcoreInvoke(requestId, 'error', `${err?.name || 'Error'}: ${err?.message || err}`);
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function streamToString(stream: any): Promise<string> {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  if (typeof stream.transformToString === 'function') return stream.transformToString();
  if (typeof stream.transformToByteArray === 'function') {
    const bytes = await stream.transformToByteArray();
    return new TextDecoder().decode(bytes);
  }
  if (typeof stream.read === 'function') return stream.read().toString('utf-8');
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    }
    return chunks.join('');
  }
  return String(stream);
}

// POST handler — SSE streaming with step-by-step progress events
// POST 핸들러 — 단계별 진행 이벤트를 포함한 SSE 스트리밍
// ============================================================================
// 실제 사용 중인 모델을 UI에 알려준다 (config.bedrockModelId 반영) / tells the UI which model is actually in use
export async function GET() {
  return NextResponse.json({ model: getBedrockModelLabel() });
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID(); // health hook: all AgentCore calls of this request count once
  let reqBody;
  try {
    reqBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { messages, model: modelKey, stream: useStream, lang: clientLang, accountId: rawAccountId } = reqBody;

  // Account context / 계정 컨텍스트
  const accountId = rawAccountId && validateAccountId(rawAccountId) ? rawAccountId : undefined;
  const account = accountId ? getAccountById(accountId) : undefined;

  // i18n status messages / 다국어 상태 메시지 (ko/en/zh)
  const isEn = clientLang !== 'ko'; // collectors fall back to English for zh
  const STATUS = buildStatus(clientLang);

  const SYSTEM_PROMPT = getSystemPrompt(clientLang);

  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return NextResponse.json({ error: 'Messages required' }, { status: 400 });

  // Cognito 사용자 정보 추출 / Extract Cognito user from JWT
  const currentUser = getUserFromRequest(request);

  // Non-streaming mode: return JSON (backward compatible for test scripts)
  // 비스트리밍 모드: JSON 반환 (테스트 스크립트 하위 호환)
  if (!useStream) {
    return handleNonStreaming(messages, modelKey, clientLang, accountId, account?.alias, requestId);
  }

  // Streaming mode: SSE events / 스트리밍 모드: SSE 이벤트
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };
      const callStartTime = Date.now();
      // Token accumulator / 토큰 누적기
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      try {
        // Step 1: Classify intent (multi-route) / 1단계: 의도 분류 (멀티 라우트)
        send('status', { step: 'classifying', message: STATUS.classifying });
        const classifyResult = await classifyIntent(messages);
        const routes = classifyResult.routes;
        totalInputTokens += classifyResult.inputTokens;
        totalOutputTokens += classifyResult.outputTokens;
        const route = routes[0];
        const config = ROUTE_REGISTRY[route];
        const lastMessage = messages[messages.length - 1]?.content || '';
        const isMulti = routes.length > 1;
        if (isMulti) {
          send('status', { step: 'classified', route, routes, message: STATUS.multiRoute(routes.map(r => ROUTE_REGISTRY[r]?.display).join(' + ')) });
        } else {
          send('status', { step: 'classified', route, display: config.display, message: STATUS.connecting(config.display) });
        }

        // Step 2: Route to handler / 2단계: 핸들러로 라우팅

        // Handler: Code Interpreter / 핸들러: 코드 인터프리터
        if (config.handler === 'code') {
          send('status', { step: 'generating', message: STATUS.codeGenerating });
          const modelId = resolveModelId(modelKey);
          const codeSystemPrompt = SYSTEM_PROMPT + CODE_PROMPT_SUFFIX;
          // Stream code generation / 코드 생성 스트리밍
          const codeStreamResult = await streamBedrockToSSE(
            { modelId, system: codeSystemPrompt, messages: messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content })) },
            send,
          );
          const aiText = codeStreamResult.content || '';
          totalInputTokens += codeStreamResult.inputTokens;
          totalOutputTokens += codeStreamResult.outputTokens;
          const pythonCode = extractPythonCode(aiText) || extractPythonCode(lastMessage);

          if (pythonCode) {
            send('status', { step: 'executing', message: STATUS.codeExecuting });
            const codeResult = await executeCodeInterpreter(pythonCode);
            const executionBlock = `\n\n---\n**Code Execution Result** (exit code: ${codeResult.exitCode}):\n\`\`\`\n${codeResult.output}\n\`\`\``;
            // Send execution result as chunk / 실행 결과를 chunk로 전송
            send('chunk', { delta: executionBlock });
            send('done', {
              content: aiText + executionBlock, model: getBedrockModelLabel(),
              via: `Bedrock + ${config.display}`, queriedResources: ['code-interpreter'], route,
              inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
            });
          } else {
            send('done', {
              content: aiText, model: getBedrockModelLabel(),
              via: 'Bedrock (code request)', queriedResources: [], route,
              inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
            });
          }
          controller.close();
          return;
        }

        // Handler: Topology View — resolve VPC, reply with a deep link (single-route; multi-route delegates to handleSingleRoute)
        // 토폴로지뷰 핸들러 — 대상 VPC 결정 후 딥링크로 응답 (단일 라우트; 멀티 라우트는 handleSingleRoute로 위임)
        if (!isMulti && config.handler === 'topology') {
          send('status', { step: 'topology-resolving', message: STATUS.topologyResolving });
          const { params, vpcs, error } = await generateTopologyParams(messages, accountId);
          const content = topologyContent(params, vpcs, isEn, error);
          send('done', {
            content, model: getBedrockModelLabel(),
            via: config.display, queriedResources: ['steampipe'], route,
            inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
          });
          controller.close();
          return;
        }

        // Handler: External Datasource (single-route only; multi-route delegates to handleSingleRoute)
        // 외부 데이터소스 핸들러 (단일 라우트 전용; 멀티 라우트는 handleSingleRoute로 위임)
        if (!isMulti && config.handler === 'datasource') {
          const dsTypes = detectDatasourceTypes(lastMessage);
          if (dsTypes.length === 0) {
            send('status', { step: 'datasource-no-type', message: '데이터소스 타입을 감지할 수 없습니다. 프로메테우스, 로키, 템포, 클릭하우스 중 하나를 지정해주세요.' });
            // Fall through to general handler
          } else {
            // Parallel query generation + execution for all detected types
            // 감지된 모든 타입에 대해 병렬 쿼리 생성 + 실행
            const dsResults = await Promise.allSettled(
              dsTypes.map(async (dsType) => {
                const ds = getDefaultDatasource(dsType);
                if (!ds) {
                  send('status', { step: 'datasource-not-found', message: `${DATASOURCE_TYPES[dsType].label} 데이터소스가 설정되지 않았습니다.` });
                  return null;
                }
                send('status', { step: 'datasource-generating', message: `${DATASOURCE_TYPES[dsType].label} ${DATASOURCE_TYPES[dsType].queryLanguage} 쿼리 생성 중...` });
                let dsQuery: string | null = await generateDatasourceQuery(messages, dsType);
                if (!dsQuery) return null;
                for (let attempt = 0; attempt < 2 && dsQuery; attempt++) {
                  send('status', { step: 'datasource-querying', message: `${ds.name}에 쿼리 실행 중${attempt > 0 ? ' (재시도)' : ''}...`, query: dsQuery });
                  try {
                    const result = await queryDatasource(ds, dsQuery, { start: '1h' });
                    return { dsType, ds, dsQuery, result };
                  } catch (err: any) {
                    if (attempt === 0) {
                      send('status', { step: 'datasource-retrying', message: `${DATASOURCE_TYPES[dsType].label} 쿼리 오류 수정 중...` });
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
              .filter((r): r is PromiseFulfilledResult<{ dsType: DatasourceType; ds: any; dsQuery: string; result: any }> =>
                r.status === 'fulfilled' && r.value != null)
              .map(r => r.value);

            if (successResults.length > 0) {
              const modelId = resolveModelId(modelKey);
              const isMultiDs = successResults.length > 1;
              send('status', { step: 'datasource-analyzing', message: isMultiDs
                ? `${successResults.length}개 데이터소스 상관 분석 중...`
                : `${successResults[0].result.metadata?.totalRows || successResults[0].result.rows.length}건 결과 분석 중...` });

              const combinedContext = successResults.map(s =>
                `\n\n--- LIVE ${DATASOURCE_TYPES[s.dsType].label.toUpperCase()} DATA (${s.result.rows.length} rows) ---\n` +
                `Datasource: ${s.ds.name} (${s.ds.url})\n${DATASOURCE_TYPES[s.dsType].queryLanguage}: ${s.dsQuery}\n` +
                `\`\`\`json\n${JSON.stringify(s.result.rows.slice(0, 100), null, 2)}\n\`\`\``
              ).join('\n');

              const bedrockMessages = messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content }));
              bedrockMessages[bedrockMessages.length - 1].content += combinedContext;

              const correlationHint = isMultiDs ? '\n\nIMPORTANT: The user asked about multiple datasources. Provide cross-source correlation analysis — identify patterns, correlations, and potential root causes across the different data sources.' : '';
              const streamResult = await streamBedrockToSSE(
                { modelId, system: SYSTEM_PROMPT + correlationHint, messages: bedrockMessages },
                send,
              );
              totalInputTokens += streamResult.inputTokens;
              totalOutputTokens += streamResult.outputTokens;
              const dsContent = streamResult.content || 'No response';
              const dsTools = successResults.map(s => `${s.dsType}: ${s.dsQuery}`);
              const viaStr = successResults.map(s => `${DATASOURCE_TYPES[s.dsType].label} (${s.result.rows.length} rows)`).join(' + ');
              const dsTimeMs = Date.now() - callStartTime;
              recordAndSave({ route, gateway: `datasource:${successResults.map(s => s.dsType).join('+')}`, responseTimeMs: dsTimeMs, usedTools: dsTools, success: true, via: viaStr, question: lastMessage, summary: dsContent, userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
              send('done', {
                content: dsContent, model: getBedrockModelLabel(),
                via: `Datasource Analytics: ${viaStr}`,
                queriedResources: successResults.map(s => s.dsType), route,
                usedTools: dsTools,
                inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
              });
              controller.close();
              return;
            }
            send('status', { step: 'datasource-fallback', message: '데이터소스 쿼리 실패. Bedrock으로 폴백합니다.' });
          }
        }

        // Handler: Auto-collect (eks-optimize, db-optimize, msk-optimize, idle-scan, trace-analyze, incident)
        // 자동 데이터 수집 분석 핸들러 — collector 파일을 route key로 동적 import
        if (config.handler === 'auto-collect') {
          try {
            const collectorModule = await import(`@/lib/collectors/${route}`);
            const collector = collectorModule.default as import('@/lib/collectors/types').Collector;

            const data = await collector.collect(send, accountId, isEn);
            const context = collector.formatContext(data);

            send('status', { step: `${route}-analyzing`, message: pick(clientLang,
              `🤖 Analyzing with ${collector.displayName}...`,
              `🤖 ${collector.displayName} 분석 중...`,
              `🤖 正在使用 ${collector.displayName} 分析...`) });

            const modelId = resolveModelId(modelKey);
            const bedrockMessages = messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content }));
            bedrockMessages[bedrockMessages.length - 1].content += context;

            const streamResult = await streamBedrockToSSE(
              { modelId, system: collector.analysisPrompt, messages: bedrockMessages, maxTokens: 8192 },
              send,
            );
            totalInputTokens += streamResult.inputTokens;
            totalOutputTokens += streamResult.outputTokens;

            const timeMs = Date.now() - callStartTime;
            recordAndSave({ route, gateway: route, responseTimeMs: timeMs, usedTools: data.usedTools, success: true, via: data.viaSummary, question: lastMessage, summary: streamResult.content || '', userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
            send('done', {
              content: streamResult.content || 'No response', model: getBedrockModelLabel(),
              via: data.viaSummary, queriedResources: data.queriedResources, route,
              usedTools: data.usedTools,
              inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
            });
            controller.close();
            return;
          } catch (err: any) {
            send('status', { step: `${route}-error`, message: `⚠️ ${route} collector error: ${err.message}` });
            // Fall through to general handler
          }
        }

        // Handler: SQL (aws-data) / SQL 핸들러
        if (config.handler === 'sql') {
          send('status', { step: 'sql-generating', message: STATUS.sqlGenerating });
          const modelId = resolveModelId(modelKey);
          let sql = await generateSQL(messages, accountId, account?.alias);
          let queryResult: { data: string; rowCount: number; error?: string } | null = null;

          for (let attempt = 0; attempt < 2 && sql; attempt++) {
            send('status', { step: 'sql-querying', message: STATUS.sqlQuerying(attempt > 0), sql });
            queryResult = await queryAWS(sql, accountId);
            if (!queryResult.error) break;
            if (attempt === 0) {
              send('status', { step: 'sql-retrying', message: STATUS.sqlRetrying });
              const fixMessages = [
                ...messages.slice(-4),
                { role: 'assistant' as const, content: `I generated this SQL: ${sql}` },
                { role: 'user' as const, content: `That SQL failed with error: ${queryResult.error}. Fix the SQL using only valid column names.` },
              ];
              sql = await generateSQL(fixMessages, accountId, account?.alias);
            }
          }

          if (sql && queryResult && !queryResult.error) {
            send('status', { step: 'analyzing', message: STATUS.analyzing(queryResult.rowCount) });
            const contextData = `\n\n--- LIVE AWS RESOURCE DATA (${queryResult.rowCount} rows) ---\nSQL: ${sql}\n\`\`\`json\n${queryResult.data}\n\`\`\``;
            const bedrockMessages = messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content }));
            bedrockMessages[bedrockMessages.length - 1].content += contextData;
            // Stream Bedrock analysis response / Bedrock 분석 응답 스트리밍
            const streamResult = await streamBedrockToSSE(
              { modelId, system: SYSTEM_PROMPT, messages: bedrockMessages },
              send,
            );
            totalInputTokens += streamResult.inputTokens;
            totalOutputTokens += streamResult.outputTokens;
            const sqlContent = streamResult.content || 'No response';
            const sqlTools = extractUsedTools(sqlContent);
            if (sql) sqlTools.push(`steampipe: ${sql.match(/FROM\s+(\w+)/i)?.[1] || 'query'}`);
            const sqlTimeMs = Date.now() - callStartTime;
            recordAndSave({ route, gateway: 'steampipe', responseTimeMs: sqlTimeMs, usedTools: sqlTools, success: true, via: `${config.display} (${queryResult.rowCount} rows)`, question: lastMessage, summary: sqlContent, userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
            send('done', {
              content: sqlContent, model: getBedrockModelLabel(),
              via: `${config.display} (${queryResult.rowCount} rows)`, queriedResources: ['steampipe'], route,
              usedTools: sqlTools,
              inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
            });
            controller.close();
            return;
          }
          send('status', { step: 'sql-fallback', message: STATUS.sqlFallback });
        }

        // Handler: AgentCore Gateway — single or multi / AgentCore 게이트웨이 — 단일 또는 멀티
        if (isMulti) {
          // Multi-route: parallel calls + synthesis / 멀티 라우트: 병렬 호출 + 합성
          send('status', { step: 'multi-call', message: STATUS.multiCall(routes.length) });

          // Keepalive for multi-route / 멀티 라우트 keepalive
          let multiKeepCount = 0;
          const multiKeepInterval = setInterval(() => {
            multiKeepCount++;
            send('status', { step: 'multi-call', message: STATUS.multiCallProgress(routes.length, multiKeepCount * 15) });
          }, 15000);

          const results = await Promise.allSettled(
            routes.map(r => handleSingleRoute(r, messages, modelKey, clientLang, accountId, account?.alias, requestId))
          );
          clearInterval(multiKeepInterval);
          const successful: { route: string; content: string; via: string }[] = [];
          const allResources: string[] = [];
          const allUsedTools: string[] = [];
          results.forEach((r, i) => {
            if (r.status === 'fulfilled' && r.value) {
              successful.push({ route: routes[i], content: r.value.content, via: r.value.via });
              allResources.push(...r.value.queriedResources);
              if (r.value.usedTools) allUsedTools.push(...r.value.usedTools);
            }
          });
          // 합성 응답에서도 도구 추출 / Also extract tools from synthesized content
          const dedupedTools = Array.from(new Set(allUsedTools));

          if (successful.length > 1) {
            send('status', { step: 'synthesizing', message: STATUS.synthesizing(successful.length) });
            const lastMsg = messages[messages.length - 1]?.content || '';
            // Real streaming synthesis via Converse API / Converse API 실시간 스트리밍 합성
            const synthesized = await synthesizeResponsesStreaming(lastMsg, successful, send, modelKey, clientLang);
            // 합성된 응답에서도 추가 도구 추출 / Extract additional tools from synthesized response
            const synthesizedTools = extractUsedTools(synthesized);
            const finalTools = Array.from(new Set([...dedupedTools, ...synthesizedTools]));
            const viaList = successful.map(s => s.via).join(' + ');
            const multiTimeMs = Date.now() - callStartTime;
            recordAndSave({ route, gateway: `multi:${routes.join('+')}`, responseTimeMs: multiTimeMs, usedTools: finalTools, success: true, via: `Multi-Route: ${viaList}`, question: lastMsg, summary: synthesized, userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
            send('done', {
              content: synthesized, model: getBedrockModelLabel(),
              via: `Multi-Route: ${viaList}`, queriedResources: allResources, route, routes,
              usedTools: finalTools,
              inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
            });
          } else if (successful.length === 1) {
            await simulateStreaming(successful[0].content, send);
            send('done', {
              content: successful[0].content, model: getBedrockModelLabel(),
              via: successful[0].via, queriedResources: allResources, route, routes,
              usedTools: dedupedTools,
              inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
            });
          } else {
            // 모든 Gateway 실패 → Bedrock Direct 스트리밍 폴백 / All gateways failed → Bedrock Direct streaming fallback
            send('status', { step: 'fallback', message: STATUS.gatewayTimeout });
            const modelId = resolveModelId(modelKey);
            try {
              const mfStreamResult = await streamBedrockToSSE(
                { modelId, system: SYSTEM_PROMPT, messages: messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content })) },
                send,
              );
              totalInputTokens += mfStreamResult.inputTokens;
              totalOutputTokens += mfStreamResult.outputTokens;
              const mfContent = mfStreamResult.content || 'No response';
              const mfTools = extractUsedTools(mfContent);
              send('done', {
                content: mfContent, model: getBedrockModelLabel(),
                via: `Bedrock Direct (multi-route fallback: ${routes.join('+')} timed out)`, queriedResources: [], route, routes,
                usedTools: mfTools,
                inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
              });
            } catch {
              send('error', { error: 'All routes and fallback failed' });
            }
          }
          controller.close();
          return;
        }

        // Single route: existing logic / 단일 라우트: 기존 로직
        const gateway = config.gateway || 'ops';
        send('status', { step: 'agentcore', message: STATUS.agentcoreCall(config.display) });

        // Keepalive: send periodic status during AgentCore call to prevent CloudFront timeout
        // Keepalive: AgentCore 호출 중 주기적 상태 전송으로 CloudFront 타임아웃 방지
        let keepaliveCount = 0;
        const keepaliveInterval = setInterval(() => {
          keepaliveCount++;
          send('status', { step: 'agentcore', message: STATUS.agentcoreProgress(config.display, keepaliveCount * 15) });
        }, 15000);

        const agentResponse = await invokeAgentCore(messages, gateway, accountId, account?.alias, config.skill, requestId);
        clearInterval(keepaliveInterval);

        if (agentResponse) {
          const usedTools = extractUsedTools(agentResponse);
          const cleanedResponse = agentResponse
            .replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/g, '')
            .replace(/<tool_response>[\s\S]*?<\/tool_response>\s*/g, '')
            .trim();
          const responseTimeMs = Date.now() - callStartTime;
          const finalContent = cleanedResponse || agentResponse;
          // Simulate streaming for AgentCore responses / AgentCore 응답 타이핑 시뮬레이션
          await simulateStreaming(finalContent, send);
          recordAndSave({ route, gateway, responseTimeMs, usedTools, success: true, via: `AgentCore → ${config.display}`, question: lastMessage, summary: finalContent, userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
          send('done', {
            content: finalContent, model: getBedrockModelLabel(),
            via: `AgentCore → ${config.display}`, queriedResources: [`${gateway}-gateway`], route, routes,
            usedTools,
            inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
          });
          controller.close();
          return;
        }

        // Fallback: Bedrock Direct streaming / 폴백: Bedrock 직접 스트리밍
        send('status', { step: 'fallback', message: STATUS.fallback });
        const modelId = resolveModelId(modelKey);
        const fbStreamResult = await streamBedrockToSSE(
          { modelId, system: SYSTEM_PROMPT, messages: messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content })) },
          send,
        );
        totalInputTokens += fbStreamResult.inputTokens;
        totalOutputTokens += fbStreamResult.outputTokens;
        const fallbackContent = fbStreamResult.content || 'No response';
        const fallbackTools = extractUsedTools(fallbackContent);
        const fbTimeMs = Date.now() - callStartTime;
        recordAndSave({ route, gateway: 'bedrock-fallback', responseTimeMs: fbTimeMs, usedTools: fallbackTools, success: false, via: `Bedrock Direct (fallback)`, question: lastMessage, summary: fallbackContent, userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
        send('done', {
          content: fallbackContent, model: getBedrockModelLabel(),
          via: `Bedrock Direct (fallback from ${config.display})`, queriedResources: [], route,
          usedTools: fallbackTools,
          inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
        });
      } catch (err: any) {
        send('error', { error: err.message || 'AI request failed' });
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ============================================================================
// Single route handler / 단일 라우트 핸들러
// ============================================================================
async function handleSingleRoute(
  route: RouteType, messages: Array<{role: string; content: string}>, modelKey?: string, lang?: string,
  accountId?: string, accountAlias?: string, requestId?: string
): Promise<{ content: string; via: string; queriedResources: string[]; usedTools?: string[] } | null> {
  const SYSTEM_PROMPT = getSystemPrompt(lang);
  const config = ROUTE_REGISTRY[route];
  const lastMessage = messages[messages.length - 1]?.content || '';

  // Code handler / 코드 핸들러
  if (config.handler === 'code') {
    const modelId = resolveModelId(modelKey);
    const codeSystemPrompt = SYSTEM_PROMPT + CODE_PROMPT_SUFFIX;
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: codeSystemPrompt,
      messages: messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content })),
    });
    const aiResponse = await bedrockClient.send(new InvokeModelCommand({
      modelId, contentType: 'application/json', accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));
    const aiText = JSON.parse(new TextDecoder().decode(aiResponse.body)).content?.[0]?.text || '';
    const pythonCode = extractPythonCode(aiText) || extractPythonCode(lastMessage);
    if (pythonCode) {
      const codeResult = await executeCodeInterpreter(pythonCode);
      const executionBlock = `\n\n---\n**Code Execution Result** (exit code: ${codeResult.exitCode}):\n\`\`\`\n${codeResult.output}\n\`\`\``;
      return { content: aiText + executionBlock, via: `Bedrock + ${config.display}`, queriedResources: ['code-interpreter'] };
    }
    return { content: aiText, via: 'Bedrock (code)', queriedResources: [] };
  }

  // SQL handler / SQL 핸들러
  if (config.handler === 'sql') {
    const modelId = resolveModelId(modelKey);
    let sql = await generateSQL(messages, accountId, accountAlias);
    let queryResult: { data: string; rowCount: number; error?: string } | null = null;
    for (let attempt = 0; attempt < 2 && sql; attempt++) {
      queryResult = await queryAWS(sql, accountId);
      if (!queryResult.error) break;
      if (attempt === 0) {
        const fixMessages = [...messages.slice(-4),
          { role: 'assistant' as const, content: `I generated this SQL: ${sql}` },
          { role: 'user' as const, content: `That SQL failed with error: ${queryResult.error}. Fix the SQL using only valid column names.` },
        ];
        sql = await generateSQL(fixMessages, accountId, accountAlias);
      }
    }
    if (sql && queryResult && !queryResult.error) {
      const contextData = `\n\n--- LIVE AWS RESOURCE DATA (${queryResult.rowCount} rows) ---\nSQL: ${sql}\n\`\`\`json\n${queryResult.data}\n\`\`\``;
      const bedrockMessages = messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content }));
      bedrockMessages[bedrockMessages.length - 1].content += contextData;
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: SYSTEM_PROMPT, messages: bedrockMessages,
      });
      const response = await bedrockClient.send(new InvokeModelCommand({
        modelId, contentType: 'application/json', accept: 'application/json',
        body: new TextEncoder().encode(body),
      }));
      const result = JSON.parse(new TextDecoder().decode(response.body));
      return { content: result.content?.[0]?.text || '', via: `${config.display} (${queryResult.rowCount} rows)`, queriedResources: ['steampipe'] };
    }
  }

  // Topology View handler (non-streaming, for multi-route participation)
  // 토폴로지뷰 핸들러 (비스트리밍, 멀티 라우트 참여용)
  if (config.handler === 'topology') {
    const isEn = lang === 'en';
    const { params, vpcs, error } = await generateTopologyParams(messages, accountId);
    return {
      content: topologyContent(params, vpcs, isEn, error),
      via: config.display,
      queriedResources: ['steampipe'],
    };
  }

  // Datasource handler (non-streaming, for multi-route participation)
  // 데이터소스 핸들러 (비스트리밍, 멀티 라우트 참여용)
  if (config.handler === 'datasource') {
    const dsTypes = detectDatasourceTypes(lastMessage);
    if (dsTypes.length === 0) return null;

    const dsResults = await Promise.allSettled(dsTypes.map(async (dsType) => {
      const ds = getDefaultDatasource(dsType);
      if (!ds) return null;
      let dsQuery: string | null = await generateDatasourceQuery(messages, dsType);
      if (!dsQuery) return null;
      for (let attempt = 0; attempt < 2 && dsQuery; attempt++) {
        try {
          const result = await queryDatasource(ds, dsQuery, { start: '1h' });
          return { dsType, ds, dsQuery, result };
        } catch (err: any) {
          if (attempt === 0) {
            const fixMsgs = [...messages.slice(-4),
              { role: 'assistant' as const, content: `I generated this ${DATASOURCE_TYPES[dsType].queryLanguage} query: ${dsQuery}` },
              { role: 'user' as const, content: `That query failed with error: ${err.message}. Fix the query.` }];
            dsQuery = await generateDatasourceQuery(fixMsgs, dsType);
          }
        }
      }
      return null;
    }));

    const successful = dsResults
      .filter((r): r is PromiseFulfilledResult<{ dsType: DatasourceType; ds: any; dsQuery: string; result: any }> =>
        r.status === 'fulfilled' && r.value != null)
      .map(r => r.value);
    if (successful.length === 0) return null;

    const contextData = successful.map(s =>
      `--- LIVE ${DATASOURCE_TYPES[s.dsType].label.toUpperCase()} DATA (${s.result.rows.length} rows) ---\n` +
      `Datasource: ${s.ds.name}\n${DATASOURCE_TYPES[s.dsType].queryLanguage}: ${s.dsQuery}\n` +
      `\`\`\`json\n${JSON.stringify(s.result.rows.slice(0, 80), null, 2)}\n\`\`\``
    ).join('\n\n');

    const bedrockMessages = messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content }));
    bedrockMessages[bedrockMessages.length - 1].content += '\n\n' + contextData;
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: SYSTEM_PROMPT, messages: bedrockMessages,
    });
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: rawModelId(modelKey), contentType: 'application/json', accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));
    const analysisText = JSON.parse(new TextDecoder().decode(response.body)).content?.[0]?.text || '';
    const viaStr = successful.map(s => `${DATASOURCE_TYPES[s.dsType].label} (${s.result.rows.length} rows)`).join(' + ');
    const tools = successful.map(s => `${s.dsType}: ${s.dsQuery}`);
    return { content: analysisText, via: `Datasource Analytics: ${viaStr}`, queriedResources: successful.map(s => s.dsType), usedTools: tools };
  }

  // Auto-collect handler (non-streaming, for multi-route participation)
  // 자동 수집 핸들러 (비스트리밍, 멀티 라우트 참여용)
  if (config.handler === 'auto-collect') {
    try {
      const collectorModule = await import(`@/lib/collectors/${route}`);
      const collector = collectorModule.default as import('@/lib/collectors/types').Collector;
      const noopSend = () => {};
      const data = await collector.collect(noopSend, accountId, true);
      const context = collector.formatContext(data);

      const bedrockMessages = messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content }));
      bedrockMessages[bedrockMessages.length - 1].content += context;
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31', max_tokens: 8192, system: collector.analysisPrompt, messages: bedrockMessages,
      });
      const response = await bedrockClient.send(new InvokeModelCommand({
        modelId: rawModelId(modelKey), contentType: 'application/json', accept: 'application/json',
        body: new TextEncoder().encode(body),
      }));
      const analysisText = JSON.parse(new TextDecoder().decode(response.body)).content?.[0]?.text || '';
      return { content: analysisText, via: data.viaSummary, queriedResources: data.queriedResources, usedTools: data.usedTools };
    } catch {
      return null;
    }
  }

  // AgentCore Gateway / AgentCore 게이트웨이
  const gateway = config.gateway || 'ops';
  const agentResponse = await invokeAgentCore(messages, gateway, accountId, accountAlias, config.skill, requestId);
  if (agentResponse) {
    const usedTools = extractUsedTools(agentResponse);
    const cleaned = agentResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/g, '').replace(/<tool_response>[\s\S]*?<\/tool_response>\s*/g, '').trim();
    return { content: cleaned || agentResponse, via: `AgentCore → ${config.display}`, queriedResources: [`${gateway}-gateway`], usedTools };
  }
  return null;
}

// ============================================================================
// Synthesize multi-route responses / 멀티 라우트 응답 합성
// Non-streaming version for handleNonStreaming / 비스트리밍용
// ============================================================================
async function synthesizeResponses(
  question: string, responses: { route: string; content: string; via: string }[], modelKey?: string, lang?: string
): Promise<string> {
  const SYSTEM_PROMPT = getSystemPrompt(lang);
  const modelId = resolveModelId(modelKey);
  const parts = responses.map(r => `--- ${r.via} ---\n${r.content}`).join('\n\n');
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    system: SYSTEM_PROMPT + SYNTHESIS_PROMPT_SUFFIX,
    messages: [
      { role: 'user', content: `Question: ${question}\n\nMultiple agents responded:\n\n${parts}\n\nPlease synthesize into one comprehensive answer.` },
    ],
  });
  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId, contentType: 'application/json', accept: 'application/json',
    body: new TextEncoder().encode(body),
  }));
  const result = JSON.parse(new TextDecoder().decode(response.body));
  return result.content?.[0]?.text || responses.map(r => r.content).join('\n\n---\n\n');
}

// Streaming version using Converse API / Converse API 스트리밍 합성
async function synthesizeResponsesStreaming(
  question: string, responses: { route: string; content: string; via: string }[],
  send: (event: string, data: any) => void, modelKey?: string, lang?: string,
): Promise<string> {
  const systemPrompt = getSystemPrompt(lang) + SYNTHESIS_PROMPT_SUFFIX;
  const modelId = resolveModelId(modelKey);
  const parts = responses.map(r => `--- ${r.via} ---\n${r.content}`).join('\n\n');

  const response = await bedrockClient.send(new ConverseStreamCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages: [
      { role: 'user', content: [{ text: `Question: ${question}\n\nMultiple agents responded:\n\n${parts}\n\nPlease synthesize into one comprehensive answer.` }] },
    ],
    inferenceConfig: { maxTokens: 4096 },
  }));

  let fullContent = '';
  if (response.stream) {
    for await (const event of response.stream) {
      if (event.contentBlockDelta?.delta?.text) {
        const text = event.contentBlockDelta.delta.text;
        fullContent += text;
        send('chunk', { delta: text });
      }
    }
  }
  return fullContent || responses.map(r => r.content).join('\n\n---\n\n');
}

// ============================================================================
// Non-streaming handler — supports multi-route / 비스트리밍 — 멀티 라우트 지원
// ============================================================================
async function handleNonStreaming(messages: Array<{role: string; content: string}>, modelKey?: string, lang?: string, accountId?: string, accountAlias?: string, requestId?: string) {
  const SYSTEM_PROMPT = getSystemPrompt(lang);
  try {
    const classifyResult = await classifyIntent(messages);
    const routes = classifyResult.routes;
    const primaryRoute = routes[0];
    const _primaryConfig = ROUTE_REGISTRY[primaryRoute];

    // Single route (most common) / 단일 라우트 (일반적)
    if (routes.length === 1) {
      const result = await handleSingleRoute(primaryRoute, messages, modelKey, lang, accountId, accountAlias, requestId);
      if (result) {
        return NextResponse.json({
          content: result.content, model: getBedrockModelLabel(),
          via: result.via, queriedResources: result.queriedResources,
          usedTools: result.usedTools || [], route: primaryRoute, routes,
        });
      }
      // Fallback / 폴백
      const modelId = resolveModelId(modelKey);
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31', max_tokens: 4096, system: SYSTEM_PROMPT,
        messages: messages.slice(-10).map((m: any) => ({ role: m.role, content: m.content })),
      });
      const response = await bedrockClient.send(new InvokeModelCommand({
        modelId, contentType: 'application/json', accept: 'application/json',
        body: new TextEncoder().encode(body),
      }));
      const fallbackResult = JSON.parse(new TextDecoder().decode(response.body));
      return NextResponse.json({
        content: fallbackResult.content?.[0]?.text || 'No response', model: getBedrockModelLabel(),
        via: `Bedrock Direct (fallback)`, queriedResources: [], route: primaryRoute, routes,
      });
    }

    // Multi-route: parallel execution + synthesis / 멀티 라우트: 병렬 실행 + 합성
    console.log(`[Multi-Route] ${routes.join(' + ')}`);
    const results = await Promise.allSettled(
      routes.map(r => handleSingleRoute(r, messages, modelKey, lang, accountId, accountAlias, requestId))
    );

    const successful: { route: string; content: string; via: string }[] = [];
    const allResources: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        successful.push({ route: routes[i], content: r.value.content, via: r.value.via });
        allResources.push(...r.value.queriedResources);
      }
    });

    if (successful.length === 0) {
      return NextResponse.json({
        content: 'All routes failed. Please try again.', model: getBedrockModelLabel(),
        via: 'Multi-route (all failed)', queriedResources: [], route: primaryRoute, routes,
      });
    }

    // Single success → return directly / 1개만 성공 → 직접 반환
    if (successful.length === 1) {
      return NextResponse.json({
        content: successful[0].content, model: getBedrockModelLabel(),
        via: successful[0].via, queriedResources: allResources, route: primaryRoute, routes,
      });
    }

    // Multiple successes → synthesize / 복수 성공 → 합성
    const lastMsg = messages[messages.length - 1]?.content || '';
    const synthesized = await synthesizeResponses(lastMsg, successful, modelKey, lang);
    const viaList = successful.map(s => s.via).join(' + ');

    return NextResponse.json({
      content: synthesized, model: getBedrockModelLabel(),
      via: `Multi-Route: ${viaList}`, queriedResources: allResources, route: primaryRoute, routes,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'AI request failed' }, { status: 500 });
  }
}
