# AI 라우트 모듈 (`src/lib/ai/`)

## 역할
`src/app/api/ai/route.ts`(1,808줄)를 동작 변경 없이 쪼개는 리팩터링의 결과물을 둔다. `route.ts`는 `GET`/`POST`만 export한다.

## 파일 (잎 모듈, 현재까지)
- `models.ts` — `MODELS`, `resolveModelId`(키가 없으면 기본 모델로 폴백, 스트림 경로), `rawModelId`(폴백 없음, JSON datasource/auto-collect 경로).
- `clients.ts` — `bedrockClient`, `agentCoreClient`(모듈 싱글턴), `getAgentRuntimeArn`, `getCodeInterpreterName`.
- `registry.ts` — `ROUTE_REGISTRY`, `RouteConfig`, `RouteType`, `VALID_ROUTES`. `prompts.ts`를 import하지 않는다(순환 방지).
- `prompts.ts` — `CLASSIFICATION_PROMPT`, `getSystemPrompt`, `SQL_GEN_PROMPT`, `CODE_PROMPT_SUFFIX`, `SYNTHESIS_PROMPT_SUFFIX`, `TOPOLOGY_PROMPT`. 문구는 한 글자도 바꾸지 않는다.
- `status.ts` — `buildStatus(lang)`, `pick`.
- `tools.ts` — `KNOWN_TOOLS`, `TOOL_KEYWORD_MAP`, `extractUsedTools`.
- `sse.ts` — `sseEvent`, `simulateStreaming`(50자 청크), `streamBedrockToSSE`.
- `stats.ts` — `recordAndSave`.

## 규칙
- `__tests__/characterization/*.test.ts`는 동결이다. 수정하지 않는다 — 실패하면 동작이 바뀐 것이니 코드를 고친다.
- 스트림/JSON 경로의 차이(via 문자열, `isEn`, 데이터소스 행 수 등)는 의도된 것이다. "정리"하지 않는다.

---

# AI Route Modules (`src/lib/ai/`)

## Role
Holds the pieces of the behaviour-preserving split of `src/app/api/ai/route.ts` (1,808 lines). `route.ts` exports only `GET`/`POST`.

## Files (leaf modules so far)
- `models.ts` — `MODELS`, `resolveModelId` (falls back to the default model; stream path), `rawModelId` (no fallback; JSON datasource/auto-collect path).
- `clients.ts` — `bedrockClient`, `agentCoreClient` (module singletons), `getAgentRuntimeArn`, `getCodeInterpreterName`.
- `registry.ts` — `ROUTE_REGISTRY`, `RouteConfig`, `RouteType`, `VALID_ROUTES`. Must not import `prompts.ts` (avoids a cycle).
- `prompts.ts` — `CLASSIFICATION_PROMPT`, `getSystemPrompt`, `SQL_GEN_PROMPT`, `CODE_PROMPT_SUFFIX`, `SYNTHESIS_PROMPT_SUFFIX`, `TOPOLOGY_PROMPT`. Text stays byte-identical.
- `status.ts` — `buildStatus(lang)`, `pick`.
- `tools.ts` — `KNOWN_TOOLS`, `TOOL_KEYWORD_MAP`, `extractUsedTools`.
- `sse.ts` — `sseEvent`, `simulateStreaming` (50-char chunks), `streamBedrockToSSE`.
- `stats.ts` — `recordAndSave`.

## Rules
- `__tests__/characterization/*.test.ts` are FROZEN. Never edit them; if one fails, behaviour changed, so fix the code.
- Stream-vs-JSON differences (via strings, `isEn`, datasource row counts, ...) are intentional. Do not "clean them up".
