# 장애 원인 분석 ("고장 나기 전에 뭐가 바뀌었지?") — 설계

> 상태: 기본안으로 진행. 사용자는 기본안과 평가 방식 변경(LocalStack 대신 재현 시험 + 마지막에 실제 훈련 1회)에 동의했다. 아래 "내 판단"은 모두 빌더(나)의 결정이다.
> 빌더 검토 반영: 그래프 합치기, 관련 신호 합치기, 지워진 리소스 분석, 알람 키, 평가 관문, Slack 버튼 없음, 분석 큐 — 모두 내 판단.
> 관련: ADR-012 (의존성 그래프), 변경 기록(`src/lib/change-timeline`), 신규 ADR-013 (점수 기반 순위 + 근거 인용 검증)

## 1. 왜 만드나

장애가 나면 가장 먼저 묻는 질문은 "직전에 누가 뭘 바꿨지?"다. 지금은 CloudTrail 콘솔을 열고 시간대를 맞추고, 그 변경이 고장 난 리소스와 관련이 있는지 머릿속으로 따져야 한다.

이 기능은 그 과정을 자동으로 한다.
1. 이상을 감지한다. 로드밸런서 5xx 급증, 대상 그룹의 비정상 대상, CloudWatch 알람, EC2 상태 검사 실패를 본다.
2. 직전 60분의 CloudTrail **쓰기 이벤트**를 가져온다.
3. 각 변경에 **시간 근접도 × 의존성 그래프 거리 × 변경 종류**로 점수를 매겨 용의자 순위를 만든다.
4. 상위 용의자만 근거 묶음(약 4~8k 토큰)으로 만들어 AI에게 설명을 시킨다. 답변에 이벤트 ID를 반드시 인용하게 하고, **번들에 없는 ID를 인용하면 코드가 그 원인을 버린다.**
5. 화면(`/root-cause`)과 Slack에 보여 준다.

선행 연구(Microsoft RCACopilot)도 "규칙으로 근거를 모으고 LLM은 근거 안에서만 설명"하는 구조다. 단, 그 논문의 수치는 다른 과제(원인 종류 분류)라서 우리 성능 주장에 쓰지 않는다. 우리 성능은 아래 7장의 재현 시험으로 직접 잰다.

### 목표
- 이상 감지 루프: 5분마다, 프로덕션에서만
- 수동 분석: 화면에서 리소스와 시각을 골라 "분석", Slack에서 `@AWSops 왜 고장났어 <리소스>`
- 용의자 순위: 결정적(같은 입력이면 같은 순위), 점수 구성(시간·거리·종류)을 화면에 보여 준다
- AI 설명: 이벤트 ID 인용 강제 + 인용 검증
- 그래프 시점 보정: 장애 **직전** 그래프로 거리를 잰다
- 재현 시험(평가): 시나리오 24개 이상, 1위 적중률과 3위 안 적중률을 테스트가 매번 계산
- ADR-013

### 하지 않는 것
- **AWS를 바꾸지 않는다.** 감지·조회·설명만 한다. 되돌리기 버튼도 없다(되돌리기는 ① 안전한 AI 실행의 몫이다).
- 로그 분석(Drain 템플릿 압축)은 이번 범위 밖이다. 샌드박스에 쓸 만한 애플리케이션 로그가 아직 없다(RDS PostgreSQL 로그만 있음). 2단계로 미룬다.
- ECS·EKS·Route 53·NACL·라우팅 테이블 같은 그래프 밖(15종 밖) 리소스의 거리는 계산하지 못한다. 그런 변경도 목록에는 나오지만 "그래프에 없음" 가중치를 받는다.
- 실제 훈련(시험용 서버와 보안그룹을 만들고 일부러 망가뜨리기)은 이번 구현에 포함하지 않는다. AWS 리소스를 만드는 일이라 구현이 끝난 뒤 사용자 승인을 따로 받는다.

### 반대 목표 (기술적으로는 돌아가도 실패인 것)
- **AI가 지어낸 원인을 사실처럼 보여 주는 것.** 근거에 없는 이벤트 ID는 버리고, 유효한 인용이 하나도 없으면 AI 설명을 숨기고 점수 순위만 보여 준다.
- **알림 폭탄.** 같은 리소스·같은 종류의 이상은 60분 안에 하나의 사건으로 묶는다. 자동 Slack 알림은 사건당 한 번.
- **CloudTrail 호출 한도를 빼앗는 것.** 모든 호출은 `cloudTrailSlot`(계정·리전당 초당 1회, 변경 기록·비용 레이더와 공유)을 거친다.
- **민감 정보를 AI나 로그로 보내는 것.** 소스 IP, 자격 증명, 비밀번호·토큰 류 파라미터는 근거 묶음에서 뺀다. 로그에는 오류 이름만 남긴다.
- **돈이 새는 것.** 자동 감지는 CloudWatch `GetMetricData` 비용이 든다(아래 2장). 설정으로 끌 수 있어야 한다.

## 2. 내 판단 (기본값)

### 이름
- 모듈 `src/lib/root-cause/`, 화면 `/root-cause` (사이드바 "모니터링" 묶음, 이름 "장애 원인 분석"), API `/api/root-cause`.
- AI 등록표의 기존 `incident` 라우트(자동 수집 에이전트)와 헷갈리지 않게 `incident`라는 이름은 쓰지 않는다. 화면 안에서 한 건은 "사건"이라고 부른다.

### 이상 감지 (신호 4종)
샌드박스에는 CloudWatch 알람이 0개라서, 알람에만 기대지 않고 로드밸런서 수치를 직접 본다.

| 신호 | 출처 | 이상 조건 |
|------|------|-----------|
| `alb-5xx` | `AWS/ApplicationELB` `HTTPCode_ELB_5XX_Count` + `HTTPCode_Target_5XX_Count` (LoadBalancer 차원, 1분, Sum) | 최근 5분 합 ≥ 10 **그리고** 최근 5분 합 > 3 × max(1, 직전 60분의 5분당 평균) |
| `tg-unhealthy` | `AWS/ApplicationELB` `UnHealthyHostCount` (TargetGroup+LoadBalancer 차원, 1분, Maximum) | 최근 5분 최댓값 ≥ 1 **그리고** 직전 30분 최댓값 = 0 |
| `ec2-status` | `AWS/EC2` `StatusCheckFailed` (InstanceId, 1분, Maximum) | 최근 5분 최댓값 ≥ 1 **그리고** 직전 30분 최댓값 = 0 |
| `alarm` | `DescribeAlarms` StateValue=ALARM | 알람이 ALARM이고 `StateUpdatedTimestamp`가 최근 15분 안 |

- **장애 시작 시각**은 조건을 처음 넘은 1분 칸의 시각이다. 알람은 `StateUpdatedTimestamp`.
- 알람의 리소스는 알람 차원(InstanceId, LoadBalancer, TargetGroup, DBInstanceIdentifier, FunctionName)으로 그래프 노드를 찾는다. 못 찾으면 리소스 없이 "계정 전체" 사건이 된다.
- 감시 대상 목록(ALB, 대상 그룹, 실행 중인 EC2)은 **현재 의존성 그래프에서** 가져온다. 그래프가 아직 없으면 그 tick은 건너뛴다.
- 한 tick에 계정당 `GetMetricData` 1~2회(쿼리 최대 500개)로 묶는다. 리전은 계정 설정의 리전 하나.
- **비용**: 지금 샌드박스 규모(ALB 3, 대상 그룹 5, EC2 11)면 지표 약 22개 × 하루 288회 × 30일 ≈ 19만 지표/월 ≈ 월 2달러. 설정 `rootCause.autoDetect: false`로 끌 수 있고, 꺼도 수동 분석은 된다. 기본값은 켜짐.

### 사건 묶기
- 키: `(accountId, resourceArn, signal)`. 리소스가 없는 알람은 `resourceArn` 자리에 `alarm:<알람 ARN>`을 쓴다. 같은 키의 열린 사건이 있고 마지막 감지가 60분 안이면 새 사건을 만들지 않고 `lastSeenAt`만 늘린다.
- **관련 신호 합치기**: 같은 계정의 열린 사건(마지막 감지 60분 안) 중, 새 신호의 리소스가 그 사건 리소스에서 2단계 안(아래 "거리"와 같은 규칙)이면 새 사건을 만들지 않고 그 사건의 `signals[]`에 붙인다. 보안그룹 하나가 깨져서 ALB 5xx·대상 그룹 비정상·EC2 상태 검사가 함께 울려도 사건·AI 호출·Slack 알림은 하나다.
- 신호가 30분 동안 다시 안 잡히면 사건을 `resolved`로 닫는다(표시용, 알림 없음).
- 자동 분석은 사건이 처음 생길 때 한 번. 화면의 "다시 분석"은 30초에 한 번(프로세스 전체).
  - **변경(2026-10-29 최종 검토 판정):** 자동 분석은 사건을 만들 때가 아니라 **시작 10분 뒤 이후의 tick**에서 돈다(CloudTrail 이벤트가 약 5분 늦게 와서 감지 직후 분석하면 가장 유력한 원인을 놓친다). 실패하면 다음 tick에서 최대 3번(`analysisAttempts`), 세 번째도 실패하면 분석 없이 알림을 보낸다. 사건 하나에 알림은 여전히 최대 하나. 재시작한 프로세스도 남은 사건을 이어 받는다.
- 분석은 프로세스 전체에서 **한 번에 하나씩**(하나의 promise 체인 큐) 돈다. CloudTrail 호출 칸을 변경 기록 수집과 나눠 쓰기 때문이다.

### 변경 이벤트 가져오기
- 창: `[시작 − 60분, 시작 + 5분]`. 시작 뒤 5분까지 넣는 이유는 CloudTrail 기록 시각이 실제 변경보다 늦게 찍히는 경우가 있어서다.
- `LookupEvents`에 `LookupAttributes: [{ReadOnly: 'false'}]`를 써서 쓰기 이벤트만 받는다. 페이지당 50개, 리전당 최대 10페이지(500개 — 샌드박스는 시간당 약 126개). 넘치면 `truncated`로 표시한다.
- 리전: 사건 리전 + `us-east-1`(IAM·CloudFront 같은 전역 서비스). 계정: 사건 계정만. 다른 계정은 `accountCredentials`로 AssumeRole.
- 버리는 것:
  - 실패한 호출(`errorCode` 있음) — 아무것도 안 바뀌었다.
  - 잡음 이벤트 목록: `UpdateInstanceInformation`, `CreateLogStream`, `PutLogEvents`, `CreateLogGroup`, `Token_POST`, `CognitoAuthentication`, `InitiateAuth`, `RespondToAuthChallenge`, `AssumeRole`, `AssumeRoleWithWebIdentity`, `GetSessionToken`, `ConsoleLogin`, `StartSession`, `ResumeSession`, `TerminateSession`, `SendCommand`(SSM, AWSops 배포·점검이 대부분), `PutMetricData`, `CreateGrant`, `RetireGrant`, `GenerateDataKey`, `Decrypt`, `Encrypt`. 샌드박스 24시간 쓰기 이벤트의 99% 이상이 이 목록이었다.
- 남기는 것: 나머지 전부. AWSops 자신의 변경(① 안전한 AI 실행)도 남긴다 — 그것도 원인일 수 있다.
- 행위자·도구는 변경 기록의 `classifyActor`, `detectTool`을 그대로 쓴다.

### 이벤트 → 리소스 찾기
`requestParameters`, `responseElements`, `resources[]`를 훑어서 그래프 노드 후보를 만든다. 키 → 노드 종류 표:

| 키 (깊이 무관, 배열 안 포함) | 노드 종류 |
|-----|-----|
| `groupId`, `groupIds[]`, `securityGroupIds[]`, `securityGroups[]`(sg- 접두) | sg |
| `instanceId`, `instancesSet.items[].instanceId` | instance |
| `networkInterfaceId` | eni |
| `subnetId`, `subnetIds[]` | subnet |
| `vpcId` | vpc |
| `allocationId` | eip |
| `natGatewayId` | nat |
| `volumeId` | ebs |
| `loadBalancerArn`, `listenerArn`, `ruleArn` (→ 그 로드밸런서) | lb |
| `targetGroupArn` | tg |
| `dBInstanceIdentifier` | rds |
| `functionName` (이름 또는 ARN) | lambda |
| `roleName`, `roleArn` | role |
| `bucketName` | s3 |
| `id` + eventSource `cloudfront.amazonaws.com`, `distributionId` | cloudfront |
| `resources[].ARN` | ARN으로 바로 |

- `listenerArn`/`ruleArn`은 ARN 안의 `app/<name>/<id>` 부분으로 로드밸런서 ARN을 만든다.
- 노드 찾기는 **같은 계정 안에서만** 한다(`nodeById`는 계정을 안 가리므로 `data().nodes`에서 직접 찾는다). ARN이 있으면 ARN을 먼저 쓴다.
- 하나도 못 찾으면 "그래프에 없음" 용의자로 남는다.

### 그래프 시점 보정
- 의존성 그래프 빌드가 끝날 때마다 `data/graph/history/<builtAt>.json`(같은 `{version:1, stats, data}` 형식)을 하나 더 쓰고, 최근 12개(약 3시간)만 남긴다.
- 분석은 **합친 그래프**를 쓴다: `builtAt`이 `[창 시작, 장애 시작]` 안인 스냅샷 전부 + 창 시작 직전의 스냅샷 1개를 합친다(노드는 ARN으로, 간선은 `(src,dst,type)`로 중복 제거). 하나도 없으면 현재 그래프.
- 이유: 누가 14:50에 보안그룹을 떼어 내고 14:55에 그래프가 다시 만들어지면, 14:55 그래프에는 이미 그 연결이 없다. 변경 **전** 그래프가 들어가야 거리가 잡힌다. 합치면 사라진 연결이 남아 있어 조금 가깝게 보일 수 있지만, 놓치는 것보다 낫다.
- 어떤 스냅샷들을 합쳤는지(가장 이른·늦은 `builtAt`, 개수) 사건에 저장하고 화면에 "그래프 기준: 14:00~14:45 (4개)"로 보여 준다.
- 이력 파일은 디스크에 있으므로 서버를 재시작해도 남는다.

### 거리
- 장애 리소스에서 용의자 리소스까지 **방향 무시 BFS**, 최대 4단계.
- 중간 경유 금지 노드: `vpc`, `subnet`, 그리고 연결(들어오고 나가는 간선 합)이 15개를 넘는 노드. 끝점으로는 괜찮다. 같은 VPC나 큰 공용 역할을 거쳐 모든 것이 2단계가 되는 것을 막는다.
- 용의자 리소스가 여럿이면 가장 가까운 것을 쓴다. 그 경로를 "mo(ALB) → tg-a → i-b → sg-c"처럼 저장한다.
- 장애 리소스가 없는 사건(계정 전체 알람)은 모든 용의자에 거리 "모름"을 준다.

### 점수
`score = 시간 × 거리 × 종류` (모두 0~1), 높은 순. 같으면 장애 시작에 더 가까운 것, 그다음 eventId 순.

- **시간**: 시작 전 Δ분이면 `exp(−Δ/20)` (0분 1.0, 20분 0.37, 60분 0.05). 시작 뒤(최대 5분)는 0.3.
- **거리**: 0단계 1.0, 1단계 0.85, 2단계 0.65, 3단계 0.45, 4단계 0.3, 연결 안 됨 0.08, 그래프에 없음 0.12, 사건에 리소스 없음 0.5.
- **종류** (이벤트 이름 앞부분):
  - 1.0: `Revoke`, `Delete`, `Detach`, `Disassociate`, `Deregister`, `Remove`, `Replace`, `Stop`, `Terminate`, `Reboot`
  - 0.8: `Modify`, `Update`, `Put`, `Set`, `Change`, `Attach`, `Associate`, `Register`, `Authorize`, `Apply`, `Enable`, `Disable`, `Reset`
  - 0.5: `Create`, `Run`, `Start`, `Import`, `Copy`
  - 0.1: `CreateTags`, `DeleteTags`, `TagResource`, `UntagResource`, `AddTags`, `RemoveTags`, `TagRole`, `UntagRole`
  - 그 밖: 0.6
- 화면과 근거 묶음에 세 값을 모두 보여 준다. AI가 순위를 바꾸지 않는다 — AI는 상위 용의자를 **설명**만 한다.

### 근거 묶음과 AI 설명
- 상위 8개 용의자. 각각: eventId, 시각(시작 몇 분 전), 이벤트 이름, 행위자 이름·도구, 리소스, 그래프 경로, 점수 세 값, 요청 파라미터 요약(JSON, 600자 자름).
- 빼는 것: `sourceIPAddress`, `userAgent` 원문, 액세스 키 ID, 이름에 `password|secret|token|credential|privatekey`가 들어간 파라미터(대소문자 무시) — 값을 `"[숨김]"`으로 바꾼다.
- 사건 정보: 신호, 리소스, 시작 시각, 수치 요약(예: "5분 5xx 312건, 평소 2건").
- 전체 상한 24,000자(약 6~8k 토큰). 넘치면 아래 순위부터 파라미터를 줄이고, 그래도 넘치면 용의자를 줄인다.
- 모델: `getBedrockModelId()`, `invokeText`, `maxTokens: 1200`. 출력은 JSON 하나:
  ```json
  { "summary": "한두 문장", "causes": [{ "eventId": "…", "reason": "…", "confidence": "high|medium|low" }], "checks": ["확인할 것", "…"] }
  ```
- 검증: 첫 `{`부터 마지막 `}`까지 파싱한다. `causes` 중 eventId가 묶음에 없는 것은 버리고 버린 개수를 기록한다. 유효한 cause가 0개면 AI 설명 전체를 숨기고(`ai.status = 'unverified'`) 점수 순위만 보여 준다. 파싱 실패·호출 실패도 같다(`'failed'`). AI가 실패해도 사건과 순위는 남는다.
- 사용량은 `recordAndSave`로 라우트 `root-cause`에 기록한다.

### 저장
- `data/root-cause/incidents.json` — 최근 200건, 임시 파일 + rename. 쓰기는 하나의 체인으로 직렬화. 깨진 파일은 `.corrupt-<ts>`로 옮긴다(변경 기록 저장소와 같은 방식).
- 사건 안에 용의자 순위 전체(최대 50개)와 AI 결과를 같이 저장한다. 나중에 CloudTrail이나 그래프가 바뀌어도 그때의 판단을 그대로 볼 수 있다.

### API (`/api/root-cause`)
- `GET ?op=list[&accountId=]` — 최근 사건 목록(최대 50).
- `GET ?op=get&id=` — 사건 하나.
- `POST {op:'analyze', accountId, resourceArn?, at?}` — 수동 분석. `at` 없으면 지금(지난 7일 안만 허용). `resourceArn`은 현재 그래프 **또는 이력 스냅샷**에 있어야 한다(지워진 리소스도 분석할 수 있게). 어디에도 없으면 404. 30초 제한에 걸리면 429. 동기로 끝까지 기다렸다가(최대 120초) 사건을 돌려준다. AWS를 읽기만 하지만 Bedrock 비용이 들어서 POST로 둔다.
- `force-dynamic`, `Cache-Control: no-store`, 500은 오류 이름만.

### 화면 (`/root-cause`)
- 왼쪽: 사건 목록(신호 아이콘, 리소스, 시작 시각, 상태, 1위 용의자 한 줄).
- 오른쪽 상세:
  - 사건 카드: 신호, 리소스, 시작 시각, 수치, 그래프 기준 시각.
  - AI 설명(검증된 경우만): 요약 + 원인마다 인용한 이벤트 칩(누르면 그 용의자 줄로 이동). "AI 설명은 아래 근거 안에서만 만들어져요" 문구.
  - 용의자 표: 순위, 시각(몇 분 전), 이벤트, 누가(도구), 리소스, 경로, 점수와 세 값 막대.
  - 타임라인: 시작 −60분 ~ +5분 가로축에 용의자 점, 시작 시각 세로선 (Recharts).
- 위쪽: "직접 분석" — 리소스 검색(`/api/graph?op=search` 재사용), 시각(기본 지금), 분석 버튼.
- 자동 감지가 꺼져 있으면 안내 배너.

### Slack
- 자동 사건이 새로 생기고 분석이 끝나면 한 번 보낸다: 봇의 알림 채널(`postAlertViaBot`) 우선, 안 되면 헬스 알림 웹훅.
  - 예: "🔎 장애 감지: mo(ALB) 5xx 급증 (15:02부터). 의심 1위: 14:50 kim님이 sg-0ab… 인바운드 규칙 삭제 (콘솔). 자세히: <appUrl>/root-cause?id=…"
  - `appUrl`이 없으면 링크 줄을 뺀다.
  - 기존 헬스 알림의 "AI로 원인 분석" 버튼은 **붙이지 않는다**. 근거 없이 자유롭게 답하는 AI가 인용 검증된 결과 위에 덧붙는 것을 막는다.
- 질문: `@AWSops 왜 고장났어 <리소스 ID 또는 이름>` / "원인", "뭐가 바뀌었" 같은 표현 + 리소스. 규칙으로 감지(LLM 안 씀), `handleMention`의 `tryRcaQuestion` 훅. 리소스를 못 찾으면 false를 돌려 AI로 넘긴다. 찾으면 수동 분석 후 스레드에 답한다.

### 설정 (`data/config.json`, 선택)
```json
"rootCause": { "autoDetect": true, "slackAlerts": true }
```
없으면 둘 다 true.

## 3. 평가 (재현 시험)

LocalStack 무료판은 CloudTrail 조회를 지원하지 않고, 그래프는 실제 AWS를 읽는 Steampipe에서 나온다. 그래서 평가는 **가짜 상황 데이터**로 한다.

- `src/lib/root-cause/eval/scenarios.ts`: 시나리오 24개 이상. 각 시나리오는 작은 그래프(`GraphData`), 사건(신호·리소스·시작 시각), CloudTrail 원본 모양의 이벤트 목록, 정답 eventId를 가진다.
- 시나리오 종류(각 2개 이상): 보안그룹 인바운드 삭제, 대상 그룹에서 서버 빼기, 서버 정지, 리스너 규칙 변경, Lambda 설정 변경, IAM 역할 정책 떼기, RDS 설정 변경, 보안그룹을 ENI에서 바꿔 끼우기(그래프에서 이미 사라진 연결 — 직전 스냅샷이 필요한 경우), 잡음만 많은 경우.
- 함정을 꼭 넣는다: 정답보다 시간상 더 가까운 무관한 변경, 같은 VPC의 다른 리소스 변경, 태그 변경, 실패한 호출, 잡음 이벤트.
- **알려진 한계 시나리오**(정답이 15종 밖, 예: 라우팅 테이블 변경)는 따로 표시해 점수에 넣지 않고 결과만 보고한다.
- 각 시나리오는 그래프 이력(`graphs: {builtAt, data}[]`)을 가진다. 연결이 사라진 경우를 재현하려면 변경 전·후 스냅샷을 둘 다 넣는다.
- `__tests__/eval.test.ts`: 전체 파이프라인(이벤트 파싱 → 리소스 찾기 → 그래프 합치기 → 거리 → 점수)을 돌려 1위 적중률과 3위 안 적중률을 계산한다. 기준: **1위 ≥ 0.75, 3위 안 ≥ 0.9**. `npm test`에서 실패하는 진짜 관문이다. 결과 표를 콘솔에 찍는다.
- 첫 정직한 실행이 기준에 못 미치면 점수식을 **한 번** 손볼 수 있다. 전후 수치를 ADR-013에 적는다. 그래도 못 미치면 기준을 실제 수치로 낮추고 그 사실을 ADR과 보고에 그대로 쓴다.
- 정직성: 시나리오를 만든 뒤에 점수식을 맞추면 과적합이다. 시나리오는 점수식 구현 **전에** 별도 작업으로 쓰고, 이후 점수식을 바꾸면 ADR-013에 그 사실과 전후 수치를 적는다.
- AI 설명은 이 평가에 넣지 않는다(비결정적이고 비용이 든다). 대신 인용 검증 로직을 단위 테스트한다.
- 실제 훈련 1회는 구현 뒤 승인을 받아 한다(1장 "하지 않는 것").

## 4. 빌더에게 남기는 것
- 파일 나누기, 컴포넌트 구조, Recharts 세부, 문구 다듬기.
- GetMetricData 쿼리 id 규칙, 응답 정렬 처리.
- 사이드바 아이콘.

## 5. 문서
- ADR-013: 결정적 점수 순위 + LLM은 설명만 + 인용 검증. 대안(LLM이 직접 순위 매기기, 단순 프롬프팅, 그래프 없이 시간만)과 비교. 재현 시험 결과 수치.
- `src/lib/root-cause/CLAUDE.md`, `src/components/root-cause/CLAUDE.md`, 루트 `CLAUDE.md`(페이지·API·ADR 숫자), `src/lib/CLAUDE.md`, `src/app/CLAUDE.md`, `src/components/CLAUDE.md`, `src/lib/dep-graph/CLAUDE.md`(스냅샷 이력).
