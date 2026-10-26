# AI 처리기 단계 (`src/lib/ai/steps/`)

## 역할
`/api/ai` 처리기 본문을 한 곳에 둔다. JSON 경로와 SSE 경로가 같은 단계를 부르고, 경로 차이는 호출하는 쪽이 넘기는 `opts` 플래그로만 표현한다. 계약, 플래그 목록, spec §3 차이표는 `../CLAUDE.md`에 있다.

## 파일
- `types.ts` — `StepCtx`, `StepResult`, `StepVariant`, `EmptyContent`, `recentMessages`(최근 10개), `lastMessageOf`.
- `code.ts` — `codeStep(ctx, { variant, modelId })`: 코드 생성 → Code Interpreter 실행. 실행 결과는 chunk로 한 번 더 보낸다.
- `topology.ts` — `topologyStep(ctx, { isEn })`: 대상 VPC를 정하고 토폴로지뷰 링크로 답한다.
- `sql.ts` — `sqlStep(ctx, { modelId, emptyContent, withSqlTools })`: SQL 생성 → Steampipe 실행(한 번 수정 재시도) → 분석. 실패하면 `sql-fallback` 상태를 보내고 null을 돌려준다.
- `datasource.ts` — `datasourceStep(ctx, { variant, modelId, emptyContent })`: 타입 감지 → 병렬 쿼리(한 번 수정 재시도) → 분석. 결과의 `extra.statsVia`는 통계용 via다.
- `auto-collect.ts` — `autoCollectStep(ctx, { isEn, modelId })`: `` import(`@/lib/collectors/${route}`) `` → 수집 → 분석(8192 토큰). 오류는 던진다. content는 원문 그대로다.
- `gateway.ts` — `gatewayStep(ctx)`: AgentCore 호출(route의 gateway + skill, 요청 `requestId`) → tool-call 태그 제거. keepalive는 호출한 쪽 몫이다.
- `single-route.ts` — `handleSingleRoute(route, input)`: 모든 단계의 JSON 변형(emit 무동작, `invokeText`). JSON 단일 라우트와 두 경로의 멀티 라우트 참여자가 쓴다.

## 규칙
- 단계는 `recordAndSave`, 토큰 누적, `done` 전송, keepalive, 넘어가는 순서를 다루지 않는다. 모두 파이프라인 몫이다.
- 상태 이벤트 문구와 순서는 리팩터링 전과 같아야 한다. `../__tests__/characterization/`가 고정한다(동결, 수정 금지).

---

# AI Handler Steps (`src/lib/ai/steps/`)

## Role
Keeps each `/api/ai` handler body in one place. The JSON and SSE paths call the same steps, and the path differences arrive only as caller-supplied `opts` flags. The contract, the flag list and the spec §3 difference table are in `../CLAUDE.md`.

## Files
- `types.ts` — `StepCtx`, `StepResult`, `StepVariant`, `EmptyContent`, `recentMessages` (last 10), `lastMessageOf`.
- `code.ts` — `codeStep(ctx, { variant, modelId })`: generate code, then run it in the Code Interpreter. The execution block goes out as one more chunk.
- `topology.ts` — `topologyStep(ctx, { isEn })`: resolves the target VPC and answers with a Topology View link.
- `sql.ts` — `sqlStep(ctx, { modelId, emptyContent, withSqlTools })`: generate SQL, run it on Steampipe (one fix-and-retry), then analyze. On failure it emits the `sql-fallback` status and returns null.
- `datasource.ts` — `datasourceStep(ctx, { variant, modelId, emptyContent })`: detect types, query them in parallel (one fix-and-retry each), then analyze. `extra.statsVia` on the result is the via used for stats.
- `auto-collect.ts` — `autoCollectStep(ctx, { isEn, modelId })`: `` import(`@/lib/collectors/${route}`) ``, collect, then analyze (8192 tokens). It throws on error and returns the raw content.
- `gateway.ts` — `gatewayStep(ctx)`: calls AgentCore (the route's gateway + skill, the request's `requestId`) and strips the tool-call tags. The caller owns the keepalive.
- `single-route.ts` — `handleSingleRoute(route, input)`: the JSON variant of every step (no-op emit, `invokeText`). The JSON single route uses it, and so do the multi-route participants on both paths.

## Rules
- Steps never call `recordAndSave`, add up tokens, send `done`, run keepalives or decide the fall-through. The pipelines do all of that.
- Status event text and order must match the pre-refactor behaviour. `../__tests__/characterization/` pins them; those tests are frozen, so never edit them.
