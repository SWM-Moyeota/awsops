// SSE streaming pipeline — the ReadableStream body of POST
// SSE 스트리밍 파이프라인 — route.ts POST의 ReadableStream 본문
// Handler bodies live in steps/ (stream variant: real emit, streamText). This file keeps the stream-only parts:
// fall-through order, 15 s keepalives, recordAndSave, token totals in `done`, status timing, multi-route + fallbacks.
// 처리기 본문은 steps/에 있다. 여기에는 스트림 경로의 폴백 순서·keepalive·recordAndSave·토큰 합계만 남긴다.
import { ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { getBedrockModelLabel } from '@/lib/app-config';
import { resolveModelId } from './models';
import { bedrockClient } from './clients';
import { ROUTE_REGISTRY } from './registry';
import { getSystemPrompt, SYNTHESIS_PROMPT_SUFFIX } from './prompts';
import { extractUsedTools } from './tools';
import { sseEvent, simulateStreaming, streamBedrockToSSE } from './sse';
import { streamText } from './bedrock';
import { recordAndSave } from './stats';
import { classifyIntent } from './classify';
import type { StreamPipelineInput } from './pipeline-input';
import type { StepCtx, StepResult } from './steps/types';
import { codeStep } from './steps/code';
import { topologyStep } from './steps/topology';
import { sqlStep } from './steps/sql';
import { datasourceStep } from './steps/datasource';
import { autoCollectStep } from './steps/auto-collect';
import { gatewayStep } from './steps/gateway';
import { handleSingleRoute } from './steps/single-route';

// Former POST-scope closure variables arrive through `input` under their old names.
// 예전 POST 스코프의 클로저 변수는 `input`으로 받아 원래 이름 그대로 쓴다.
export function runStreaming(input: StreamPipelineInput): ReadableStream {
  const {
    messages, modelKey, lang: clientLang, accountId, accountAlias, requestId,
    user: currentUser, status: STATUS, systemPrompt: SYSTEM_PROMPT, isEn,
  } = input;

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
        // Stream variant of the shared steps: events go to the client, Bedrock answers stream as chunks.
        // 공유 단계의 스트림 변형: 이벤트는 클라이언트로, Bedrock 답은 chunk로 스트리밍
        const ctx: StepCtx = {
          route, messages, lang: clientLang, accountId, accountAlias, requestId,
          systemPrompt: SYSTEM_PROMPT, status: STATUS, emit: send, llm: req => streamText(req, send),
        };
        const addTokens = (r: StepResult) => {
          totalInputTokens += r.inputTokens ?? 0;
          totalOutputTokens += r.outputTokens ?? 0;
        };
        // done payload: key order and fields as before (undefined usedTools is dropped by JSON.stringify)
        // done 페이로드: 키 순서·필드 그대로 (usedTools가 undefined면 JSON.stringify가 뺀다)
        const sendDone = (r: StepResult, withRoutes = false) => send('done', {
          content: r.content, model: getBedrockModelLabel(),
          via: r.via, queriedResources: r.queriedResources, route,
          ...(withRoutes ? { routes } : {}),
          usedTools: r.usedTools,
          inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
        });

        // Handler: Code Interpreter / 핸들러: 코드 인터프리터
        // Runs even in multi-route when the first route is code / 멀티 라우트여도 첫 라우트가 code면 code만 실행
        if (config.handler === 'code') {
          const r = await codeStep(ctx, { variant: 'stream', modelId: resolveModelId(modelKey) });
          addTokens(r);
          sendDone(r);
          controller.close();
          return;
        }

        // Handler: Topology View — resolve VPC, reply with a deep link (single-route; multi-route delegates to handleSingleRoute)
        // 토폴로지뷰 핸들러 — 대상 VPC 결정 후 딥링크로 응답 (단일 라우트; 멀티 라우트는 handleSingleRoute로 위임)
        if (!isMulti && config.handler === 'topology') {
          sendDone(await topologyStep(ctx, { isEn }));
          controller.close();
          return;
        }

        // Handler: External Datasource (single-route only; multi-route delegates to handleSingleRoute)
        // 외부 데이터소스 핸들러 (단일 라우트 전용; 멀티 라우트는 handleSingleRoute로 위임) — 실패하면 gateway(ops)로
        if (!isMulti && config.handler === 'datasource') {
          const r = await datasourceStep(ctx, { variant: 'stream', modelId: resolveModelId(modelKey), emptyContent: 'No response' });
          if (r) {
            addTokens(r);
            const dsTimeMs = Date.now() - callStartTime;
            recordAndSave({ route, gateway: `datasource:${r.queriedResources.join('+')}`, responseTimeMs: dsTimeMs, usedTools: r.usedTools, success: true, via: r.extra.statsVia, question: lastMessage, summary: r.content, userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
            sendDone(r);
            controller.close();
            return;
          }
        }

        // Handler: Auto-collect (eks-optimize, db-optimize, msk-optimize, idle-scan, trace-analyze, incident)
        // 자동 데이터 수집 분석 핸들러 — 오류면 `${route}-error` 상태 후 아래로 계속 (gateway)
        if (config.handler === 'auto-collect') {
          try {
            const r = await autoCollectStep(ctx, { isEn, modelId: resolveModelId(modelKey) });
            addTokens(r);
            const timeMs = Date.now() - callStartTime;
            recordAndSave({ route, gateway: route, responseTimeMs: timeMs, usedTools: r.usedTools, success: true, via: r.via, question: lastMessage, summary: r.content || '', userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
            sendDone({ ...r, content: r.content || 'No response' });
            controller.close();
            return;
          } catch (err: any) {
            send('status', { step: `${route}-error`, message: `⚠️ ${route} collector error: ${err.message}` });
            // Fall through to general handler
          }
        }

        // Handler: SQL (aws-data) — on failure falls through to the gateway / SQL 핸들러 — 실패하면 gateway로
        if (config.handler === 'sql') {
          const r = await sqlStep(ctx, { modelId: resolveModelId(modelKey), emptyContent: 'No response', withSqlTools: true });
          if (r) {
            addTokens(r);
            const sqlTimeMs = Date.now() - callStartTime;
            recordAndSave({ route, gateway: 'steampipe', responseTimeMs: sqlTimeMs, usedTools: r.usedTools!, success: true, via: r.via, question: lastMessage, summary: r.content, userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
            sendDone(r);
            controller.close();
            return;
          }
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
            routes.map(r => handleSingleRoute(r, input))
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

        const r = await gatewayStep(ctx);
        clearInterval(keepaliveInterval);

        if (r) {
          const responseTimeMs = Date.now() - callStartTime;
          // Simulate streaming for AgentCore responses / AgentCore 응답 타이핑 시뮬레이션
          await simulateStreaming(r.content, send);
          recordAndSave({ route, gateway, responseTimeMs, usedTools: r.usedTools, success: true, via: r.via, question: lastMessage, summary: r.content, userId: currentUser.email, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, model: getBedrockModelLabel() });
          sendDone(r, true);
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

  return readable;
}

// ============================================================================
// Synthesize multi-route responses (streaming) / 멀티 라우트 응답 합성 (스트리밍)
// ============================================================================
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
