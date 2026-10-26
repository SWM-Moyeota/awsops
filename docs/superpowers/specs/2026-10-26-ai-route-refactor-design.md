# `/api/ai` route.ts 리팩토링 설계 — 동작은 그대로, 파일만 나누기

- 작성일: 2026-10-26
- 대상: `src/app/api/ai/route.ts` (1,808줄)
- 사용자 결정: **동작은 하나도 바꾸지 않는다.** 파일을 역할별로 나누고, 스트리밍(SSE)과 비스트리밍(JSON) 사이의 중복을 없앤다.

## 1. 왜 하는가
`route.ts` 한 파일에 분류, 라우트 등록표, 처리기 8종(code, topology, datasource, auto-collect, sql, gateway, multi, fallback), SSE 도우미, 통계가 모두 들어 있다. 처리기마다 스트리밍용과 JSON용 복사본이 따로 있어서, AI 쪽을 고칠 때마다 두 군데를 고쳐야 하고 둘이 조금씩 어긋나 왔다. Slack 봇(`stream:false`)과 대시보드(`stream:true`)가 모두 이 파일을 거치므로, 한쪽만 고치면 사용자마다 다른 답을 받는다.

## 2. 목표 / 비목표 / 반목표
- **목표**
  - 같은 요청에는 리팩토링 전과 같은 결과를 낸다. SSE 이벤트 순서와 내용, JSON 필드, 통계 기록, 폴백 순서가 모두 같아야 한다.
  - `route.ts`에는 `GET`/`POST`만 남긴다. 나머지는 `src/lib/ai/`로 옮긴다.
  - 처리기 로직은 한 곳(`steps/*`)에만 두고, 두 경로가 함께 쓴다.
- **비목표**
  - 두 경로의 차이를 "고치는" 일. 예: via 문구, 기본 언어, 데이터소스 행 수, 실패 시 갈 곳.
  - 성능 개선, 프롬프트 변경, 새 라우트 추가.
  - CLAUDE.md의 "11 라우트" 표기 정정. 실제는 등록표 키 19개다. 문서만 사실대로 고친다.
- **반목표 (이렇게 되면 실패)**
  - 겉으로는 깔끔한데 AI 답이나 Slack 답이 미묘하게 달라진다.
  - 빌드가 깨진다(`route.ts`가 HTTP 메서드 외의 것을 export하면 Next 빌드가 실패한다).
  - 테스트가 목(mock)만 확인해서 실제 동작 차이를 놓친다.

## 3. 보존해야 하는 차이 (분석 결과, 바꾸지 않는다)
| 처리기 | 스트리밍 | JSON |
|---|---|---|
| code | `'Bedrock (code request)'`, 멀티 라우트여도 첫 라우트가 code면 code만 실행 | `'Bedrock (code)'` |
| topology | lang이 없으면 영어(`clientLang !== 'ko'`), 단일 라우트에서만 | lang이 없으면 한국어(`lang === 'en'`) |
| datasource | 100행 + `ds.url`, `\n\n---` 접두, `correlationHint`, 빈 답이면 `'No response'`, 실패 시 AgentCore `ops` | 80행, URL 없음, 실패 시 Bedrock 직접 호출, 모르는 modelKey면 `undefined` 모델 |
| auto-collect | 실제 `send`·`isEn`, 오류면 `${route}-error` 상태 후 gateway로 | 아무것도 안 하는 send, `isEn=true`, 오류면 null → Bedrock 폴백, 모델 폴백 없음 |
| sql | `usedTools`에 `steampipe: <table>`, `'No response'` | `usedTools: []` |
| gateway | 15초 keepalive, 50자씩 흉내 스트리밍, 흉내 스트리밍 뒤에 `recordAndSave` | 바로 반환 |
| fallback | `success:false`, gateway `bedrock-fallback`, done에 routes 없음 | `'Bedrock Direct (fallback)'`, usedTools 없음 |
| multi | 성공 0이면 Bedrock 폴백 또는 error 이벤트, ConverseStream으로 합성 | `'All routes failed. Please try again.'`, InvokeModel로 합성 |

모든 처리기에 걸친 규칙
- `recordAndSave`는 스트리밍에서만, 그리고 정해진 경우에만 부른다.
- 토큰 수는 스트리밍 `done`에만 담고, 분류 단계 토큰을 포함한다.
- 요청 하나의 모든 AgentCore 호출에 같은 `requestId`를 쓴다(헬스 투표용).

## 4. 구조 (내가 정함)
`src/lib/ai/`. 기존 `slack-chatops/`, `health/`처럼 `CLAUDE.md`와 `__tests__/`를 둔다.
- **잎 모듈**: `models.ts`(`resolveModelId` 폴백 있음 / `rawModelId` 폴백 없음), `clients.ts`, `registry.ts`, `prompts.ts`, `status.ts`, `tools.ts`, `sse.ts`, `stats.ts`
- **서비스**: `bedrock.ts`(`invokeText`, `streamText` → `{content, inputTokens, outputTokens}`, `converseStream`), `classify.ts`, `agentcore.ts`, `code-interpreter.ts`, `sql.ts`, `topology.ts`, `datasource-query.ts`
- **단계(steps)**: `steps/{code,topology,datasource,sql,auto-collect,gateway}.ts`. 모양은 `(ctx: StepCtx) => Promise<StepResult | null>`이다. 경로 차이는 호출하는 쪽이 넘기는 명시적 옵션으로만 표현한다: `variant`, `isEn`, `emptyContent`, 미리 정한 `modelId`, `withSqlTools`.
- **조립자 2개**: `stream-pipeline.ts`, `json-pipeline.ts`. 두 경로는 실패 시 넘어가는 순서가 실제로 달라서, 하나로 합치면 모드 플래그가 너무 많아진다. 그래서 짧은 조립자 두 개가 같은 단계를 공유하게 한다.
- **`route.ts`**: `GET`, `POST`(검증 → 경로 선택)만 둔다.
- 등록표(`registry.ts`)는 `prompts.ts`를 import하지 않는다. 분류 프롬프트가 등록표를 읽기 때문에, 반대로 import하면 순환이 생긴다.
- collector 동적 import는 `@/lib/collectors/${route}` 형태를 유지한다(webpack 번들링용).

## 5. 안전망 — 특성 테스트 먼저
리팩토링 전에, 지금 동작을 그대로 고정하는 테스트를 만든다.
- 테스트는 `@/app/api/ai/route`의 `POST`/`GET`을 import한다. 그래서 코드를 아무리 옮겨도 같은 테스트가 계속 유효하다.
- 외부 의존성은 `vi.mock`으로 바꾼다: Bedrock, AgentCore, Steampipe, datasource-client, collectors, stats, memory, auth, health, config.
- 처리기마다 스트리밍과 JSON 각각에 대해 확인할 것: 이벤트 순서와 payload, JSON 필드, `recordCall` 인자, 폴백 조건, 토큰 합계, 타이머(15초 keepalive, 90초 타임아웃).
- 모든 단계가 끝날 때마다 이 테스트가 그대로 통과해야 한다. **이 테스트는 리팩토링 중에 고치지 않는다.** 고쳐야 한다면 그건 동작이 바뀌었다는 뜻이다.

## 6. 끝난 뒤 확인
- `npm test`, `npx tsc --noEmit`, `npx next build`
- 서버 배포 후 대시보드 AI 화면에서 질문 몇 개를 확인한다(스트리밍).
- Slack에서 `@AWSops`로 질문해 확인한다(JSON). 이 둘은 서버에서 직접 호출해 확인한다.
