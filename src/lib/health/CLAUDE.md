# 헬스 모니터 모듈

## 역할
Slack 헬스 알림의 기반. 점검 결과로부터 항목별 상태(ok/fail/unknown)를 갱신하고, 알림 대상이 되는 상태 전이(Transition)만 골라내는 순수 로직과 상태 파일 저장을 담당한다.

## 주요 파일
- `types.ts` — 공용 타입 (`CheckId`, `CheckStatus`, `CheckResult`, `ItemState`, `HealthState`, `Transition`) 및 `CHECK_IDS`
- `state.ts` — 상태 머신: `initialState()`, `applyResults(prev, results, now)`, `loadState(path)`, `saveState(path, s)`, `FAIL_THRESHOLD`
- `slack.ts` — Slack 알림: `CHECK_TITLES`, `REMEDIATION`, `formatSlackMessage(transitions, {dashboardUrl, now})`(KST, 전이 묶음 1메시지), `postSlack(url, payload)`(10s 타임아웃, 예외 없음), `getWebhookUrl()`(SSM `/ops/awsops/slack-webhook-url`, 10s abortSignal 타임아웃, 5분 캐시, 없으면 null), `sendTestMessage()` — 웹훅 URL은 로그/에러에 절대 포함하지 않는다
- `__tests__/state.test.ts` — 상태 머신/저장 단위 테스트 (vitest)
- `checks.ts` — 서버 안 점검 (예외 없음, AWS SDK v3만 사용): `checkSteampipe()`(`steampipe.ts`의 `pingSteampipe()` — 풀 밖 단기 Client로 `select 1`), `checkBedrock()`(`getBedrockModelId()`, max_tokens 1), `checkAgentcoreRuntime()`(`agentRuntimeArn` 마지막 경로 세그먼트로 `GetAgentRuntime`, READY만 정상), `checkLambdas()`(`TOOL_LAMBDAS` 명시적 19개, `{"tool_name":"__healthcheck__"}`, 동시 4개, 호출당 20s), `classifyLambdaProbe()`(Runtime.ImportModuleError/HandlerNotFound/UserCodeSyntaxError/ExitError 또는 timed out만 실패)
- `monitor.ts` — 5분 루프 + AgentCore 호출 훅: `ensureHealthMonitorStarted()`(`globalThis.__awsopsHealthMonitor` 싱글턴, 첫 실행 즉시, Bedrock·Lambda는 첫 회와 6회마다), `runOnce({includeSlow})`(진행 중 실행 공유), `reportAgentcoreInvoke(requestId, outcome)`(error는 요청당 1회, timeout은 로그만, success는 리셋 — 즉시 상태 머신 반영), `getHealthSnapshot()`. 루프와 훅은 `processResults()` 하나를 공유(applyResults → 저장 → 전이 묶음당 Slack 1건, `slackChain`에 직렬화하되 기다리지 않음 — Slack/SSM이 멈춰도 `runOnce`·하트비트는 막히지 않는다). 매 실행 후 CloudWatch `AWSops/Health` `Heartbeat=1`(차원 없음, 10s 타임아웃)
- `__tests__/checks.test.ts`, `__tests__/monitor.test.ts` — 점검/모니터 단위 테스트 (AWS SDK는 `vi.mock`)
- `__tests__/slack.test.ts` — Slack 포맷/전송 단위 테스트 (vitest)

## 규칙
- `applyResults`는 순수 함수 — `prev`를 변경하지 않고, 결과에 없는 항목은 그대로 둔다
- 연속 실패가 `FAIL_THRESHOLD`(기본 2회, `agentcore-invoke`는 3회)에 도달해야 `fail`로 전이하고 알림 대상이 된다
- `unknown → ok`는 알림 없음, `fail → ok`는 첫 성공 즉시 복구 전이
- `since`는 마지막 상태 변경 시각(ISO)
- 상태 파일(`data/health-status.json`)은 `.tmp`에 쓴 뒤 `renameSync`로 원자적 교체, 파일이 없거나 깨져 있으면 `initialState()`로 폴백
- 상태 파일은 런타임 산출물이므로 git에 커밋하지 않는다 (`.gitignore`)
- 모니터는 `/api/ai` import로 시작되지 않는다 — 시작은 `/api/health`·`/api/steampipe`(캐시 워머와 함께 지연 시작)·기동 스크립트(09 재시도, 13 ExecStartPost) 담당. `reportAgentcoreInvoke`는 모니터 시작 여부와 무관하게 상태를 갱신한다
- 웹훅 미설정 경고는 프로세스당 1회, 웹훅 URL은 절대 로그에 남기지 않는다

---

# Health Monitor Module (English)

## Role
Foundation of the Slack health alerts. Pure logic that updates per-item status (ok/fail/unknown) from check results and selects only the state transitions worth alerting on, plus state-file persistence.

## Key Files
- `types.ts` — Shared types (`CheckId`, `CheckStatus`, `CheckResult`, `ItemState`, `HealthState`, `Transition`) and `CHECK_IDS`
- `state.ts` — State machine: `initialState()`, `applyResults(prev, results, now)`, `loadState(path)`, `saveState(path, s)`, `FAIL_THRESHOLD`
- `slack.ts` — Slack delivery: `CHECK_TITLES`, `REMEDIATION`, `formatSlackMessage(transitions, {dashboardUrl, now})` (KST, all transitions bundled into one message), `postSlack(url, payload)` (10s timeout, never throws), `getWebhookUrl()` (SSM `/ops/awsops/slack-webhook-url`, 10s abortSignal timeout, 5-min cache, null if missing), `sendTestMessage()` — the webhook URL is never logged or returned in errors
- `__tests__/state.test.ts` — State machine / persistence unit tests (vitest)
- `checks.ts` — In-server checks (never throw, AWS SDK v3 only): `checkSteampipe()` (`pingSteampipe()` in `steampipe.ts` — `select 1` on a short-lived Client outside the pool), `checkBedrock()` (`getBedrockModelId()`, max_tokens 1), `checkAgentcoreRuntime()` (`GetAgentRuntime` on the last path segment of `agentRuntimeArn`, only READY is ok), `checkLambdas()` (explicit 19-name `TOOL_LAMBDAS`, `{"tool_name":"__healthcheck__"}`, concurrency 4, 20s per call), `classifyLambdaProbe()` (fails only on Runtime.ImportModuleError/HandlerNotFound/UserCodeSyntaxError/ExitError or timed out)
- `monitor.ts` — 5-min loop + AgentCore invoke hook: `ensureHealthMonitorStarted()` (singleton on `globalThis.__awsopsHealthMonitor`, first run immediately, Bedrock + Lambda on the first and every 6th run), `runOnce({includeSlow})` (concurrent calls share the in-flight run), `reportAgentcoreInvoke(requestId, outcome)` (error counts once per request, timeout only logs, success resets — applied immediately), `getHealthSnapshot()`. Loop and hook share one `processResults()` (applyResults → persist → one Slack message per batch of transitions, serialized on `slackChain` but not awaited — a stuck Slack/SSM path never blocks `runOnce` or the heartbeat). After every run: CloudWatch `AWSops/Health` `Heartbeat=1` (no dimensions, 10s timeout)
- `__tests__/checks.test.ts`, `__tests__/monitor.test.ts` — Check / monitor unit tests (AWS SDK mocked with `vi.mock`)
- `__tests__/slack.test.ts` — Slack formatting / delivery unit tests (vitest)

## Rules
- `applyResults` is pure — it never mutates `prev`, and items absent from the results are left untouched
- An item becomes `fail` (and alertable) only after consecutive failures reach `FAIL_THRESHOLD` (2 by default, 3 for `agentcore-invoke`)
- `unknown → ok` is silent; `fail → ok` recovers on the first success
- `since` is the ISO time of the last status change
- The state file (`data/health-status.json`) is written to `.tmp` then swapped in with `renameSync`; a missing or corrupt file falls back to `initialState()`
- The state file is a runtime artifact — never commit it (`.gitignore`)
- Importing `/api/ai` does not start the monitor — `/api/health` and `/api/steampipe` (lazily, next to the cache warmer) and the startup scripts (09 with retries, 13 ExecStartPost) do. `reportAgentcoreInvoke` updates state whether or not the loop is running
- The missing-webhook warning is logged at most once per process; the webhook URL is never logged
