# AI 라우트 모듈 (`src/lib/ai/`)

## 역할
`src/app/api/ai/route.ts`(1,808줄)를 동작 변경 없이 쪼개는 리팩터링의 결과물을 둔다. `route.ts`는 `GET`/`POST`만 export한다. POST는 JSON 파싱(400), accountId 검증·계정 조회, `buildStatus`, 사용자 조회, `requestId` 생성만 하고 `handleNonStreaming` 또는 `runStreaming`에 넘긴다.

## 파일 (잎 모듈 + 서비스 + 파이프라인)
- `models.ts` — `MODELS`, `resolveModelId`(키가 없으면 기본 모델로 폴백, 스트림 경로), `rawModelId`(폴백 없음, JSON datasource/auto-collect 경로).
- `clients.ts` — `bedrockClient`, `agentCoreClient`(모듈 싱글턴), `getAgentRuntimeArn`, `getCodeInterpreterName`.
- `registry.ts` — `ROUTE_REGISTRY`, `RouteConfig`, `RouteType`, `VALID_ROUTES`. `prompts.ts`를 import하지 않는다(순환 방지).
- `prompts.ts` — `CLASSIFICATION_PROMPT`, `getSystemPrompt`, `SQL_GEN_PROMPT`, `CODE_PROMPT_SUFFIX`, `SYNTHESIS_PROMPT_SUFFIX`, `TOPOLOGY_PROMPT`. 문구는 한 글자도 바꾸지 않는다.
- `status.ts` — `buildStatus(lang)`, `pick`.
- `tools.ts` — `KNOWN_TOOLS`, `TOOL_KEYWORD_MAP`, `extractUsedTools`.
- `sse.ts` — `sseEvent`, `simulateStreaming`(50자 청크), `streamBedrockToSSE`.
- `stats.ts` — `recordAndSave`.
- `classify.ts` — `parseClassification`(순수 파싱), `classifyIntent`.
- `sql.ts` — `generateSQL`, `queryAWS`.
- `topology.ts` — `TopologyParams`, `generateTopologyParams`, `topologyContent`.
- `datasource-query.ts` — `generateDatasourceQuery`.
- `code-interpreter.ts` — `extractPythonCode`, `executeCodeInterpreter`.
- `agentcore.ts` — `AGENTCORE_TIMEOUT_MS`(90초), `invokeAgentCore`(90초 race, 요청당 하나의 `requestId`), `streamToString`.
- `pipeline-input.ts` — `PipelineInput`(`messages`, `modelKey?`, `lang?`, `accountId?`, `accountAlias?`, `requestId`, `user`), `StreamPipelineInput`(+ `account?`, `status`, `systemPrompt`, `isEn`). POST가 검증·계정 조회·사용자 조회 뒤에 만든다. 스트림 본문의 예전 클로저 변수(`STATUS`, `SYSTEM_PROMPT`, `isEn`, `clientLang`, `currentUser`, `account` 등)는 모두 여기로 들어오며, 구조 분해로 원래 이름을 되살린다.
- `json-pipeline.ts` — `handleNonStreaming(input)`, `handleSingleRoute`(멀티 라우트 참여용, 스트림 경로도 사용), `synthesizeResponses`(InvokeModel). route.ts에서 그대로 옮겼다.
- `stream-pipeline.ts` — `runStreaming(input): ReadableStream`(POST의 SSE 본문 전체: keepalive 15초 인터벌, `send`, 토큰 누적, `recordAndSave`, 오류 처리), `synthesizeResponsesStreaming`(ConverseStream). SSE 응답 헤더는 route.ts에 그대로 있다.

## 규칙
- `__tests__/characterization/*.test.ts`는 동결이다. 수정하지 않는다 — 실패하면 동작이 바뀐 것이니 코드를 고친다.
- 스트림/JSON 경로의 차이(via 문자열, `isEn`, 데이터소스 행 수 등)는 의도된 것이다. "정리"하지 않는다.

---

# AI Route Modules (`src/lib/ai/`)

## Role
Holds the pieces of the behaviour-preserving split of `src/app/api/ai/route.ts` (1,808 lines). `route.ts` exports only `GET`/`POST`. POST does the JSON parse (400s), accountId validation and account lookup, `buildStatus`, the user lookup and the `requestId`, then hands off to `handleNonStreaming` or `runStreaming`.

## Files (leaf modules + services + pipelines)
- `models.ts` — `MODELS`, `resolveModelId` (falls back to the default model; stream path), `rawModelId` (no fallback; JSON datasource/auto-collect path).
- `clients.ts` — `bedrockClient`, `agentCoreClient` (module singletons), `getAgentRuntimeArn`, `getCodeInterpreterName`.
- `registry.ts` — `ROUTE_REGISTRY`, `RouteConfig`, `RouteType`, `VALID_ROUTES`. Must not import `prompts.ts` (avoids a cycle).
- `prompts.ts` — `CLASSIFICATION_PROMPT`, `getSystemPrompt`, `SQL_GEN_PROMPT`, `CODE_PROMPT_SUFFIX`, `SYNTHESIS_PROMPT_SUFFIX`, `TOPOLOGY_PROMPT`. Text stays byte-identical.
- `status.ts` — `buildStatus(lang)`, `pick`.
- `tools.ts` — `KNOWN_TOOLS`, `TOOL_KEYWORD_MAP`, `extractUsedTools`.
- `sse.ts` — `sseEvent`, `simulateStreaming` (50-char chunks), `streamBedrockToSSE`.
- `stats.ts` — `recordAndSave`.
- `classify.ts` — `parseClassification` (pure parsing), `classifyIntent`.
- `sql.ts` — `generateSQL`, `queryAWS`.
- `topology.ts` — `TopologyParams`, `generateTopologyParams`, `topologyContent`.
- `datasource-query.ts` — `generateDatasourceQuery`.
- `code-interpreter.ts` — `extractPythonCode`, `executeCodeInterpreter`.
- `agentcore.ts` — `AGENTCORE_TIMEOUT_MS` (90 s), `invokeAgentCore` (90 s race, one `requestId` per request), `streamToString`.
- `pipeline-input.ts` — `PipelineInput` (`messages`, `modelKey?`, `lang?`, `accountId?`, `accountAlias?`, `requestId`, `user`) and `StreamPipelineInput` (+ `account?`, `status`, `systemPrompt`, `isEn`). Built by POST after validation, account lookup and user lookup. Every former closure variable of the stream body (`STATUS`, `SYSTEM_PROMPT`, `isEn`, `clientLang`, `currentUser`, `account`, ...) arrives here and is destructured back to its old name.
- `json-pipeline.ts` — `handleNonStreaming(input)`, `handleSingleRoute` (multi-route participant, also used by the stream path), `synthesizeResponses` (InvokeModel). Moved verbatim from route.ts.
- `stream-pipeline.ts` — `runStreaming(input): ReadableStream` (POST's whole SSE body: 15 s keepalive intervals, `send`, token accumulation, `recordAndSave`, error handling) and `synthesizeResponsesStreaming` (ConverseStream). The SSE response headers stay in route.ts.

## Rules
- `__tests__/characterization/*.test.ts` are FROZEN. Never edit them; if one fails, behaviour changed, so fix the code.
- Stream-vs-JSON differences (via strings, `isEn`, datasource row counts, ...) are intentional. Do not "clean them up".
