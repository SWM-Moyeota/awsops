# Slack ChatOps — Slack에서 AWSops AI에게 바로 묻기

Slack 채널에서 `@AWSops 지금 켜진 EC2 뭐 있어?`처럼 부르면, 대시보드 AI가 같은 스레드에 답합니다.

## 동작 방식

```
팀원: @AWSops 지금 켜진 EC2 뭐 있어?
  │  (Socket Mode — 서버가 Slack에 먼저 열어 둔 WebSocket 연결)
  ▼
EC2 대시보드 서버 (src/lib/slack-chatops/bot.ts, 서버 기동 시 자동 연결)
  │  "🔍 확인 중이에요..." 답글 → http://127.0.0.1:3000/api/ai (stream:false, lang:ko)
  ▼
기존 AI 라우팅 (Steampipe / AgentCore Gateway / Bedrock) → 답글을 AI 답으로 교체
```

- **공개 URL이 필요 없습니다.** 서버가 Slack 쪽으로 나가는 연결만 쓰므로 ALB와 Cognito 설정은 그대로입니다.
- 스레드 안에서 다시 부르면 그 스레드의 이전 대화(최근 10개)를 맥락으로 함께 보냅니다.
- 헬스 알림 스레드에 `@AWSops 이거 왜 이래?`라고 답글을 달면, 알림 내용이 맥락으로 들어갑니다.
- 동시에 2건까지만 답하고 나머지는 차례를 기다립니다. Steampipe 연결 풀을 보호하기 위해서입니다.
- 토큰이 SSM에 없으면 봇은 꺼진 채로 있고, 대시보드는 평소처럼 동작합니다.
- **프로덕션 서버(`npm run start`)에서만 연결합니다.** 노트북에서 `npm run dev`를 띄워도 연결하지 않습니다. 연결이 두 개 생기면 Slack이 멘션을 나눠 보내기 때문입니다.
- 서버 기동 직후 SSM이나 네트워크가 준비되지 않아 실패하면 30초~10분 간격으로 5번 다시 시도합니다. 토큰이 틀리면(`invalid_auth`) 바로 멈춥니다.

## 누가 물어볼 수 있나요

봇은 Cognito 로그인을 거치지 않으므로 대시보드와 같은 정보(비용, IAM, 리소스 목록)를 Slack에 보여 줍니다.
- **다른 워크스페이스 사람**(Slack Connect 공유 채널)의 멘션은 무시합니다.
- **채널 제한(권장)**: `data/config.json`에 `"slackAllowedChannelIds": ["C0123ABCD"]`를 넣으면 그 채널에서만 답합니다. 다른 채널에서는 "이 채널에서는 물어볼 수 없어요"라고 안내합니다. 값을 비우거나 지우면 봇이 초대된 모든 채널에서 답합니다. 재시작은 필요 없고 1분 안에 반영됩니다.
  - 채널 ID 찾기: Slack에서 채널 이름 클릭 → 맨 아래 "채널 ID".

## 설정 (처음 한 번)

1. **Slack 앱 만들기**: api.slack.com/apps → **Create New App** → **From a manifest** → 워크스페이스 선택 → `docs/runbooks/slack-chatops-manifest.yaml` 내용 붙여넣기 → Create.
2. **App-Level Token 만들기**: **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** → 이름 `socket`, scope `connections:write` → `xapp-...` 복사.
3. **설치**: **OAuth & Permissions** → **Install to Workspace** → `Bot User OAuth Token`(`xoxb-...`) 복사.
   - 워크스페이스가 앱 승인을 요구하면 관리자 승인이 필요합니다.
4. **토큰 저장 + 재시작** (관리자 Mac): `bash scripts/15-setup-slack-chatops.sh`
   - 토큰 2개를 숨김 입력으로 받아 SSM SecureString에 저장하고, SSM으로 서버를 재시작합니다.
5. **채널에 초대**: 쓸 채널에서 `/invite @AWSops`.

## 확인 / 문제 해결

| 증상 | 확인 |
|------|------|
| 멘션해도 반응 없음 | 서버 로그 `grep slack-chatops /tmp/awsops-server.log` — `connected as ...`가 있어야 함 |
| `off — SSM ... not set` | 4단계를 다시 실행 (토큰 접두사 `xoxb-`/`xapp-` 확인) |
| `start failed (invalid_auth)` | 토큰이 틀렸거나 앱이 재설치됨 → 4단계 재실행 |
| "확인 중"에서 멈춤 → `⚠️ 답을 만들지 못했어요` | AI 쪽 문제. 대시보드 `/ai` 화면에서 같은 질문 시도, 헬스 화면 확인 |
| 후속 질문에 맥락이 없음 | 매니페스트의 `channels:history`/`groups:history` 권한 확인 후 앱 재설치 |

- 봇 끄기: SSM 파라미터 2개 삭제 후 재시작, 또는 환경 변수 `SLACK_CHATOPS_DISABLED=1`.
- 토큰은 SSM에만 저장하고 로그·채팅·코드에 남기지 않습니다.

## 알려진 한계

- 답은 대시보드 AI와 같습니다. 대시보드에서 할 수 없는 일은 Slack에서도 할 수 없습니다.
- 헬스 알림의 "AI로 원인 분석" 버튼은 아직 없습니다. 지금은 알림 스레드에 멘션해서 대신합니다. 버튼을 달려면 웹훅 대신 봇으로 알림을 보내고 interactivity를 켜야 합니다.
