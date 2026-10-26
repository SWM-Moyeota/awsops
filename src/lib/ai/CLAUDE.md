# AI 라우트 모듈 (`src/lib/ai/`)

## 역할
`/api/ai`의 본체. 원래 1,808줄이던 `src/app/api/ai/route.ts`를 동작 변경 없이 쪼갠 결과다(설계: `docs/superpowers/specs/2026-10-26-ai-route-refactor-design.md`). `route.ts`는 `GET`/`POST`만 export하는 얇은 파일이다. POST는 JSON 파싱(400), accountId 검증·계정 조회, `isEn`(`lang !== 'ko'`), `buildStatus`, `getSystemPrompt`, messages 검증(400), 사용자 조회, `requestId` 생성만 하고 `handleNonStreaming`(JSON) 또는 `runStreaming`(SSE)에 넘긴다.

## 모듈 지도
```
route.ts (GET/POST)
  ├─ json-pipeline.ts   handleNonStreaming — JSON 경로의 폴백 순서
  └─ stream-pipeline.ts runStreaming       — SSE 경로의 폴백 순서, keepalive, recordAndSave, 토큰
        └─ steps/       처리기 본문 (두 경로 공유): code, topology, sql, datasource, auto-collect, gateway
             └─ 서비스  bedrock, classify, agentcore, code-interpreter, sql, topology, datasource-query
                  └─ 잎 모듈  models, clients, registry, prompts, status, tools, sse, stats
```
`steps/single-route.ts`의 `handleSingleRoute`는 모든 단계의 JSON 변형이다. JSON 단일 라우트와, 두 경로의 멀티 라우트 참여자가 함께 쓴다.

## 파일
- `models.ts` — `MODELS`, `resolveModelId`(키가 없으면 기본 모델로 폴백), `rawModelId`(폴백 없음, JSON datasource/auto-collect 전용).
- `clients.ts` — `bedrockClient`, `agentCoreClient`(모듈 싱글턴), `getAgentRuntimeArn`, `getCodeInterpreterName`.
- `registry.ts` — `ROUTE_REGISTRY`(라우트 19개), `RouteConfig`, `RouteType`, `VALID_ROUTES`. `prompts.ts`를 import하지 않는다(순환 방지).
- `prompts.ts` — `CLASSIFICATION_PROMPT`, `getSystemPrompt`, `SQL_GEN_PROMPT`, `CODE_PROMPT_SUFFIX`, `SYNTHESIS_PROMPT_SUFFIX`, `TOPOLOGY_PROMPT`. 문구는 한 글자도 바꾸지 않는다.
- `status.ts` — `buildStatus(lang)`, `pick`.
- `tools.ts` — `KNOWN_TOOLS`, `TOOL_KEYWORD_MAP`, `extractUsedTools`.
- `sse.ts` — `sseEvent`, `simulateStreaming`(50자 청크), `streamBedrockToSSE`.
- `stats.ts` — `recordAndSave`.
- `bedrock.ts` — `invokeText`(InvokeModel, JSON 경로), `streamText`(= `streamBedrockToSSE`, 스트림 경로). 둘 다 `{content, inputTokens, outputTokens}`를 돌려준다. 요청 본문은 대체한 인라인 호출과 바이트 단위로 같다(`__tests__/bedrock.test.ts`).
- `classify.ts` — `parseClassification`(순수 파싱), `classifyIntent`.
- `sql.ts` — `generateSQL`, `queryAWS`.
- `topology.ts` — `TopologyParams`, `generateTopologyParams`, `topologyContent`.
- `datasource-query.ts` — `generateDatasourceQuery`.
- `code-interpreter.ts` — `extractPythonCode`, `executeCodeInterpreter`.
- `agentcore.ts` — `AGENTCORE_TIMEOUT_MS`(90초), `invokeAgentCore`(90초 race, 요청당 하나의 `requestId`), `streamToString`.
- `pipeline-input.ts` — `PipelineInput`(`messages`, `modelKey?`, `lang?`, `accountId?`, `accountAlias?`, `requestId`, `user`), `StreamPipelineInput`(+ `status`, `systemPrompt`, `isEn`). 계정 별칭은 `accountAlias` 하나로만 전달한다.
- `steps/` — 처리기 본문. 계약과 플래그는 아래 "단계 계약" 참고, 파일별 설명은 `steps/CLAUDE.md`.
- `json-pipeline.ts` — `handleNonStreaming(input)`: 분류 → 단일 라우트(`handleSingleRoute`, 없으면 Bedrock 폴백) 또는 멀티 라우트(0/1/여러 개 성공), `synthesizeResponses`(InvokeModel).
- `stream-pipeline.ts` — `runStreaming(input): ReadableStream`: 상태 이벤트, 단계 호출 순서와 넘어가는 순서, 15초 keepalive, `recordAndSave`, 토큰 합계, 오류 처리, 멀티 라우트, `synthesizeResponsesStreaming`(ConverseStream). SSE 응답 헤더는 route.ts에 있다.

## 단계 계약 (`steps/types.ts`)
- 모양: `(ctx: StepCtx, opts) => Promise<StepResult | null>`. `null`이면 "이 단계는 답을 못 냈다"는 뜻이고, 다음 행선지는 호출한 파이프라인이 정한다. auto-collect만 예외로, null 대신 오류를 던지고 try/catch는 각 파이프라인이 갖는다.
- `StepCtx` = `{ route, messages, lang?, accountId?, accountAlias?, requestId, systemPrompt, status, emit, llm }`.
  - JSON(`handleSingleRoute`): `emit = () => {}`, `llm = invokeText`.
  - 스트림: `emit = send`, `llm = req => streamText(req, send)`(답이 chunk로 흘러간다).
- `StepResult` = `{ content, via, queriedResources, usedTools?, route, inputTokens?, outputTokens?, extra? }`. datasource는 통계용 via를 `extra.statsVia`에 담는다.
- `opts`에는 spec §3의 경로 차이만 들어간다. 호출하는 쪽이 리팩터링 전 값을 그대로 넘긴다.
  - `variant: 'stream' | 'json'` — code의 via 문구, datasource 컨텍스트 형식
  - `isEn` — topology, auto-collect
  - `emptyContent: 'No response' | ''` — sql, datasource
  - `modelId` — 호출한 쪽이 `resolveModelId` 또는 `rawModelId`로 미리 정한다
  - `withSqlTools` — sql
- 단계 안에서 하지 않는 일: `recordAndSave`, 토큰 누적, `done` 전송, keepalive, 넘어가는 순서. 모두 파이프라인 몫이다.

## 동결된 특성 테스트
- `__tests__/characterization/*.test.ts`(+ `harness.ts`)는 리팩터링 전 동작을 `@/app/api/ai/route`의 `POST`/`GET`으로 고정한다. SSE 이벤트 순서·payload, JSON 필드, `recordCall` 인자, 폴백 조건, 토큰 합계, 15초 keepalive와 90초 타임아웃을 확인한다.
- **수정 금지.** 실패하면 동작이 바뀐 것이니 코드를 고친다. 동결 시점은 `2396925`이다. `git diff 2396925..HEAD -- src/lib/ai/__tests__/characterization`의 출력은 항상 비어 있어야 한다.
- 확인 명령: `npx vitest run src/lib/ai`, `npx vitest run`, `npx tsc --noEmit`, `npx next build`.

## 보존하는 경로 차이 (spec §3, 고치지 않는다)
| 처리기 | 스트림 | JSON | 표현 위치 |
|---|---|---|---|
| code | via `'Bedrock (code request)'`. 멀티 라우트여도 첫 라우트가 code면 code만 실행 | via `'Bedrock (code)'` | `variant`. 멀티 조건은 stream-pipeline |
| topology | lang이 없으면 영어(`lang !== 'ko'`). 단일 라우트에서만 | lang이 없으면 한국어(`lang === 'en'`) | `isEn`. `!isMulti`는 stream-pipeline |
| datasource | 100행 + `ds.url`, 블록마다 `\n\n` 접두, `correlationHint`, 빈 답이면 `'No response'`, 실패하면 AgentCore `ops`로 | 80행, URL 없음, 실패하면 Bedrock 직접 호출, 모르는 modelKey면 `undefined` 모델 | `variant`, `emptyContent`, `modelId`. 실패 행선지는 각 파이프라인 |
| auto-collect | 실제 `send`·`isEn`, 오류면 `${route}-error` 상태 후 gateway로, `done`은 `'No response'`이고 통계 summary는 원문 | 아무것도 안 하는 send, `isEn=true`, 오류면 null → Bedrock 폴백, 모델 폴백 없음 | `ctx.emit`, `isEn`, `modelId`. try/catch와 `'No response'`는 각 파이프라인 |
| sql | `usedTools`에 `steampipe: <table>`, `'No response'` | `usedTools` 없음(→ `[]`) | `withSqlTools`, `emptyContent` |
| gateway | 15초 keepalive, 50자씩 흉내 스트리밍, 흉내 스트리밍 뒤에 `recordAndSave` | 바로 반환 | stream-pipeline(`gatewayStep` 바깥) |
| fallback | `success:false`, gateway `bedrock-fallback`, done에 routes 없음 | `'Bedrock Direct (fallback)'`, usedTools 없음 | 각 파이프라인 |
| multi | 성공 0이면 Bedrock 폴백 또는 error 이벤트, ConverseStream으로 합성 | `'All routes failed. Please try again.'`, InvokeModel로 합성 | 각 파이프라인. 참여자는 두 경로 모두 `handleSingleRoute`(JSON 변형) |

모든 처리기에 걸친 규칙
- `recordAndSave`는 스트림에서만 부른다. 부르는 곳은 datasource, auto-collect, sql, gateway, 단일 라우트 fallback, 멀티 라우트 합성(성공 2개 이상)이다.
- 토큰 수는 스트림 `done`에만 담고, 분류 단계 토큰을 포함한다.
- 요청 하나의 모든 AgentCore 호출은 같은 `requestId`를 쓴다(헬스 투표용).

## 규칙
- 특성 테스트는 동결이다(위 참고).
- 경로 차이는 의도된 것이다. "정리"하지 않는다. 새 차이가 생기면 opts 플래그로 표현하고 이 표에 추가한다.
- collector는 `` import(`@/lib/collectors/${route}`) `` 형태로 불러온다(webpack 번들링). 위치는 `steps/auto-collect.ts`이다.
- `route.ts`는 `GET`/`POST`만 export한다. 다른 것을 export하면 Next 빌드가 깨진다.

---

# AI Route Modules (`src/lib/ai/`)

## Role
The body of `/api/ai`. It is the behaviour-preserving split of what used to be the 1,808-line `src/app/api/ai/route.ts` (design: `docs/superpowers/specs/2026-10-26-ai-route-refactor-design.md`). `route.ts` is thin and exports only `GET`/`POST`. POST does the JSON parse (400), accountId validation and account lookup, `isEn` (`lang !== 'ko'`), `buildStatus`, `getSystemPrompt`, the messages check (400), the user lookup and the `requestId`. It then hands off to `handleNonStreaming` (JSON) or `runStreaming` (SSE).

## Module map
```
route.ts (GET/POST)
  ├─ json-pipeline.ts   handleNonStreaming — JSON fall-through order
  └─ stream-pipeline.ts runStreaming       — SSE fall-through order, keepalives, recordAndSave, tokens
        └─ steps/       handler bodies (shared by both paths): code, topology, sql, datasource, auto-collect, gateway
             └─ services  bedrock, classify, agentcore, code-interpreter, sql, topology, datasource-query
                  └─ leaf modules  models, clients, registry, prompts, status, tools, sse, stats
```
`handleSingleRoute` in `steps/single-route.ts` is the JSON variant of every step. The JSON single route uses it, and so do the multi-route participants on both paths.

## Files
- `models.ts` — `MODELS`, `resolveModelId` (falls back to the default model), `rawModelId` (no fallback; JSON datasource/auto-collect only).
- `clients.ts` — `bedrockClient`, `agentCoreClient` (module singletons), `getAgentRuntimeArn`, `getCodeInterpreterName`.
- `registry.ts` — `ROUTE_REGISTRY` (19 routes), `RouteConfig`, `RouteType`, `VALID_ROUTES`. Must not import `prompts.ts` (avoids a cycle).
- `prompts.ts` — `CLASSIFICATION_PROMPT`, `getSystemPrompt`, `SQL_GEN_PROMPT`, `CODE_PROMPT_SUFFIX`, `SYNTHESIS_PROMPT_SUFFIX`, `TOPOLOGY_PROMPT`. Text stays byte-identical.
- `status.ts` — `buildStatus(lang)`, `pick`.
- `tools.ts` — `KNOWN_TOOLS`, `TOOL_KEYWORD_MAP`, `extractUsedTools`.
- `sse.ts` — `sseEvent`, `simulateStreaming` (50-char chunks), `streamBedrockToSSE`.
- `stats.ts` — `recordAndSave`.
- `bedrock.ts` — `invokeText` (InvokeModel, JSON path) and `streamText` (= `streamBedrockToSSE`, stream path). Both return `{content, inputTokens, outputTokens}`. Their request bodies are byte-identical to the inline calls they replaced (`__tests__/bedrock.test.ts`).
- `classify.ts` — `parseClassification` (pure parsing), `classifyIntent`.
- `sql.ts` — `generateSQL`, `queryAWS`.
- `topology.ts` — `TopologyParams`, `generateTopologyParams`, `topologyContent`.
- `datasource-query.ts` — `generateDatasourceQuery`.
- `code-interpreter.ts` — `extractPythonCode`, `executeCodeInterpreter`.
- `agentcore.ts` — `AGENTCORE_TIMEOUT_MS` (90 s), `invokeAgentCore` (90 s race, one `requestId` per request), `streamToString`.
- `pipeline-input.ts` — `PipelineInput` (`messages`, `modelKey?`, `lang?`, `accountId?`, `accountAlias?`, `requestId`, `user`) and `StreamPipelineInput` (+ `status`, `systemPrompt`, `isEn`). The account alias travels only as `accountAlias`.
- `steps/` — the handler bodies. The contract and flags are under "Step contract" below; `steps/CLAUDE.md` describes each file.
- `json-pipeline.ts` — `handleNonStreaming(input)`: classify, then either a single route (`handleSingleRoute`, or the Bedrock fallback when it yields nothing) or multi-route (0 / 1 / many successes). Also `synthesizeResponses` (InvokeModel).
- `stream-pipeline.ts` — `runStreaming(input): ReadableStream`. It owns the status events, the order in which steps run and fall through, the 15 s keepalives, `recordAndSave`, the token totals, error handling, multi-route and `synthesizeResponsesStreaming` (ConverseStream). The SSE response headers stay in route.ts.

## Step contract (`steps/types.ts`)
- Shape: `(ctx: StepCtx, opts) => Promise<StepResult | null>`. `null` means the step produced no answer; the calling pipeline decides where to go next. The one exception is auto-collect: it throws instead of returning null, and each pipeline keeps its own try/catch.
- `StepCtx` = `{ route, messages, lang?, accountId?, accountAlias?, requestId, systemPrompt, status, emit, llm }`.
  - JSON (`handleSingleRoute`): `emit = () => {}`, `llm = invokeText`.
  - Stream: `emit = send`, `llm = req => streamText(req, send)` (the answer goes out as chunks).
- `StepResult` = `{ content, via, queriedResources, usedTools?, route, inputTokens?, outputTokens?, extra? }`. The datasource step puts the stats via in `extra.statsVia`.
- `opts` carries only the spec §3 differences. The caller passes the value each path used before the refactor.
  - `variant: 'stream' | 'json'` — the code via text and the datasource context format
  - `isEn` — topology, auto-collect
  - `emptyContent: 'No response' | ''` — sql, datasource
  - `modelId` — resolved by the caller with `resolveModelId` or `rawModelId`
  - `withSqlTools` — sql
- Steps never call `recordAndSave`, add up tokens, send `done`, run keepalives or decide the fall-through. The pipelines do all of that.

## Frozen characterization tests
- `__tests__/characterization/*.test.ts` (+ `harness.ts`) pin the pre-refactor behaviour through `POST`/`GET` of `@/app/api/ai/route`. They check SSE event order and payloads, JSON fields, `recordCall` arguments, fallback conditions, token totals, the 15 s keepalive and the 90 s timeout.
- **Never edit them.** If one fails, behaviour changed, so fix the code. The freeze point is `2396925`, and `git diff 2396925..HEAD -- src/lib/ai/__tests__/characterization` must always print nothing.
- Verify with `npx vitest run src/lib/ai`, `npx vitest run`, `npx tsc --noEmit`, `npx next build`.

## Path differences we keep (spec §3, do not fix)
| Handler | Stream | JSON | Where it lives |
|---|---|---|---|
| code | via `'Bedrock (code request)'`; in multi-route, a code first route runs code only | via `'Bedrock (code)'` | `variant`; the multi condition is in stream-pipeline |
| topology | no lang → English (`lang !== 'ko'`); single route only | no lang → Korean (`lang === 'en'`) | `isEn`; `!isMulti` in stream-pipeline |
| datasource | 100 rows + `ds.url`, each block prefixed `\n\n`, `correlationHint`, empty answer → `'No response'`, on failure → AgentCore `ops` | 80 rows, no URL, on failure → direct Bedrock call, unknown modelKey → `undefined` model | `variant`, `emptyContent`, `modelId`; each pipeline decides where a failure goes |
| auto-collect | real `send` and `isEn`; on error, `${route}-error` status, then the gateway; `done` says `'No response'` while the stats summary keeps the raw text | no-op send, `isEn=true`; on error, null → Bedrock fallback; no model fallback | `ctx.emit`, `isEn`, `modelId`; the try/catch and `'No response'` are in each pipeline |
| sql | `usedTools` gets `steampipe: <table>`; `'No response'` | no `usedTools` (→ `[]`) | `withSqlTools`, `emptyContent` |
| gateway | 15 s keepalive, simulated 50-char streaming, `recordAndSave` after the simulation | returns directly | stream-pipeline (around `gatewayStep`) |
| fallback | `success:false`, gateway `bedrock-fallback`, no routes in done | `'Bedrock Direct (fallback)'`, no usedTools | each pipeline |
| multi | 0 successes → Bedrock fallback or an error event; ConverseStream synthesis | `'All routes failed. Please try again.'`; InvokeModel synthesis | each pipeline; on both paths the participants are `handleSingleRoute` (JSON variant) |

Rules that apply to every handler:
- `recordAndSave` is called only when streaming, on these paths: datasource, auto-collect, sql, gateway, the single-route fallback and the multi-route synthesis (2+ successes).
- Token counts appear only in the stream `done` event, and they include the classification tokens.
- Every AgentCore call within one request shares the same `requestId` (health vote).

## Rules
- The characterization tests are frozen (see above).
- The path differences are intentional. Don't "clean them up". A new difference becomes an opts flag and a row in this table.
- Collectors load through `` import(`@/lib/collectors/${route}`) `` (webpack bundling), in `steps/auto-collect.ts`.
- `route.ts` exports only `GET`/`POST`. Exporting anything else breaks the Next build.
