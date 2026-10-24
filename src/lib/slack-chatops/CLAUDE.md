# Slack ChatOps 모듈

## 역할
Slack에서 `@AWSops`를 부르면 대시보드 AI(`/api/ai`)에게 물어 같은 스레드에 답한다. Socket Mode라 공개 URL이 필요 없고, ALB/Cognito는 그대로 둔다. 운영 안내: `docs/runbooks/slack-chatops.md`.

## 주요 파일
- `bot.ts` — `startSlackChatops()` (멱등, 예외 없음): SSM `/ops/awsops/slack-bot-token`·`/ops/awsops/slack-app-token` 읽기 → `auth.test` → `SocketModeClient` `app_mention` 구독. 즉시 ack, `event_id` 중복 제거(최근 500), 동시 답변 2건 제한. `NODE_ENV=production`에서만 연결(dev 서버가 두 번째 연결을 열지 않도록). 토큰이 없으면 꺼진 채로 로그 1줄만 남기고, 그 외 기동 실패는 30초~10분 백오프로 5회 재시도(`invalid_auth` 등은 즉시 중단). WebClient 재시도 2회.
- `handle.ts` — `handleMention(event, deps)`: 다른 봇·다른 워크스페이스(`user_team`) 무시 → `config.slackAllowedChannelIds`가 있으면 그 채널만 → 빈 질문이면 도움말 → "확인 중" 답글 → (스레드면) `conversations.replies`로 맥락 구성 → `ask` → 답글을 `markdown` 블록으로 교체, 블록이 거부되면 일반 텍스트로 재시도, AI 실패 시 한국어 오류 안내.
- `ask.ts` — `askAwsops(messages)`: `http://127.0.0.1:$PORT/api/ai`에 `{stream:false, lang:'ko'}` POST, 240초 타임아웃.
- `format.ts` — `extractQuestion`, `buildConversation`(우리 봇만 assistant, 다른 봇·사람은 user, 최근 10개, 같은 역할 병합, user로 시작), `markdownToMrkdwn`(폴백용), `toSlackMessage`(11,000자에서 자르기 + 출처·소요 시간·대시보드 링크 footer).
- `concurrency.ts` — `createLimiter(max)`, `createRecentSet(size)`.
- 기동: `src/instrumentation.ts` (`next.config.mjs`의 `experimental.instrumentationHook`). Slack SDK는 `serverComponentsExternalPackages`로 번들에서 제외한다.

## 규칙
- 토큰·Slack 오류 본문을 로그에 남기지 않는다 — Slack 오류 코드(`data.error`)나 에러 이름만 남긴다.
- 봇은 Cognito를 거치지 않는다 — 접근 제한(워크스페이스·채널 허용 목록)을 약하게 만들지 않는다.
- AWS를 바꾸는 동작은 추가하지 않는다 — 대시보드 AI와 같은 범위만 답한다.
- `instrumentation.ts`의 import는 `NEXT_RUNTIME === 'nodejs'` 분기 안에 둔다 (edge 빌드가 Node 전용 SDK를 묶으면 빌드 실패).

---

# Slack ChatOps Module (English)

## Role
Mention `@AWSops` in Slack and the dashboard AI (`/api/ai`) answers in the same thread. Socket Mode, so no public URL is needed and ALB/Cognito are untouched. Runbook: `docs/runbooks/slack-chatops.md`.

## Key Files
- `bot.ts` — `startSlackChatops()` (idempotent, never throws): reads SSM `/ops/awsops/slack-bot-token` + `/ops/awsops/slack-app-token` → `auth.test` → `SocketModeClient` on `app_mention`. Immediate ack, `event_id` dedupe (last 500), at most 2 concurrent answers. Connects only when `NODE_ENV=production` (so a dev server never opens a second connection). Without tokens it stays off with one log line; other boot failures retry 5 times with 30s–10min backoff (`invalid_auth` etc. stop at once). WebClient retries capped at 2.
- `handle.ts` — `handleMention(event, deps)`: ignore bots and other workspaces (`user_team`) → only `config.slackAllowedChannelIds` channels when set → help text for an empty question → "checking" reply → thread context via `conversations.replies` → `ask` → replace the reply with a `markdown` block, retry as plain text if blocks are rejected, Korean error notice when the AI fails.
- `ask.ts` — `askAwsops(messages)`: POST `{stream:false, lang:'ko'}` to `http://127.0.0.1:$PORT/api/ai`, 240s timeout.
- `format.ts` — `extractQuestion`, `buildConversation` (only our bot is assistant; people and other bots are user; last 10; same-role merge; starts with user), `markdownToMrkdwn` (fallback), `toSlackMessage` (truncate at 11,000 chars + via/elapsed/dashboard-link footer).
- `concurrency.ts` — `createLimiter(max)`, `createRecentSet(size)`.
- Startup: `src/instrumentation.ts` (`experimental.instrumentationHook` in `next.config.mjs`). Slack SDKs are kept out of the bundle via `serverComponentsExternalPackages`.

## Rules
- Never log tokens or Slack error bodies — only the Slack error code (`data.error`) or error name.
- The bot bypasses Cognito — never weaken the workspace/channel allowlist checks.
- No AWS-mutating actions — answer exactly what the dashboard AI can.
- Keep the import in `instrumentation.ts` inside the `NEXT_RUNTIME === 'nodejs'` branch (bundling Node-only SDKs into the edge build fails the build).
