# AI Route Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/app/api/ai/route.ts` (1,808 lines) into focused modules under `src/lib/ai/`, with streaming and JSON sharing one set of handler steps, and **zero behaviour change**.

**Architecture:**
1. Pin today's behaviour first with characterization tests. They call the real `POST`/`GET` exports with every external dependency mocked.
2. Move code outward in small steps that each keep those tests green: leaf modules, then services, then the two pipelines, then shared steps.
3. `route.ts` ends with only `GET` and `POST`.

**Tech Stack:** Next.js 14 App Router, TypeScript, vitest (`vi.mock`, fake timers), AWS SDK v3 (Bedrock runtime, Bedrock AgentCore).

**Spec:** `docs/superpowers/specs/2026-10-26-ai-route-refactor-design.md`. §3 lists every difference between the two paths that must survive. Implementers read it.

## Global Constraints

- **No behaviour change.** Never "fix" a stream/JSON difference listed in spec §3. That covers:
  - via strings: `'Bedrock (code request)'` vs `'Bedrock (code)'`, `'Bedrock Direct (fallback)'`
  - the `isEn` rules
  - 100 vs 80 datasource rows
  - `'No response'` vs `''`
  - the `rawModelId` lookup with no fallback in JSON datasource/auto-collect
  - the fall-through order
  - `recordAndSave` only in streaming, and only on the listed paths
  - tokens only in the stream `done`
  - one shared `requestId` per request
- **Characterization tests are frozen.** Once Task 2 is complete, nobody edits `src/lib/ai/__tests__/characterization/*.test.ts`. An assertion that needs changing means behaviour changed. Report it as BLOCKED.
- `src/app/api/ai/route.ts` may export only `GET` and `POST`, plus Next segment config if it is already there. `npx next build` must pass after every task that touches route.ts.
- `registry.ts` must not import `prompts.ts`.
- Keep the collector import as `` import(`@/lib/collectors/${route}`) `` so webpack can bundle it.
- Clients (`bedrockClient`, `agentCoreClient`) are module singletons in `clients.ts`. Tests mock the SDK modules with `vi.hoisted`.
- Every new directory gets a `CLAUDE.md`: Korean section, then an English section, matching the existing module docs.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Verification commands:
  - `npx vitest run src/lib/ai` for the focused suite
  - `npx vitest run` for everything
  - `npx tsc --noEmit`
  - `npx next build`

## Review Focus

1. **A collector throws.** Streaming emits the `${route}-error` status and falls through to the gateway; JSON falls back to Bedrock. Pinned in Task 2 (`autoCollectErrorPaths`).
2. **AgentCore takes longer than 90 s.** Streaming sends the 15 s keepalive status, reports the timeout to health, then falls back to Bedrock. JSON falls back without status events. Pinned in Task 2 (`gatewayTimeoutAndKeepalive`, fake timers).
3. **Multi-route with 0, 1 or 2 successes.** The output on each path is exact, and every AgentCore call shares one `requestId`. Pinned in Task 2 (`multiRouteOutcomes`).
4. **The client disconnects mid-stream** (`controller.enqueue` throws). Today's semantics stay: no unhandled rejection, intervals cleared. Pinned in Task 2 (`streamWriteAfterCloseIsContained`).
5. **No `lang` in the request.** Streaming topology answers in English and JSON topology in Korean, exactly as today. Pinned in Task 2 (`topologyDefaultLanguagePerPath`).

---

## File Structure (end state)

```
src/app/api/ai/route.ts                     GET + POST only (validation, choose pipeline)
src/lib/ai/CLAUDE.md
src/lib/ai/models.ts | clients.ts | registry.ts | prompts.ts | status.ts | tools.ts | sse.ts | stats.ts
src/lib/ai/bedrock.ts | classify.ts | agentcore.ts | code-interpreter.ts | sql.ts | topology.ts | datasource-query.ts
src/lib/ai/steps/{types,code,topology,datasource,sql,auto-collect,gateway}.ts
src/lib/ai/stream-pipeline.ts | json-pipeline.ts
src/lib/ai/__tests__/characterization/{harness.ts, json.test.ts, stream-single.test.ts, stream-multi.test.ts, timers.test.ts}
src/lib/ai/__tests__/*.test.ts               unit tests for the extracted pure helpers
```

### Task 1: Characterization harness + JSON-path tests

**Files:** Create `src/lib/ai/__tests__/characterization/harness.ts` and `json.test.ts`.

**Interfaces — produces (used by Task 2):**
- `harness.ts` exports `setupAiMocks()`, which returns the mock handles: `bedrockSend`, `agentSend`, `runQuery`, `queryDatasource`, `recordCall`, `saveConversation`, `reportAgentcoreInvoke`, `getConfig`, and `collectorMock(route)`.
  - `bedrockSend` dispatches on `cmd.constructor.name` and on a system-prompt prefix: "intent classifier", "Steampipe SQL expert", "VPC topology". Tests set the reply per kind, for example `mocks.bedrock.classify(['sql'])`, `mocks.bedrock.text('…')`, `mocks.bedrock.stream(['a','b'], usage)`.
- `harness.ts` also exports:
  - `aiRequest(body): NextRequest-like`, built as `{ json: async () => body, headers: new Headers() }`.
  - `readSse(res): Promise<Array<[event: string, data: any]>>`.
  - `readJson(res)`.

**Mocks** use exact import names: `@aws-sdk/client-bedrock-runtime` (`BedrockRuntimeClient`, `InvokeModelCommand`, `InvokeModelWithResponseStreamCommand`, `ConverseStreamCommand`), `@aws-sdk/client-bedrock-agentcore` (`BedrockAgentCoreClient`, `InvokeAgentRuntimeCommand`, `StopRuntimeSessionCommand`, `StartCodeInterpreterSessionCommand`, `InvokeCodeInterpreterCommand`, `StopCodeInterpreterSessionCommand`), `@/lib/steampipe` (`runQuery`), `@/lib/app-config` (`getConfig`, `validateAccountId`, `getAccountById`, `getBedrockModelId`, `getBedrockModelLabel`, `getDefaultDatasource`), `@/lib/agentcore-stats` (`recordCall`), `@/lib/agentcore-memory` (`saveConversation`, which returns a Promise), `@/lib/auth-utils` (`getUserFromRequest`), `@/lib/health/monitor` (`reportAgentcoreInvoke`), `@/lib/datasource-client` (`queryDatasource`), and each `@/lib/collectors/<route>` used. Keep the real `datasource-registry` and `datasource-prompts`.

- [ ] Step 1: First, check whether `vi.mock('@/lib/collectors/eks-optimize')` intercepts the template-literal dynamic import in route.ts. If it doesn't, STOP and report NEEDS_CONTEXT. The controller will rule on adding a `loadCollector` seam as the only allowed production change in this task.
- [ ] Step 2: Write `json.test.ts`. Each case below gets one `it`. Assert exact values taken from the **current** code; read route.ts to get them.
  - `validationRejectsBadJsonAndEmptyMessages`: 400 in both cases. `getReturnsModelLabel`.
  - `classifyParsesMultiSingleInvalidAndFallsBackToGeneral`
  - `jsonCodeVia`: `'Bedrock (code)'`, with no `recordCall`.
  - `topologyDefaultLanguagePerPath` (JSON half): no lang gives Korean.
  - `jsonDatasourceUses80RowsNoUrlAndBedrockFallback`, plus "unknown modelKey gives modelId undefined".
  - `autoCollectErrorPaths` (JSON half): `collect` is called with `(fn, acct, true)`; on error, Bedrock fallback.
  - `jsonSqlUsedToolsEmpty`, plus "a failure goes to the AgentCore ops gateway".
  - `jsonGatewaySuccessAndFallback`: fallback via `'Bedrock Direct (fallback)'`, with no `usedTools`.
  - `multiRouteOutcomes` (JSON half): 2 successes give InvokeModel synthesis; 1 gives a direct answer; 0 gives `'All routes failed. Please try again.'`. All share one `requestId`.
  - `jsonThrowGives500`
- [ ] Step 3: Run `npx vitest run src/lib/ai`. Expected: everything PASSES against the unchanged route.ts. These are characterization tests, so a failure means the test is wrong. Fix the test, never the route.
- [ ] Step 4: Commit with `test(ai): characterization harness and JSON-path tests`.

### Task 2: Streaming-path characterization tests

**Files:** Create `src/lib/ai/__tests__/characterization/stream-single.test.ts`, `stream-multi.test.ts` and `timers.test.ts`.

**Interfaces — consumes:** `harness.ts` from Task 1 (`setupAiMocks`, `aiRequest`, `readSse`).

- [ ] Step 1: In `stream-single.test.ts`, assert the exact event sequence, as `[event, partial data]` pairs, plus the payload shapes.
  - `streamClassifiedPayloads`: single vs multi.
  - `streamCodeWithAndWithoutPython`: via `'Bedrock (code request)'`. Stop is called on success and on error. Multi with code first still runs only code.
  - `topologyDefaultLanguagePerPath` (stream half): no lang gives English. Also cover the VPC error, zero VPCs, and `&empty=1`.
  - `streamDatasource`:
    - The not-found, retrying and fallback statuses, hardcoded in Korean.
    - The Bedrock body carries 100 rows plus `ds.url`.
    - `recordCall.gateway` is `'datasource:prometheus'`.
    - With nothing returned, it goes to AgentCore `ops`.
    - Statuses arriving concurrently are checked as a subsequence.
  - `autoCollectErrorPaths` (stream half): collector statuses reach the SSE stream; max_tokens is 8192; on error, a `${route}-error` status, then the gateway.
  - `streamSql`:
    - Retry status order, including `sql` in the payload.
    - `usedTools` contains `steampipe: aws_ec2_instance`.
    - A non-SELECT query leads to `sql-fallback`, then the gateway.
  - `streamGateway`:
    - 50-character chunks.
    - `<tool_call>` stripped.
    - `skill` in the payload for `datasource-diag`.
    - `recordCall` with `success:true`; `reportAgentcoreInvoke(requestId,'success')`.
    - `ValidationException` is not reported.
  - `streamFallbackRecordsFailureWithoutRoutes`
  - `doneTokensIncludeClassification`
  - `saveConversationSlicesAndUserId`
  - `midStreamErrorSendsChunksThenError`
  - `streamWriteAfterCloseIsContained`: make `enqueue` throw once the client is gone. Assert no unhandled rejection and that the intervals are cleared.
- [ ] Step 2: In `stream-multi.test.ts`, cover `multiRouteOutcomes` (stream half):
  - 2 successes: ConverseStream synthesis.
  - 1 success: a direct answer.
  - 0 successes: Bedrock fallback, or an `error` event when the fallback throws.
  - Empty synthesis falls back to the joined contents.
  - One shared `requestId`.
  - `done.routes` present only where the current code emits it.
- [ ] Step 3: In `timers.test.ts`, cover `gatewayTimeoutAndKeepalive`. Use fake timers with `advanceTimersByTimeAsync`. Assert the keepalive status at 15 s, then at 90 s the timeout reported to health and the fallback.
- [ ] Step 4: Run `npx vitest run src/lib/ai`. Expected: everything PASSES against the unchanged route.ts.
- [ ] Step 5: Commit with `test(ai): streaming-path characterization tests`. **From here on the characterization tests are frozen.**

### Task 3: Extract leaf modules

**Files:** Create `src/lib/ai/{models,clients,registry,prompts,status,tools,sse,stats}.ts`, plus unit tests `src/lib/ai/__tests__/{tools,sse,status}.test.ts`. Modify `route.ts` to import them and delete the moved code.

**Interfaces — produces:**
- `models.ts`: `MODELS`, `resolveModelId(key?: string): string` (with fallback, as the stream path uses it), `rawModelId(key?: string): string | undefined` (no fallback, as JSON datasource/auto-collect use it).
- `clients.ts`: `bedrockClient`, `agentCoreClient`, `getAgentRuntimeArn()`, `getCodeInterpreterName()`.
- `registry.ts`: `ROUTE_REGISTRY`, `RouteConfig`, `RouteType`, `VALID_ROUTES`.
- `prompts.ts`: `CLASSIFICATION_PROMPT`, `buildClassificationPrompt`, `getSystemPrompt(lang)`, `SQL_GEN_PROMPT`, and the inline suffixes as named constants (`CODE_PROMPT_SUFFIX`, `SYNTHESIS_PROMPT_SUFFIX`, `TOPOLOGY_PROMPT`). The text must be byte-identical.
- `status.ts`: `buildStatus(lang)`, which returns the same `STATUS` object as route.ts lines 1052-1071, and `pick`.
- `tools.ts`: `KNOWN_TOOLS`, `TOOL_KEYWORD_MAP`, `extractUsedTools`.
- `sse.ts`: `sseEvent`, `simulateStreaming`, `streamBedrockToSSE`.
- `stats.ts`: `recordAndSave`.

- [ ] Step 1: Write the unit tests for `extractUsedTools`, `sseEvent`/`simulateStreaming` (50-character chunks) and `buildStatus` (ko/en/zh samples). They pin current output.
- [ ] Step 2: Move the code verbatim and import it in route.ts.
- [ ] Step 3: Run the focused suite, `tsc` and `next build`. Expected: all green, with the characterization tests unchanged.
- [ ] Step 4: Commit with `refactor(ai): extract leaf modules`.

### Task 4: Extract services

**Files:** Create `src/lib/ai/{bedrock,classify,agentcore,code-interpreter,sql,topology,datasource-query}.ts`, plus `__tests__/{classify,topology}.test.ts` for the pure parts (classify parsing; `topologyContent`). Modify `route.ts`.

**Interfaces — produces:**
- `bedrock.ts`: `invokeText(req): Promise<{content; inputTokens; outputTokens}>`, `streamText(req, onDelta): Promise<same>` (it wraps the `streamBedrockToSSE` semantics), `converseStream(req, onDelta)`.
- `classify.ts`: `classifyIntent(messages)`.
- `agentcore.ts`: `invokeAgentCore(...)` (the same signature and the same 90 s race), `AGENTCORE_TIMEOUT_MS = 90000`, `cleanAgentResponse`, and `streamToString`.
- `code-interpreter.ts`: `extractPythonCode`, `executeCodeInterpreter`.
- `sql.ts`: `generateSQL`, `queryAWS`.
- `topology.ts`: `TopologyParams`, `generateTopologyParams`, `topologyContent`.
- `datasource-query.ts`: `generateDatasourceQuery`.

- [ ] Step 1: Write the pure unit tests.
- [ ] Step 2: Move the code verbatim.
- [ ] Step 3: Run the focused suite, `tsc` and `next build`. Expected: green.
- [ ] Step 4: Commit with `refactor(ai): extract services`.

### Task 5: Extract the two pipelines

**Files:** Create `src/lib/ai/json-pipeline.ts`, which takes `handleSingleRoute`, `handleNonStreaming`, `synthesizeResponses` verbatim. Create `src/lib/ai/stream-pipeline.ts`, which takes the SSE body of `POST` (lines 1088-1500) verbatim as `runStreaming(input): ReadableStream`, plus `synthesizeResponsesStreaming`. Modify `route.ts` so `POST` keeps validation and the `STATUS` and user lookup, then returns `handleNonStreaming(...)` or `new Response(runStreaming(...), headers)`.

**Interfaces — produces:**
- `handleNonStreaming(input: PipelineInput): Promise<NextResponse>`
- `runStreaming(input: PipelineInput): ReadableStream`
- `type PipelineInput = { messages; modelKey?; lang?; accountId?; accountAlias?; requestId; user }`

- [ ] Step 1: Move the code verbatim, with no logic edits, and keep the SSE headers identical.
- [ ] Step 2: Run the focused suite, `tsc` and `next build`. Expected: green. route.ts is now under 150 lines.
- [ ] Step 3: Commit with `refactor(ai): move JSON and streaming pipelines out of route.ts`.

### Task 6: Shared steps — remove the duplication

**Files:** Create `src/lib/ai/steps/{types,code,topology,datasource,sql,auto-collect,gateway}.ts` and `__tests__/steps.*.test.ts` where useful. Modify `stream-pipeline.ts` and `json-pipeline.ts`.

**Interfaces — produces:**
- `steps/types.ts` defines:
  - `StepCtx = { messages; lang?; accountId?; accountAlias?; requestId; emit(event: string, data: unknown): void; llm: (req) => Promise<{content; inputTokens; outputTokens}> }`
  - `StepResult = { content; via; queriedResources; usedTools?; route; inputTokens?; outputTokens?; extra?: Record<string, unknown> }`
- Each step is `(ctx: StepCtx, opts) => Promise<StepResult | null>`. The `opts` carry only spec §3 differences as named flags:
  - `variant: 'stream' | 'json'` for datasource context formatting and the code via string
  - `isEn: boolean`, computed by the caller with today's per-path rule
  - `emptyContent: 'No response' | ''`
  - `modelId: string | undefined`, resolved by the caller
  - `withSqlTools: boolean`
- JSON passes `emit = () => {}` and `llm = invokeText`. Streaming passes the real emit, and its `llm` streams chunks via `streamText`.
- The pipelines keep their own fall-through order, keepalive, `recordAndSave` calls and token totals. Only handler bodies move into steps.

- [ ] Step 1: Move one handler at a time: code, then topology, sql, datasource, auto-collect, gateway. After each, run `npx vitest run src/lib/ai`, which must be green, and commit as `refactor(ai): shared <name> step`.
- [ ] Step 2: After the last handler, run the full `npx vitest run`, `tsc` and `next build`. Expected: green. The pipelines should have no duplicated handler bodies left.
- [ ] Step 3: Write `src/lib/ai/CLAUDE.md`, which explains the module map, the frozen characterization tests, and the spec §3 differences. In `src/app/CLAUDE.md`, change route.ts to "thin"; in root `CLAUDE.md`, add `src/lib/ai/` to Key Files and correct "11 routes" to the real registry count, labelled as routes in the registry.
- [ ] Step 4: Commit with `docs(ai): module docs after refactor`.

### Task 7 (controller): Final review, deploy, smoke test

- [ ] Run a whole-branch review on the most capable model. Its focus is any behaviour drift against spec §3, and whether the characterization test files are byte-identical since the Task 2 commit (`git diff <task2>..HEAD -- src/lib/ai/__tests__/characterization` must be empty).
- [ ] Merge to main and deploy.
- [ ] On the server, call `POST /api/ai` with `stream:false` and with `stream:true`, using an aws-data question and a general question. Ask the user to send one Slack question and open one question in the dashboard AI screen.
