# 상태 점검 + Slack 알림 (Health Alerts) 설계

- 작성일: 2026-10-22
- 대상 브랜치: `feature/sandbox-deploy` (KII1ua/awsops)
- 대상 환경: 샌드박스 계정 116662357283 / ap-northeast-2, EC2 `i-0806bafeb330307d5`, 대시보드 `https://awsops.moyeota.co.kr`

## 1. 왜 만드는가

AWSops는 "고장 나도 겉으로는 멀쩡해 보이는" 구성 요소가 많다. 이번 구축 과정에서 실제로 겪은 일:

- 서버 재부팅 후 Steampipe가 안 떠서 대시보드 수치가 전부 비었는데, 아무도 몰랐다. 검증 스크립트까지 "OK"라고 했다.
- AgentCore 에이전트가 시작 직후 죽고 있었는데, AI는 폴백으로 그럴듯한 답을 계속 내놨다.
- Lambda 도구 19개 중 17개가 import 에러로 죽어 있었다.
- ALB가 (비용 정리 중) 삭제돼서 외부 접속이 막혔는데, 서버 쪽은 전부 정상이었다.

공통점: **사람이 직접 들여다보기 전까지 아무도 모른다.** 이 기능의 목적은 고장이 나면 사람이 먼저 알게 하는 것이다.

사용자(팀)는 비용 때문에 EC2를 자주 직접 끄고 켠다. 이것도 알림 대상이지만, 시끄러우면 안 된다.

## 2. 목표 / 비목표 / 반(反)목표

**목표**
- 아래 고장이 나면 Slack 채널에 알림이 온다.
  1. Steampipe DB가 응답하지 않음
  2. Bedrock 모델 호출 불가 (권한/모델 접근)
  3. AgentCore 런타임이 READY가 아니거나, 호출이 실패함
  4. Lambda 도구가 기동하지 못함 (import 에러 등)
  5. 대시보드가 외부(ALB)에서 정상으로 보이지 않음
  6. EC2 서버가 중지/종료됨, 또는 켜져 있는데 응답이 없음
- 복구되면 복구 알림이 한 번 온다.
- 대시보드 화면에서도 마지막 점검 결과를 볼 수 있다.

**비목표**
- 성능/지연시간 모니터링, 메트릭 그래프, 장기 이력 보관
- 자동 복구(재시작) — 이번 범위는 "알리기"까지. 알림에 실행할 조치를 적어 주는 것까지만 한다.
- Slack 외 채널(이메일 SNS는 기존 기능이 있으므로 건드리지 않음)
- 멀티 어카운트 대상 계정의 상태 점검

**반목표 (기술적으로 동작해도 이렇게 되면 실패)**
- 같은 고장으로 5분마다 알림이 반복됨 → 아무도 안 읽게 된다.
- 비용 때문에 일부러 끈 서버가 꺼져 있는 동안 계속 울림.
- 점검이 Bedrock/AgentCore를 너무 자주 호출해 비용이 눈에 띄게 늘어남.
- 점검 자체가 대시보드를 느리게 만듦 (Steampipe 커넥션 풀 고갈 등).
- Slack Webhook URL이 Git 저장소나 로그에 남음.

## 3. 결정된 사항 (사용자 결정)

- 알림 채널: **Slack** (사용자의 기존 워크스페이스, Incoming Webhook 사용)
- **서버가 꺼진 것도 알린다.** 따라서 서버 밖에도 감시자가 필요하다.
- 상태가 **바뀔 때만** 알린다 (고장 1회, 복구 1회). 일부러 끈 서버도 "중지됨" 1회, "시작됨" 1회만.

## 4. 구조

두 겹으로 감시한다. 꺼진 서버는 스스로 알릴 수 없기 때문이다.

```
① 서버 안 점검 (Next.js 백그라운드, 5분 주기)
   Steampipe · Bedrock · AgentCore · Lambda 19개 · 외부 URL
   └─ 상태 변화 시 Slack 전송, 결과를 메모리/파일에 저장 → /api/health → 화면 카드
   └─ 매 주기 하트비트 기록 (SSM Parameter Store)

② 서버 밖 감시자 (Lambda `awsops-health-watchdog`)
   a. EventBridge 스케줄 5분: EC2 상태 + ALB 타겟 헬스 + ① 하트비트 신선도
   b. EventBridge 규칙: EC2 state-change(stopped/stopping/terminated/running) → 즉시 알림
   └─ 마지막으로 알린 상태를 SSM Parameter Store에 저장해 중복 알림 방지
```

### 4.1 ① 서버 안 점검

- 위치: `src/lib/health-monitor.ts` (신규). 기존 `cache-warmer.ts`와 같은 `setInterval` 패턴.
- 시작 방식: 기존 워머는 "첫 API 요청 시 lazy-init"이라, 재부팅 후 아무도 대시보드를 안 열면 시작되지 않는다(`instrumentation.ts`는 Next 14에서 불안정해 과거 커밋 `9c259fb`에서 제거됨). 헬스 모니터는 **사람이 열기 전에** 돌아야 하므로:
  1. `scripts/09-start-all.sh`가 Next.js 기동 직후 `GET localhost:3000/api/health`를 호출해 시작시킨다.
  2. Next.js를 systemd로 관리하는 환경(`awsops.service` + `13-setup-steampipe-systemd.sh`의 drop-in)에서는 drop-in에 `ExecStartPost`로 같은 curl을 넣어 재부팅·크래시 재시작 때도 시작되게 한다.
  3. `/api/health` 및 기존 lazy-init 지점에서도 `ensureHealthMonitorStarted()`를 호출한다.
  4. 그래도 시작되지 않은 경우는 ②의 하트비트 감시가 잡는다.
- 점검 항목과 방법:

| 항목 | 방법 | 실패 판정 |
|---|---|---|
| steampipe | `steampipe.ts`에 새로 export하는 `pingSteampipe()` — 풀 밖의 단기 클라이언트(기존 `newDiagClient()` 방식: connect 3s, statement 5s)로 `select 1`. `runQuery`는 5분 캐시와 40s 타임아웃 때문에 쓰지 않는다 | 에러/타임아웃 |
| bedrock | `getBedrockModelId()`로 최소 호출(max_tokens 1) | 에러 |
| agentcore-runtime | `get-agent-runtime` 상태 READY 확인 | READY 아님 |
| agentcore-invoke | 4.1의 "AgentCore 호출 실패 보고" 신호 (주기 점검 아님) | 연속 3회 예외 |
| lambda | **명시적 목록**의 도구 Lambda 19개(와일드카드 금지 — watchdog 자신이 걸림)를 `{"tool_name":"__healthcheck__"}` 페이로드로 호출. 동시 실행 4개 이하, 클라이언트 타임아웃 짧게 | 응답 payload의 `errorType`이 `Runtime.ImportModuleError` / `Runtime.HandlerNotFound` / `Runtime.UserCodeSyntaxError` / `Runtime.ExitError` 또는 init 타임아웃일 때만. 400 "Unknown tool", 핸들러 `KeyError`(flow-monitor, reachability)는 **코드가 로드됐다는 뜻이므로 정상** |

- 외부 접속(ALB/DNS/인증서) 점검은 서버 안에서 하지 않는다. 서버가 죽으면 어차피 못 돌고, ②와 알림이 중복되기 때문에 **②가 전담**한다.
- 비용 제약: Bedrock 최소 호출과 Lambda 호출은 비용이 들므로 **5분 주기 중 Bedrock·Lambda 점검은 30분에 한 번**만 한다(나머지 항목은 5분). 이 수치는 빌더가 조정 가능.
- AgentCore "호출 실패"(에이전트가 실제로 500을 내는 경우)는 비용 때문에 주기 점검하지 않는다. 대신 `src/app/api/ai/route.ts`의 **`invokeAgentCore()` 한 곳**(현재 723행 부근)에 훅을 단다. 폴백 지점들(단일/멀티/비스트리밍)에 흩어 달지 않는다 — 그 지점들은 SQL·코드·데이터소스 실패에도 걸리기 때문.
  - 예외(5xx, 권한 거부 등) → 실패 1회. **90초 타임아웃은 실패로 세지 않는다**(도구가 느린 것일 수 있음 — 로그만).
  - 비어 있지 않은 응답 → 성공(연속 실패 카운터 리셋, `agentcore-invoke` 복구).
  - 연속 3회 예외 시 `agentcore-invoke`를 실패로 전환. 멀티 라우트의 병렬 실패는 같은 요청 안에서 1회로 센다.
  - `agentcore-runtime`(READY 점검)과 `agentcore-invoke`는 **별개 항목**이다. READY 성공이 invoke 실패를 복구시키지 않는다(5분마다 빨강/초록 반복 방지).
- 상태 변화 판정: 항목별 `ok → fail`은 **2회 연속 실패** 시 확정(일시적 오류 방지), `fail → ok`는 1회 성공으로 확정.
- 결과 저장: 메모리 + `data/health-status.json` (재시작 후 직전 상태를 알아야 "복구" 판정이 정확함). 임시 파일에 쓴 뒤 rename하는 **원자적 쓰기**. `.gitignore`에 추가.
- 싱글턴: 타이머는 `globalThis.__awsopsHealthMonitor`에 보관해 중복 인스턴스를 막는다.
- AWS 호출: 서버를 멈추게 하는 동기 `awsCli`(`execFileSync`)는 쓰지 않는다. 필요한 SDK 클라이언트(`@aws-sdk/client-lambda`, `client-ssm` 또는 `client-cloudwatch`, `client-bedrock-agentcore-control`)를 추가한다. 실패 원인 문자열을 Slack 메시지에 써야 하므로 에러 메시지를 보존한다.
- 하트비트: 매 주기 CloudWatch 커스텀 메트릭 `AWSops/Health` `Heartbeat=1` 전송. EC2 역할의 기존 `CloudWatchAgentServerPolicy`에 `cloudwatch:PutMetricData`가 이미 있어 **추가 권한이 필요 없다**(SSM PutParameter 방식보다 권한 1개 절약). ②는 최근 15분 메트릭 존재 여부로 판단.

### 4.2 ② 서버 밖 감시자

- Lambda `awsops-health-watchdog` (Python 3.12, VPC 밖), 소스 `agent/lambda/health_watchdog.py`.
- 트리거
  - EventBridge Scheduler/Rule `rate(5 minutes)`
  - EventBridge Rule: `aws.ec2` `EC2 Instance State-change Notification`, 대상 인스턴스 `i-0806bafeb330307d5` 한정
- 판정
  - EC2 `stopping`/`stopped`/`shutting-down`/`terminated` → 하나의 상태 "중지됨"으로 묶어 "🛑 서버 중지됨" 1회.
  - **중지한 사람**: CloudTrail 이벤트 기록 조회(`LookupEvents`)는 5~15분 지연되어 즉시 조회하면 비어 있다. 대신 EventBridge 규칙을 하나 더 둔다 — `detail-type: "AWS API Call via CloudTrail"`, `eventSource: ec2.amazonaws.com`, `eventName: StopInstances/StartInstances/TerminateInstances`, 이 인스턴스 ID 한정. 이 이벤트의 `userIdentity`를 "누가"로 쓴다. OS 안에서 shutdown한 경우 이 이벤트가 없으므로 "누가"는 선택 항목. 이 규칙이 계정의 트레일(`lab-trail`, 관리 이벤트)에 의존하므로 구축 시 1회 실제 중지로 수신을 확인한다.
  - EC2 `running` 전환 → "▶️ 서버 시작됨 — `09-start-all.sh` 실행 필요" 안내.
  - EC2 running인데 하트비트가 15분 이상 갱신 안 됨 → "서버는 켜져 있으나 대시보드 점검이 멈춤 (Next.js 미기동 가능성)". 단, 서버가 시작된 지 15분이 안 됐으면 판정 보류.
  - EC2 running인데 ALB 타겟이 unhealthy/unused → "대시보드 응답 없음". 타겟 그룹은 포트로 고르지 않는다(`moyeota-grafana-tg`도 3000). 로드밸런서 `awsops-alb`에 연결된 타겟 그룹을 **매 실행 조회**한다(이름이 생성형이라 재생성 시 바뀜). `TargetGroupNotFound`/ALB 없음도 실패.
  - **외부 접속 점검**: VPC 밖 Lambda가 `GET https://awsops.moyeota.co.kr/`을 호출해 **Cognito로의 302**를 기대한다. DNS·인증서·리스너·ALB 삭제(실제 사고)를 한 번에 잡는다. 8889(`/vscode`) 타겟도 평소 healthy이므로(user-data가 code-server를 systemd로 등록) 실패 시 알린다.
- 중복 방지: 마지막으로 알린 상태를 SSM Parameter `/awsops/health/watchdog-state`에 저장, 바뀔 때만 전송. SSM은 조건부 쓰기가 없으므로 Lambda **예약 동시성 1**로 경쟁을 막는다.
- 스케줄은 EventBridge Scheduler가 아니라 **EventBridge Rule `rate(5 minutes)`** — Scheduler는 별도 실행 역할이 필요해 IAM 단계가 하나 늘어난다.
- watchdog 역할 권한: `ec2:DescribeInstances`, `elasticloadbalancing:Describe*`, `cloudwatch:GetMetricData`(하트비트), `ssm:GetParameter`(webhook, state), `ssm:PutParameter`(state 파라미터 한정), CloudWatch Logs 기본.
- 서버가 꺼져 있는 동안 ①은 당연히 알림이 없고, ②도 "중지됨" 1회 이후 조용하다.

### 4.3 Slack 전송

- Slack Incoming Webhook 1개. URL은 **SSM Parameter Store SecureString `/awsops/slack-webhook-url`** 에 둔다. ①과 ② 모두 여기서 읽는다(단일 출처). Git, `config.json`, 로그, 셸 히스토리에 남기지 않는다 — `14` 스크립트가 숨김 입력(`read -s`)으로 받아 저장한다.
- 읽기 권한: EC2 역할은 ReadOnlyAccess로 이미 `ssm:GetParameter`가 있고, AWS 관리형 키(`alias/aws/ssm`)의 키 정책이 같은 계정의 SSM 경유 복호화를 허용하므로 `kms:Decrypt` 추가가 필요 없다. 도구 Lambda 역할(`AWSopsLambdaNetworkRole`)은 이 파라미터를 읽을 수 없음을 확인했다(AI 에이전트가 도구로 읽을 수 없음).
- 암호화 키: **AWS 관리형 키 `alias/aws/ssm` (사용자 결정, 2026-10-22).** 같은 계정에서 ReadOnlyAccess를 가진 사람은 읽을 수 있으나, 팀 공용 샌드박스라 수용. 노출 시 영향은 해당 Slack 채널로의 메시지 전송뿐이며, Webhook을 Slack에서 재발급하고 파라미터를 덮어쓰면 복구된다.
- 메시지 형식(Block Kit 또는 단순 텍스트 — 빌더 재량):
  - 제목: `🔴 [AWSops] Steampipe 응답 없음` / `🟢 [AWSops] Steampipe 복구됨`
  - 본문: 실패 원인 한 줄(에러 메시지 요약), 감지 시각(KST), 조치 한 줄(예: `SSM 접속 후 bash scripts/09-start-all.sh`), 대시보드 링크
- 같은 주기에 여러 항목이 동시에 바뀌면 메시지 1개로 묶는다.
- Webhook 미설정 시: 점검은 계속 돌고 화면에도 표시되며, 전송만 건너뛰고 로그에 1회 경고.

### 4.4 화면

- `GET /api/health` → 항목별 `{status: ok|fail|unknown, lastChecked, message}` 와 마지막 Slack 전송 결과.
- AgentCore 페이지 상단 또는 대시보드 홈에 "시스템 상태" 카드 1개(기존 `StatsCard` 사용, 실패 항목 수 표시). 위치는 빌더 재량.
- 위치: **대시보드 홈**(`src/app/page.tsx`)의 기존 경고 영역 근처에 "시스템 상태" 카드. 사람이 가장 먼저 보는 화면이기 때문. 기존 하드코딩된 `"8 GW"` AgentCore 카드 자리를 대체하는 것을 우선 고려(빌더 재량). i18n 키는 en/ko/zh 3개 파일 모두에 추가.
- "테스트 알림 보내기" 버튼: 상태 카드에서 여는 작은 패널에 둔다. `POST /api/health {action:'test'}`는 **관리자만**(`getUserFromRequest` + `adminEmails`, 기존 관리자 라우트와 동일 규칙 — `adminEmails` 미설정 시 로그인 사용자 전원).

## 5. 제약

- **`cdk deploy` 금지.** 기존 스택은 UserData 드리프트 + ALB 드리프트(ALB를 CLI로 재생성) 상태라 배포 시 EC2가 교체될 수 있다. 새 AWS 리소스(Lambda, EventBridge, IAM 역할, SSM 파라미터)는 **CLI 스크립트** `scripts/14-setup-health-alerts.sh`로 만든다(기존 `06c` 방식과 동일). 멱등(재실행 안전)해야 한다.
- EC2 역할(`awsops-ec2-role`)에 새로 필요한 권한은 **`lambda:InvokeFunction` 하나**(도구 Lambda 19개 ARN 명시 나열). 나머지(DescribeTargetHealth, GetParameter, GetAgentRuntime, PutMetricData)는 기존 정책으로 이미 허용됨을 `simulate-principal-policy`로 확인했다. 인라인 정책 `AWSopsHealthMonitor`로 추가. CDK 코드에도 반영해 다음 신규 배포 때 들어가게 한다.
- **`14-setup-health-alerts.sh`는 관리자 권한이 있는 로컬 PC(Mac)에서 실행한다**(`00-deploy-infra.sh`와 같은 위치). EC2에는 생성 권한이 없고 임시로 넓히지 않는다. 이 스크립트가 watchdog Lambda·역할, EventBridge 규칙 3개, SSM 파라미터, EC2 역할의 `AWSopsHealthMonitor` 정책까지 모두 만든다. 실행 전 무엇을 만들지 요약을 보여 주고 확인을 받는다.
- 확인된 사항: 기본 이벤트 버스에 규칙 0개(한도 300), SCP가 Lambda·EventBridge·IAM·SSM·KMS 생성을 막지 않음.
- 참고(범위 밖): 계정 트레일 `lab-trail`의 S3 전송이 2026-09-07부터 `NoSuchBucket`으로 실패 중. 이벤트 기록·EventBridge에는 영향 없음.
- 모든 fetch는 `/api/*`, 컴포넌트는 default export, 다크 테마 색 규칙 등 `CLAUDE.md` 규칙을 따른다.
- 서버 빌드는 수동(push → EC2에서 `git pull` → `03-build-deploy.sh` → `09-start-all.sh`).
- 계정 내 다른 팀 리소스(`moyeota-*`, `k8s-practice`)는 감시 대상이 아니다.

## 6. 빌더에게 맡기는 것

- Slack 메시지의 정확한 문구와 Block Kit 사용 여부
- 주기 수치(5분/30분/15분, 연속 실패 횟수)의 미세 조정
- 상태 카드 위치와 디자인
- `/api/health` 응답 스키마 세부
- 점검 타임아웃 값

## 7. 완료 기준 (실환경 검증)

1. Webhook 설정 후 "테스트 알림" 버튼 → Slack 수신
2. EC2에서 `sudo -u ec2-user steampipe service stop` → 10분 내 🔴 Steampipe 알림, `09-start-all.sh` 후 🟢 복구 알림, 그 사이 중복 알림 없음
3. EC2 중지 → 1분 내 🛑 서버 중지 알림 1회, 이후 30분간 추가 알림 없음. 시작 → ▶️ 알림
4. 서버 시작 후 `09-start-all.sh`를 실행하지 않고 방치 → ② 하트비트 또는 ① Steampipe 알림 중 하나가 옴
5. Lambda 하나를 일부러 깨진 zip으로 교체 → 30분 내 🔴 Lambda 알림 (검증 후 원복)
5-1. ALB 리스너 규칙을 잠시 바꾸거나 DNS 이상을 흉내 내지 않고, watchdog 대상 URL을 존재하지 않는 경로/호스트로 바꿔 1회 실행 → 🔴 외부 접속 알림 (검증 후 원복)
6. 대시보드 화면 상태 카드가 위 상황을 반영
7. Webhook URL이 저장소·`config.json`·서버 로그 어디에도 없음

## 8. 사용자 결정 기록

- 알림 채널 Slack, 서버 중지도 알림, 상태 변화 시에만 알림 (3장)
- Webhook 암호화: AWS 관리형 키 (4.3)

## 9. 설계 시 내린 판단 (빌더/검토 반영, 사용자 확인 권장)

- 외부 접속 점검은 서버 밖 감시자(②)가 전담하고 서버 안(①)에서는 뺐다.
- AgentCore는 "런타임 상태"와 "호출 실패" 두 항목으로 나누고, 90초 타임아웃은 실패로 세지 않는다.
- 하트비트를 SSM 대신 CloudWatch 메트릭으로 바꿔 EC2 역할 권한 추가를 1개로 줄였다.
- 설치 스크립트는 로컬 PC에서 실행한다.
- 상태 카드는 대시보드 홈에, 테스트 버튼은 관리자 전용.
