# 변경 기록 (Change Timeline) 설계 — "누가 만들고 누가 지웠지?"

- 작성일: 2026-10-26
- 대상: `SWM-Moyeota/awsops` `main`, 서버 `https://awsops.moyeota.co.kr`
- 승인된 화면 시안: `docs/superpowers/specs/assets/2026-10-26-change-timeline-mockup.html` (**다크 테마로 확정**, 시안 상단 토글의 "다크 (AWSops)")

## 1. 왜 만드는가

팀이 함께 쓰는 샌드박스 계정에서 어느 날 모르는 S3 버킷이 생겼다. 콘솔에서 생성 날짜는 보였지만 **누가 만들었는지는 한눈에 알 수 없어서** 팀원들에게 일일이 물어봐야 했다. 사용자 요청 원문 취지는 **"누가 생성했고 삭제했는지만 있어도 좋을 것 같다"**이다.

팀원마다 IAM 사용자가 따로 있어서(사용자 확인), CloudTrail에는 사람별 이름이 이미 남아 있다. 예를 들어 2026-10-14에 `moyeota-media` 버킷을 `tjdgns9954`가 만든 기록이 실제로 조회된다. 문제는 기록이 없는 게 아니라 **보기가 너무 불편하다는 것**이다. CloudTrail 콘솔에는 하루 약 1,000건의 쓰기 이벤트가 쌓이는데, 대부분이 `UpdateInstanceInformation`(SSM 에이전트), `CreateLogStream` 같은 자동 노이즈다. 그래서 생성·삭제만 골라 보거나 리소스 이름으로 찾기가 어렵다.

## 2. 목표 / 비목표 / 반목표

**목표**
- 연결된 계정들에서 **리소스 생성과 삭제**를 "누가 · 언제 · 무엇을 · 어떤 도구로" 기록하고, 한눈에 보여 준다.
- 같은 기록을 세 곳에서 보여 준다(사용자 결정: 3개 모두).
  - **A. 변경 기록 페이지**
  - **B. 기존 리소스 목록의 "만든 사람"**
  - **C. Slack**
- 오늘부터 AWSops가 기록을 모아 두어, CloudTrail 조회 한계인 90일이 지나도 남게 한다.

**비목표 (이번 범위 밖)**
- 장애와 변경을 엮어 "원인 후보 순위"를 매기는 기능. 원래 1번 아이디어였지만 사용자의 실제 문제가 "누가 했는지 모름"이라 뒤로 미룬다.
- 수정(Modify/Update/Put) 이벤트. 이번에는 생성·삭제만 다룬다. 단, 데이터 구조는 나중에 수정 이벤트를 더할 수 있게 둔다.
- 실시간 알림. CloudTrail 자체가 5~15분 늦게 기록되므로, 수 분 지연은 정상으로 본다.
- 서울(`ap-northeast-2`)과 글로벌 이벤트 리전(`us-east-1`) 밖의 리전.
- AWS를 바꾸는 동작. 이 기능은 조회만 한다.

**반목표 (돌아가도 이렇게 되면 실패)**
- 노이즈(조회 API, 서비스가 자동으로 만든 로그 스트림이나 ENI 등)가 섞여 진짜 사람이 한 변경이 묻힌다.
- CloudTrail 조회 한도를 넘겨 비용 레이더의 생성자 조회까지 같이 실패한다.
- 대시보드가 느려지거나 Steampipe 연결 풀(`max 10`)을 잡아먹는다.
- 화면이 시안과 달리 표만 가득한 CloudTrail 콘솔처럼 된다.

## 3. 사용자 결정 사항

- **보여 주는 곳 3개 모두**: A 변경 기록 페이지, B 리소스 목록의 "만든 사람", C Slack(묻기 + 매일 아침 요약).
- **디자인: 토스 스타일 · 다크 테마** (시안 그대로).
  - **문장으로 보여 준다**: "**sungyoon**님이 S3 버킷을 만들었어요" / "… 지웠어요". 아래 줄에는 `[생성]`/`[삭제]` 태그 · 리소스 이름 · 도구 · 시각이 온다.
  - **맨 위 요약 문장**: "이번 주에 4개가 생기고 1개가 사라졌어요"와 숫자 카드 3개(생성 · 삭제 · 작업한 사람 수).
  - **목록 모양**: 둥근 칩 필터(전체/생성/삭제/사람별/서비스별), 검색칸("리소스 이름으로 찾기"), 날짜 머리("오늘 · 10월 26일"), 동그란 아이콘(생성은 초록, 삭제는 빨강, 자동은 회색 배경) + 서비스 이모지, 오른쪽 `›`.
  - **스타일**: 둥근 카드(반경 24px), 테두리 거의 없음, 넉넉한 여백, 강조색은 파랑 하나(다크 `#4593fc`). 다크 팔레트는 시안의 `:root[data-theme="dark"]` 값을 따른다. 배경 `#0a0e1a`, 카드 `#0f1629`/`#151d30`으로 AWSops 네이비와 같다.
  - **글꼴**: Pretendard(시안과 같음). 이 페이지와 B·C의 새 UI 요소에만 쓰고, 기존 페이지 전체 글꼴은 바꾸지 않는다.
  - **B 모양**: S3 같은 목록에서 이름 옆에 이니셜 아바타와 "**○○**님이 만들었어요 · 10월 26일 · 콘솔"을 보여 준다. 기록이 없으면 "90일보다 오래돼서 기록이 없어요"라고 쓴다.
  - **C 모양**: 답의 첫 줄을 굵게 "🪣 sungyoon님이 만들었어요"로 쓰고, 그 아래에 리소스 · 시각 · 도구를 붙인다. 마지막 줄은 "아직 있어요" 또는 "10월 28일 minsu님이 지웠어요"다. 생성·삭제 기록만 쓰고 수정 이벤트는 쓰지 않는다(내가 정함). 아침 요약은 "☀️ 어제 3개가 생기고 1개가 사라졌어요" 한 줄과 사람별 집계로 보낸다.

## 4. 제약 (확인된 사실)

- **CloudTrail `LookupEvents`**
  - 관리 이벤트를 최근 90일만 조회할 수 있다.
  - 한도는 계정·리전당 초당 2회, 한 번에 최대 50건이다.
  - 조회 조건(`LookupAttributes`)은 한 번에 하나만 줄 수 있다. 예: `EventName=CreateBucket` 또는 `ReadOnly=false`.
  - 대시보드 EC2 역할(`ReadOnlyAccess`)로 호출할 수 있다(확인됨). 대상 계정(Moyeota `369558869056`)은 `AWSopsReadOnlyRole`을 External ID(`config.json`의 `crossAccountExternalId`)로 빌려 조회한다. 이 역할에도 `ReadOnlyAccess`가 붙어 있다. 기존 `src/lib/cost-radar/creators.ts`가 같은 방식으로 이미 조회 중이다.
- **조회 한도를 비용 레이더와 나눠 쓴다**: `creators.ts`는 계정마다 큐를 두고 1초 간격으로 호출한다. 새 수집기와 합쳐서 계정·리전당 초당 2회를 넘으면 안 된다. 계정별 CloudTrail 호출 간격 조절을 한 곳에서 공유하는 것이 바람직하다(어떻게 할지는 빌더가 정한다).
- **이벤트가 기록되는 리전**: S3·EC2·RDS 등은 리소스가 있는 리전(서울)에, IAM 같은 글로벌 서비스는 `us-east-1`에 남는다.
- **"누가"를 구하는 규칙** (`userIdentity`). 최근 90일의 실제 생성 이벤트를 확인해 보니 거의 전부 `IAMUser`(sungyoon, tjdgns9954, jiwoo …)였다.
  - **`IAMUser`**: `userName`을 사람으로 쓴다. `invokedBy`가 있어도(예: `cloudformation.amazonaws.com`, `autoscaling.amazonaws.com`) 사람이 남아 있으면 **그 사람을 만든 사람으로 보여 주고**, 도구를 "CloudFormation 통해" / "Auto Scaling 통해"로 쓴다. 실제로 CloudFormation 배포는 대부분 `IAMUser` + `invokedBy: cloudformation`으로 기록된다.
  - **AWS 서비스 역할**: 세션 발급자가 `AWSServiceRoleFor*`인 서비스 연결 역할, 또는 `type`이 `AWSService`인 경우다. "자동"으로 보여 준다(예: "Auto Scaling이 …").
  - **CDK 배포 역할**: 발급자 이름이 `cdk-*-cfn-exec-role-*`인 경우다. 사람 정보가 이벤트에 없으므로 "CloudFormation (CDK)"를 "자동"으로 보여 준다. 90일에 4건 정도로 드물어서 스택 배포자와 연결하는 기능은 이번 범위에서 뺀다(내가 정함).
  - **AWSops 자신의 역할**: `awsops-ec2-role`, `AWSopsLambdaNetworkRole`, `AWSopsSlackControlRole` 등이다. "AWSops"로 보여 준다. `AWSopsSlackControlRole`이면 `SourceIdentity`(`slack-<승인자>`)도 함께 보여 준다.
  - **그 밖의 역할**: SSO(`AWSReservedSSO_*`)면 세션 이름(보통 사용자 이메일)을 사람으로 쓴다. 나머지 역할은 "역할 이름(세션)"을 "자동"으로 보여 준다(내가 정함). 지금 계정들에서는 드물다.
  - **`Root`**: "루트 계정 ⚠️"
  - "자동" 줄은 생성·삭제 숫자에는 넣고, **"작업한 사람" 수와 아침 요약의 사람별 집계에는 넣지 않는다**(시안의 "4 생성 / 3명"과 같은 계산).
- **"도구"를 구하는 규칙** (`userAgent`/`invokedBy`에서 추정): 콘솔, CLI, Terraform, SDK(Python/JS 등), CloudFormation, 기타. 추정이므로 확실하지 않으면 "기타"로 둔다.
- **데이터 저장**: Steampipe가 아니라 CloudTrail API를 직접 호출하고, 결과는 `data/` 아래 JSON 파일에 저장한다. 비용 레이더의 `store.ts`처럼 원자적으로 쓰고, `data/change-timeline/`는 `.gitignore`에 넣는다. 사람이 하는 생성·삭제는 하루 수십 건 규모라 파일로 충분하다.
- **수집 대상 이벤트**: 사람이 실제로 만들고 지우는 리소스 종류를 고정 목록으로 관리한다. 목록에 없는 이벤트는 저장하지 않는다(노이즈 방지). 최소 목록은 다음과 같다(이벤트 이름은 CloudTrail 기준).

  | 종류 | 생성 | 삭제 |
  |---|---|---|
  | S3 버킷 | CreateBucket | DeleteBucket |
  | EC2 인스턴스 | RunInstances | TerminateInstances |
  | EBS 볼륨 | CreateVolume | DeleteVolume |
  | EBS 스냅샷 | CreateSnapshot | DeleteSnapshot |
  | 보안그룹 | CreateSecurityGroup | DeleteSecurityGroup |
  | 탄력적 IP | AllocateAddress | ReleaseAddress |
  | NAT 게이트웨이 | CreateNatGateway | DeleteNatGateway |
  | VPC / 서브넷 | CreateVpc, CreateSubnet | DeleteVpc, DeleteSubnet |
  | 로드밸런서 / 타겟그룹 | CreateLoadBalancer, CreateTargetGroup | DeleteLoadBalancer, DeleteTargetGroup |
  | RDS | CreateDBInstance, CreateDBCluster | DeleteDBInstance, DeleteDBCluster |
  | ElastiCache | CreateCacheCluster, CreateReplicationGroup, CreateServerlessCache | DeleteCacheCluster, DeleteReplicationGroup, DeleteServerlessCache |
  | Lambda | CreateFunction20150331 | DeleteFunction20150331 |
  | ECR 저장소 | CreateRepository | DeleteRepository |
  | ECS 클러스터 / 서비스 | CreateCluster, CreateService | DeleteCluster, DeleteService |
  | EKS 클러스터 | CreateCluster (eks) | DeleteCluster (eks) |
  | DynamoDB 테이블 | CreateTable | DeleteTable |
  | IAM 사용자 / 역할 (us-east-1) | CreateUser, CreateRole | DeleteUser, DeleteRole |

  ECS와 EKS는 이벤트 이름이 같으므로 `eventSource`로 구분한다. 생성 호출이 실패한 이벤트(`errorCode`가 있는 것)는 저장하지 않거나 "실패"로 표시한다. 어느 쪽으로 할지는 빌더가 정한다.
- **리소스 이름**: 이벤트의 `requestParameters`/`responseElements`/`Resources`에서 종류별로 꺼낸다. 예:
  - S3: `bucketName`
  - EC2: `instancesSet`의 `instanceId`, 그리고 `tagSpecificationSet`의 `Name` 태그
  - RDS: `dBInstanceIdentifier`

  `RunInstances`처럼 한 이벤트가 리소스 여러 개를 만들면 리소스마다 한 줄씩 기록한다.
- **앱 규칙(`CLAUDE.md`)**
  - fetch 주소는 `/api/*`
  - 컴포넌트는 default export
  - 새 디렉토리에는 CLAUDE.md
  - i18n 문구는 ko/en/zh 3개 파일 모두에
  - 페이지는 `useAccount()`로 계정 선택을 따른다(All = 합계).
  - 배포는 수동으로 한다(push → 서버에서 `git pull → 03-build-deploy.sh → 09-start-all.sh`). `cdk deploy` 금지.
- **Slack**: 기존 봇(`src/lib/slack-chatops/`)을 쓴다.
  - 멘션 처리 순서는 제어 명령(`tryControl`) → AI다. "누가 만들었어/지웠어" 질문은 AI 앞에서 규칙으로 처리한다(AI 착각 방지, 제어 명령과 같은 방식).
  - 알림 채널은 `config.slackAlertChannelId`, 봇 연결은 `getBotHandle()`(globalThis)로 공유한다.

## 5. 기능 상세

### 5.1 수집기
- **백필**: 처음 실행할 때 계정별로 최근 90일 기록을 채운다. 추적 대상 이벤트 이름마다 `EventName` 조건으로 조회하면 노이즈를 건너뛸 수 있어 빠르다. 중간에 멈춰도 이어서 할 수 있어야 한다.
- **증분**: 이후에는 주기적으로(5~10분, 정확한 값은 빌더가 정한다) 마지막 수집 시각 이후 것만 가져온다. CloudTrail 기록 지연을 고려해 시간 창을 겹치게 잡고, `eventId`로 중복을 없앤다.
- **실행 위치**: 서버 안 백그라운드 루프. 헬스 모니터나 비용 레이더 일별 기록처럼 프로세스당 하나만 돌게 하고(globalThis 싱글턴), 실패해도 다른 기능에 영향이 없게 한다.
- 계정 하나가 실패해도 다른 계정은 계속 수집하고, 실패 사실은 화면에 "일부 계정 기록을 못 가져왔어요"로 알린다.

### 5.2 A. 변경 기록 페이지 (`/changes`)
- 사이드바에서 CloudTrail 근처(모니터링 그룹)에 "변경 기록" 메뉴를 둔다.
- 기간: 기본 최근 7일. 최근 24시간, 30일, 90일, 전체 중에서 고를 수 있다.
- 필터 칩: 전체/생성/삭제, 사람(기간 안에 등장한 사람들), 서비스. 검색은 리소스 이름이나 ID의 부분 일치다.
- 항목을 누르면(`›`) 상세가 열린다: 이벤트 시각(KST) · 사람 · 도구 · 접속 IP · 리전 · 계정 · 리소스 ID와 이름 · AWS 콘솔 바로가기(가능한 종류만) · 같은 리소스의 다른 기록(생성↔삭제).
- 맨 위에는 요약 문장과 숫자 카드를 둔다(§3).
- **상태 표시**: 수집 중(백필 진행률), 마지막 수집 시각, 실패한 계정. 기록이 하나도 없으면 "아직 기록이 없어요"와 이유를 보여 준다.

### 5.3 B. 리소스 목록의 "만든 사람"
- 최소한 **S3, EC2, RDS 페이지**의 목록에 붙인다. 원래 문제가 S3에서 시작됐고, 팀이 가장 많이 쓰는 종류다.
- 리소스 ID나 이름으로 수집된 생성 기록을 찾는다. 없으면 "90일보다 오래돼서 기록이 없어요" 또는 "기록 없음"으로 쓴다.
- 기존 표의 컬럼으로 넣을지, 토스 스타일 한 줄(아바타 + "○○님이 만들었어요")로 넣을지는 페이지 구조에 맞춰 빌더가 정한다. 문구와 아바타 모양은 시안을 따른다.

### 5.4 C. Slack
- **묻기**: "@AWSops `<리소스 이름 또는 ID>` 누가 만들었어?" / "… 누가 지웠어?"에 기록에서 찾아 답한다. "만들/생성/지웠/삭제" + "누가" 같은 규칙으로 알아듣는다.
  - 여러 개가 맞으면 후보를 보여 준다.
  - 없으면 "최근 90일 기록에서 찾지 못했어요"라고 답한다.
- **아침 요약**: 매일 KST 09:00에 알림 채널로 어제(KST 기준 하루) 생성·삭제 요약을 한 번 보낸다.
  - 변경이 0건이면 보내지 않는다.
  - 서버가 재시작되어도 같은 날 두 번 보내지 않는다.
  - 봇이 꺼져 있으면 건너뛴다(웹훅으로는 보내지 않는다).

## 6. 내가 정한 것 (사용자 확인 대상)
- CloudFormation이나 Auto Scaling을 통한 생성이라도 이벤트에 IAM 사용자가 남아 있으면 그 사람을 만든 사람으로 보여 준다. CDK 전용 역할로 만든 것만 "자동"으로 둔다.
- Slack 답의 "이후"는 수정이 아니라 **삭제 여부**만 뜻한다.
- 서비스 역할과 기타 역할은 "자동"이고, 사람 수에서 뺀다. SSO 세션은 사람으로 센다.
- "90일보다 오래돼서" 문구는 리소스 생성 시각이 수집 범위의 시작보다 앞설 때 쓰고, 그 밖의 경우는 "기록 없음"으로 쓴다.

## 7. 빌더에게 맡기는 것
- 저장 파일 구조(일별 또는 계정별 분할 등), 수집 주기, 동시성 처리
- CloudTrail 호출 간격 조절을 비용 레이더와 공유하는 방법
- 이벤트 → 리소스 이름 추출 표의 세부 구현, 콘솔 바로가기 URL 규칙
- 실패한 생성 호출의 처리
- B를 컬럼으로 넣을지 한 줄 표기로 넣을지
- API 모양(`/api/changes` 등), 캐시
- 테스트 방식. 단, 사람·도구 판별, 노이즈 제외, 중복 제거, 이름 추출은 단위 테스트로 지킨다.
