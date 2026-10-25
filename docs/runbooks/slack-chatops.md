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
- **헬스 알림의 "🤖 AI로 원인 분석" 버튼**: 봇이 알림을 보내도록 설정하면(아래 "알림 채널"), 장애 알림에 버튼이 달립니다. 누르면 버튼이 "○○님이 AI 분석을 요청했어요"로 바뀌고, 알림 스레드에 원인 · 확인 순서 · 조치 방법이 달립니다. 알림 1건당 분석은 한 번만 합니다. 복구 알림에는 버튼이 없습니다.
- 동시에 2건까지만 답하고 나머지는 차례를 기다립니다. Steampipe 연결 풀을 보호하기 위해서입니다.
- 토큰이 SSM에 없으면 봇은 꺼진 채로 있고, 대시보드는 평소처럼 동작합니다.
- **프로덕션 서버(`npm run start`)에서만 연결합니다.** 노트북에서 `npm run dev`를 띄워도 연결하지 않습니다. 연결이 두 개 생기면 Slack이 멘션을 나눠 보내기 때문입니다.
- 서버 기동 직후 SSM이나 네트워크가 준비되지 않아 실패하면 30초~10분 간격으로 5번 다시 시도합니다. 토큰이 틀리면(`invalid_auth`) 바로 멈춥니다.

## 누가 물어볼 수 있나요

봇은 Cognito 로그인을 거치지 않으므로 대시보드와 같은 정보(비용, IAM, 리소스 목록)를 Slack에 보여 줍니다.
- **다른 워크스페이스 사람**(Slack Connect 공유 채널)의 멘션은 무시합니다.
- **채널 제한(권장)**: `data/config.json`에 `"slackAllowedChannelIds": ["C0123ABCD"]`를 넣으면 그 채널에서만 답합니다. 다른 채널에서는 "이 채널에서는 물어볼 수 없어요"라고 안내합니다. 값을 비우거나 지우면 봇이 초대된 모든 채널에서 답합니다. 재시작은 필요 없고 1분 안에 반영됩니다.
  - 채널 ID 찾기: Slack에서 채널 이름 클릭 → 맨 아래 "채널 ID".

## 알림 채널 (버튼 달린 헬스 알림)

`data/config.json`에 `"slackAlertChannelId": "C0123ABCD"`를 넣으면, 서버 안 헬스 모니터가 웹훅 대신 봇으로 그 채널에 알림을 보냅니다.
- 봇을 그 채널에 초대해야 합니다(`/invite @AWSops`). 초대하지 않으면 `not_in_channel`이 나고, 그 알림은 웹훅으로 대신 보냅니다.
- 봇이 꺼져 있거나 보내기에 실패하면 지금처럼 웹훅으로 보냅니다. 그래서 알림이 끊기지 않습니다.
- 채널 ID 찾기: 그 채널에서 `@AWSops 안녕`처럼 한 번 부르면 서버 로그에 `[slack-chatops] mention in channel C...`가 남습니다.
- 대시보드 홈의 "테스트 알림" 버튼도 봇으로 보내고 버튼을 답니다. 버튼 동작을 확인할 때 쓰면 됩니다.
- EC2 자체가 꺼진 알림은 서버 밖 워치독 Lambda가 웹훅으로 보냅니다. 서버가 꺼져 있으면 AI도 분석할 수 없으므로 버튼이 없습니다.
- Slack 앱의 **Interactivity & Shortcuts**가 켜져 있어야 버튼 클릭이 들어옵니다. 매니페스트로 새로 만들면 켜져 있습니다. 이미 만든 앱은 화면에서 직접 켜세요. Request URL은 비워 둡니다.

## Slack 제어 (2단계 승인으로 EC2 켜기·끄기·재부팅)

```
팀원 A: @AWSops k8s-practice 꺼줘
AWSops: 🛠 AWS 제어 요청 — 끄기 (정지) · k8s-practice (i-...) · 요청자 A
        1단계: [✅ 맞아요, 승인 요청] [취소]        ← A만 누를 수 있음
        2단계: [✅ 최종 승인] [❌ 거절]              ← 승인자 중 A가 아닌 사람, "정말 실행할까요?" 한 번 더
        ✅ 실행 완료 — 승인: B · 상태: running → stopping
```

- 명령은 AI가 아니라 규칙으로 해석합니다(꺼줘/켜줘/재시작/stop/start/reboot). "켜진 서버 뭐 있어?" 같은 질문은 평소처럼 AI가 답합니다.
- **제어 대상**: 태그 `awsops:control=allow`가 붙은 EC2만 제어할 수 있습니다. 이 조건은 IAM 권한 자체에 걸려 있어서, 태그가 없는 다른 팀 서버는 AWS가 거부합니다.
  - 태그 붙이기: `aws ec2 create-tags --resources i-xxxx --tags Key=awsops:control,Value=allow`
- **승인자**: `data/config.json`에 `"slackControl": {"approverIds": ["U0..."]}`를 넣습니다. 비어 있으면 기능이 꺼집니다. Slack 사용자 ID는 프로필 → ⋮ → "멤버 ID 복사"에서 찾습니다.
  - 혼자 테스트할 때만 `"allowSelfApproval": true`를 넣습니다(기본값은 false라 요청자 본인은 승인할 수 없습니다).
  - `"requestTtlMinutes"`의 기본값은 15입니다.
- **처음 한 번**: 관리자 Mac에서 `bash scripts/16-setup-slack-control.sh`를 실행합니다(제어 전용 IAM 역할을 만듭니다).
- **기록**: `data/slack-control/audit.jsonl`에 남고, CloudTrail에는 `SourceIdentity=slack-<승인자ID>`로 남습니다.
- 서버를 재시작하면 승인 대기 중인 요청은 사라집니다. 다시 요청하면 됩니다.

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
| 알림 버튼을 눌러도 반응 없음 / 느낌표 | Slack 앱 **Interactivity & Shortcuts** 켜기 |
| 알림이 여전히 버튼 없이 옴 | `slackAlertChannelId` 설정, 봇 채널 초대, 로그의 `[health] Slack bot post failed (...)` 확인 |
| 후속 질문에 맥락이 없음 | 매니페스트의 `channels:history`/`groups:history` 권한 확인 후 앱 재설치 |

- 봇 끄기: SSM 파라미터 2개 삭제 후 재시작, 또는 환경 변수 `SLACK_CHATOPS_DISABLED=1`.
- 토큰은 SSM에만 저장하고 로그·채팅·코드에 남기지 않습니다.

## 알려진 한계

- 답은 대시보드 AI와 같습니다. 대시보드에서 할 수 없는 일은 Slack에서도 할 수 없습니다.
- 버튼 분석은 클릭 시점의 상태를 봅니다. 이미 복구된 뒤에 누르면 "지금은 정상"이라고 답할 수 있습니다.
