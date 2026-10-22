# 헬스 모니터 모듈

## 역할
Slack 헬스 알림의 기반. 점검 결과로부터 항목별 상태(ok/fail/unknown)를 갱신하고, 알림 대상이 되는 상태 전이(Transition)만 골라내는 순수 로직과 상태 파일 저장을 담당한다.

## 주요 파일
- `types.ts` — 공용 타입 (`CheckId`, `CheckStatus`, `CheckResult`, `ItemState`, `HealthState`, `Transition`) 및 `CHECK_IDS`
- `state.ts` — 상태 머신: `initialState()`, `applyResults(prev, results, now)`, `loadState(path)`, `saveState(path, s)`, `FAIL_THRESHOLD`
- `slack.ts` — Slack 알림: `CHECK_TITLES`, `REMEDIATION`, `formatSlackMessage(transitions, {dashboardUrl, now})`(KST, 전이 묶음 1메시지), `postSlack(url, payload)`(10s 타임아웃, 예외 없음), `getWebhookUrl()`(SSM `/awsops/slack-webhook-url`, 5분 캐시, 없으면 null), `sendTestMessage()` — 웹훅 URL은 로그/에러에 절대 포함하지 않는다
- `__tests__/state.test.ts` — 상태 머신/저장 단위 테스트 (vitest)
- `__tests__/slack.test.ts` — Slack 포맷/전송 단위 테스트 (vitest)

## 규칙
- `applyResults`는 순수 함수 — `prev`를 변경하지 않고, 결과에 없는 항목은 그대로 둔다
- 연속 실패가 `FAIL_THRESHOLD`(기본 2회, `agentcore-invoke`는 3회)에 도달해야 `fail`로 전이하고 알림 대상이 된다
- `unknown → ok`는 알림 없음, `fail → ok`는 첫 성공 즉시 복구 전이
- `since`는 마지막 상태 변경 시각(ISO)
- 상태 파일(`data/health-status.json`)은 `.tmp`에 쓴 뒤 `renameSync`로 원자적 교체, 파일이 없거나 깨져 있으면 `initialState()`로 폴백
- 상태 파일은 런타임 산출물이므로 git에 커밋하지 않는다 (`.gitignore`)

---

# Health Monitor Module (English)

## Role
Foundation of the Slack health alerts. Pure logic that updates per-item status (ok/fail/unknown) from check results and selects only the state transitions worth alerting on, plus state-file persistence.

## Key Files
- `types.ts` — Shared types (`CheckId`, `CheckStatus`, `CheckResult`, `ItemState`, `HealthState`, `Transition`) and `CHECK_IDS`
- `state.ts` — State machine: `initialState()`, `applyResults(prev, results, now)`, `loadState(path)`, `saveState(path, s)`, `FAIL_THRESHOLD`
- `slack.ts` — Slack delivery: `CHECK_TITLES`, `REMEDIATION`, `formatSlackMessage(transitions, {dashboardUrl, now})` (KST, all transitions bundled into one message), `postSlack(url, payload)` (10s timeout, never throws), `getWebhookUrl()` (SSM `/awsops/slack-webhook-url`, 5-min cache, null if missing), `sendTestMessage()` — the webhook URL is never logged or returned in errors
- `__tests__/state.test.ts` — State machine / persistence unit tests (vitest)
- `__tests__/slack.test.ts` — Slack formatting / delivery unit tests (vitest)

## Rules
- `applyResults` is pure — it never mutates `prev`, and items absent from the results are left untouched
- An item becomes `fail` (and alertable) only after consecutive failures reach `FAIL_THRESHOLD` (2 by default, 3 for `agentcore-invoke`)
- `unknown → ok` is silent; `fail → ok` recovers on the first success
- `since` is the ISO time of the last status change
- The state file (`data/health-status.json`) is written to `.tmp` then swapped in with `renameSync`; a missing or corrupt file falls back to `initialState()`
- The state file is a runtime artifact — never commit it (`.gitignore`)
