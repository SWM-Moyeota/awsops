# 비용 레이더 (Cost Radar) 설계

- 작성일: 2026-10-24
- 대상: `SWM-Moyeota/awsops` `main`, 서버 `https://awsops.moyeota.co.kr`
- 범위: 사용자가 고른 기능 **1번(실시간 비용 추정) + 2번(안 쓰는 리소스 정리 추천)**. 4번(Slack에서 AI에게 묻기)은 별도 프로젝트로 뒤에 진행.
- 승인된 화면 시안: `docs/superpowers/specs/assets/2026-10-24-cost-radar-mockup-v2.html`

## 1. 왜 만드는가

팀이 공유하는 샌드박스 계정은 **Cost Explorer가 조직 정책(SCP)으로 막혀 있어** 기존 `/cost` 페이지가 비어 있다. 그 결과 팀원들은 "서버를 꺼야 하나, 지워야 하나"를 감으로 판단했고, 실제로 이번 운영 중에 아무도 모르는 낭비가 쌓였다.

- 고정 IP(EIP) 5개 중 일부는 어디에도 연결되지 않은 채 과금 중이었다.
- ALB를 손으로 지운 뒤 타겟 그룹이 남아 있었다.
- NAT Gateway처럼 EC2를 꺼도 계속 과금되는 리소스를 팀원들이 몰랐다.

사용자 요구(원문 취지): **"금액적으로 비싸게 나올 것 같은 걸 시각적으로 알려주면"** 바로 결정할 수 있다.

## 2. 목표 / 비목표 / 반목표

**목표**
- 지금 켜져 있는 리소스 기준으로 **시간당·이번 달 예상 비용**을 계산해 보여준다(실제 청구액이 아닌 추정임을 명시).
- 비싼 항목일수록 **색과 크기로 눈에 띄게** 보여준다.
- **안 쓰는 리소스와 아낄 수 있는 돈**을 찾아, 항목마다 이유·만든 사람·바로 쓸 수 있는 조치 방법을 보여준다.
- 연결된 모든 계정을 **합쳐서도, 계정별로도** 볼 수 있다(상단 계정 선택과 연동). 계정은 `config.json`의 `alias`로 표시한다(현재 Sandbox=116662357283, Moyeota=369558869056).

**비목표**
- 대시보드에서 리소스를 실제로 끄거나 지우는 기능(사용자 결정: **알려주기까지만**).
- 실제 청구서와 1원 단위로 맞추기.
- 사용량 기반 비용(데이터 전송량, S3 요청·저장량, Lambda 실행, Bedrock 토큰, ALB LCU, NAT 데이터 처리량) 계산.
- Cost Explorer가 열려 있는 계정의 기존 `/cost` 페이지 대체.

**반목표 (돌아가도 이렇게 되면 실패)**
- 추정치를 실제 청구액처럼 보여 사용자가 오판한다.
- 다른 팀이 쓰는 리소스를 "지워도 됨"처럼 단정해서, 클릭 한 번 복사로 사고가 난다.
- 페이지가 느려지거나 Steampipe 조회 부하로 다른 대시보드가 느려진다.
- 화면이 기존 대시보드 스타일과 너무 따로 놀아 다른 앱처럼 보인다(시안 v2의 색과 글꼴은 이 페이지 안에서만 쓴다).

## 3. 사용자 결정 사항

- **화면 스타일: 시안 v2.** 어두운 배경(#0b0b0d / 카드 #17171a), 강조색 라임 #D6F25C · 핑크 #F26DB0 · 보라 #B583F7 · 주황 #F7A23B · 하늘 #8EC5FF, 숫자·제목은 굵은 산세리프(Archivo Black), 포인트는 손글씨체(Caveat), 둥근 알약 모양 카드(반경 22~26px).
  - 왼쪽: 도넛 차트 가운데 이번 달 예상 총액(크게), 지난주 대비 증감 배지, 그 아래 항목 목록(색 원형 아이콘 · 이름 · 부가설명 · 금액 · 비율 · ›).
  - 오른쪽: "아낄 수 있는 돈 월 $X" 제목 + 절약 카드 목록(할 일 · 근거 한 줄 · 절약 금액 크게) + 연말까지 누적 비교 한 줄.
- **계정별로 나눠 보기**: 상단 계정 선택이 All이면 합계, 특정 계정이면 그 계정만.
- **절약 카드는 알려주기까지만**: 누르면 상세 패널(무엇이 왜 낭비인지 · 누가 언제 만들었는지 · 복사용 AWS CLI 명령 · AWS 콘솔 바로가기). 실행 버튼 없음.

## 4. 제약 (확인된 사실)

- **Pricing API 사용 불가**: `pricing:GetProducts`가 서버 역할에 대해 `explicitDeny`(SCP). 가격은 **서울 리전(ap-northeast-2) 온디맨드 가격표를 앱에 JSON으로 내장**한다. 가격표 기준일을 화면에 표시하고, 가격표에 없는 인스턴스 타입은 "가격 정보 없음"으로 표시하고 합계에서 빼며 그 사실을 알린다.
- **가격표 출처 (확인됨)**: AWS **공개 일괄 가격표**(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<서비스>/current/region_index.json` → 서울 리전 파일)는 인증 없이 받을 수 있어 SCP와 무관하다. EC2 서울 파일은 약 200MB(CSV)다. 빌더는 **로컬에서 실행하는 생성 스크립트**(`scripts/tools/build-price-table.*`)로 필요한 SKU만 추출해 작은 JSON(`src/lib/cost-radar/prices.ap-northeast-2.json`, 기준일 포함)을 커밋한다. 런타임에 큰 파일을 받지 않는다.
- **EC2 가격 범위**: 리눅스·Shared tenancy·온디맨드만. Windows/RHEL 등 다른 OS, Dedicated tenancy는 "가격 정보 없음"으로 표시하고 합계에서 제외한다.
- **리전**: Steampipe 연결은 현재 `ap-northeast-2`만 조회한다(확인됨). 다른 리전 리소스가 들어오면 "가격 정보 없음(서울 외 리전)"으로 표시하고 합계에서 제외한다.
- CloudTrail `LookupEvents`는 서버 역할에서 허용됨(최근 90일만 조회 가능). 대상 계정은 읽기 전용 역할(AWSopsReadOnlyRole, External ID는 `config.json`의 `crossAccountExternalId`)을 빌려 조회한다.
- 모든 리소스 조회는 `src/lib/steampipe.ts`를 통한다(Steampipe CLI 금지). 유휴 리소스 SQL은 `src/lib/collectors/idle-scan.ts`의 쿼리를 재사용·공유한다.
- 앱 규칙(`CLAUDE.md`): fetch는 `/api/*`, 컴포넌트 default export, 새 디렉토리엔 CLAUDE.md, i18n은 ko/en/zh 3개 파일 모두, 다크 테마.
- 배포는 수동(push → 서버에서 `git pull → 03-build-deploy.sh → 09-start-all.sh`). `cdk deploy` 금지.

## 5. 기능 상세

### 5.1 비용 추정 대상 (고정 비용만)

| 리소스 | 계산 | 비고 |
|---|---|---|
| EC2 (running) | 인스턴스 타입 시간당 단가 × 730h | 리눅스 온디맨드 기준. 예약/스팟 할인 미반영 |
| EC2 (stopped) | 0 (디스크는 EBS로 계산) | |
| EBS 볼륨 | 유형별 GB-월 단가 × 크기 | gp2/gp3/io1/io2/st1/sc1. gp3·io의 추가 IOPS/처리량은 반영 |
| EBS 스냅샷 | GB-월 단가 × 볼륨 크기 | 증분 크기를 알 수 없어 **상한값**임을 표시 |
| 퍼블릭 IPv4 / EIP | 개당 시간 단가 × 730h | 연결 여부 무관 과금 |
| NAT Gateway | 시간 단가 × 730h | 데이터 처리량 제외 |
| ALB / NLB | 시간 단가 × 730h | LCU/NLCU 제외 |
| VPC 인터페이스 엔드포인트 | 엔드포인트 × AZ 수 × 시간 단가 × 730h | |
| RDS 인스턴스 | 클래스·엔진 시간 단가 × 730h + 스토리지 GB-월 | Multi-AZ면 ×2 |
| ElastiCache 노드 | 노드 타입 시간 단가 × 730h | |

- **이번 달 예상** = 지금 켜진 상태가 한 달 내내 유지된다고 가정한 월 환산액(730h). "시간당"도 함께 표시.
- 화면 하단 고정 문구: "실제 청구액이 아닌 추정입니다. 데이터 전송·요청량 등 사용량 기반 비용은 포함되지 않습니다. 가격표 기준일 YYYY-MM-DD."
- 항목 묶음(도넛 조각): EC2 / 로드밸런서 / NAT / VPC 엔드포인트 / 퍼블릭 IP / 디스크·스냅샷 / RDS / ElastiCache. 비율이 낮은 항목은 "기타"로 합칠 수 있다(빌더 재량).
- 항목을 누르면 개별 리소스 목록(이름 · ID · 계정 · 월 예상)으로 펼친다.

### 5.2 정리 추천 규칙 (알려주기만)

| 규칙 | 조건 | 절약 금액 | 안내할 조치 |
|---|---|---|---|
| 미사용 퍼블릭 IP | EIP가 어떤 리소스에도 연결 안 됨 | 그 EIP 월 비용 | `aws ec2 release-address` |
| 미사용 EBS | 볼륨 상태 `available` | 볼륨 월 비용 | 스냅샷 후 `aws ec2 delete-volume` |
| 오래 멈춘 EC2 | stopped 상태 7일 이상 | 연결된 EBS 월 비용 | AMI/스냅샷 후 `aws ec2 terminate-instances` |
| 오래된 스냅샷 | 생성 90일 경과 | 스냅샷 월 비용(상한) | `aws ec2 delete-snapshot` |
| 빈 로드밸런서·타겟 그룹 | 등록된 타겟이 0개(타겟 그룹), 또는 모든 타겟 그룹이 비어 있는 로드밸런서 | 로드밸런서 월 비용(타겟 그룹 단독은 0원이지만 정리 대상으로 표시) | `aws elbv2 delete-load-balancer` / `delete-target-group` |
| 24시간 켜진 EC2 | running EC2 | 월 비용 × (1 − 50/168) — 평일 09~19시만 켠다고 가정 | EventBridge Scheduler 또는 수동 중지 방법 안내 |
| gp2 → gp3 | 볼륨 유형 gp2 | 볼륨 월 비용 × 20% | `aws ec2 modify-volume --volume-type gp3` |

- **만든 사람 조회 방식**: Steampipe가 아니라 AWS SDK(`@aws-sdk/client-cloudtrail` `LookupEvents`, `AttributeKey=ResourceName`, 리소스의 리전). 호스트 계정은 서버 역할로 직접, 대상 계정은 `AWSopsReadOnlyRole`을 External ID로 빌려 조회(`ReadOnlyAccess`에 `cloudtrail:LookupEvents` 포함). LookupEvents는 계정당 초당 약 2건 제한이므로 **계정별 초당 1건 이하로 순차 조회**한다.
  - **두 단계 로딩**: 비용·추천은 먼저 응답하고(첫 로드 10초 목표에 포함), 만든 사람은 별도 요청으로 나중에 채운다(`GET /api/cost-radar/creators?ids=...`). 결과는 리소스 ID 단위로 `data/cost-radar/creators.json`에 **영구 캐시**한다(만든 사람은 바뀌지 않으므로 만료 없음, "알 수 없음"은 하루 뒤 재시도).
- 각 추천에 **만든 사람과 생성 시각**을 CloudTrail에서 찾아 표시(EIP=AllocateAddress, EBS=CreateVolume, EC2=RunInstances, 스냅샷=CreateSnapshot, LB=CreateLoadBalancer, TG=CreateTargetGroup). 90일 이전이거나 못 찾으면 "알 수 없음(90일 이전)". 태그 `Name`/`Owner`/`Project`가 있으면 함께 표시.
- **다른 팀 리소스 보호 문구**: 모든 추천 상세에 "삭제 전 만든 사람에게 확인하세요"를 표시. 이 계정에는 다른 팀 서비스(`moyeota-*`, `k6-ec2`, `k8s-practice`)가 있다.
- "아낄 수 있는 돈 월 $X" = 추천 절약액 합계. **중복 제거 키는 리소스 ID**이고, 같은 리소스에 추천이 여럿이면 큰 쪽 하나만 합산한다. 멈춘 EC2에 붙은 EBS는 그 EC2의 "오래 멈춘 EC2" 추천에만 합산하고, 같은 EBS의 "gp2→gp3"는 목록에 보이되 합계에서 뺀다.
- "연말까지" 비교 = (월 예상 × 남은 개월) vs ((월 예상 − 절약 합계) × 남은 개월). 남은 개월은 오늘부터 12월 31일까지 **소수점 개월**(남은 일수 ÷ 30.4).
- **규칙 세부**
  - 오래 멈춘 EC2: `aws_ec2_instance.state_transition_time`(예: `User initiated (2026-10-23 12:58:30 GMT)`)에서 날짜를 파싱한다. 파싱할 수 없으면 이 규칙에서 제외한다(추측해서 넣지 않음).
  - 빈 타겟 그룹: Steampipe `aws_ec2_target_group.target_health_descriptions`가 비어 있으면 "빈 것"으로 본다. 이 컬럼이 SCP 등으로 조회 실패하면 SDK `DescribeTargetHealth`로 대체한다. ECS/EKS·오토스케일링이 관리하는 타겟 그룹(태그 `aws:ecs:*`, `elbv2.k8s.aws/*`, 오토스케일링 연결)은 "서비스가 0으로 줄어든 상태일 수 있음" 문구를 붙여 보여주되 절약 합계에는 넣지 않는다.
  - 다른 팀 리소스: 특정 이름을 하드코딩하지 않는다. 모든 추천에 공통 문구 + 태그(`Name`/`Owner`/`Project`/`Team`)와 만든 사람을 보여 판단을 돕는다.
- **기존 `idle-scan.ts`와의 관계**: 유휴 탐지 SQL을 `src/lib/queries/idle-resources.ts`로 옮겨 두 곳이 같이 import한다. `idle-scan.ts`에 하드코딩된 금액 추정은 새 가격표 함수로 바꿔 **같은 리소스에 숫자가 두 개 나오지 않게** 한다(`idle-scan.ts`의 출력 형식·AI 프롬프트는 유지).

### 5.3 추이(지난주 대비)

- 하루 한 번 **계정별로만** 월 예상 총액과 항목별 금액을 저장한다(`data/cost-radar/history.json`, `.gitignore` 대상, 최근 90일 보관). "All"의 추이는 계정별 기록을 더해 계산한다. `data/`는 `git pull`·`03-build-deploy.sh`로 지워지지 않는다(기존 리포트·대화 이력과 동일). 기록 시점은 **헬스 모니터의 5분 루프에서 그날 기록이 없을 때 한 번**(추가 Steampipe 조회는 비용 계산 1회뿐).
- 7일 전 스냅샷이 있으면 "▲/▼ 지난주 대비 ±N%" 배지 표시, 없으면 배지 숨김.

### 5.4 화면 위치

- 새 페이지 `/cost-radar` (사이드바 "모니터링" 그룹, 기존 "비용" 아래, 이름 "비용 레이더").
- 대시보드 홈에 요약 카드 1개(이번 달 예상 · 아낄 수 있는 돈) → `/cost-radar`로 연결. 위치·형태는 빌더 재량.
- 기존 `/cost`(Cost Explorer) 페이지는 그대로 둔다.

### 5.5 API

- `GET /api/cost-radar?accountId=<id|__all__>` → 항목별 금액, 개별 리소스, 추천 목록(조치 명령·콘솔 링크·만든 사람 포함), 총액, 시간당, 추이, 가격표 기준일, 가격 미확인 리소스 목록. 응답은 5분 캐시(기존 캐시 규칙과 동일하게 계정 ID를 키에 포함).
- CloudTrail 조회는 비싸고 느리므로 리소스 ID 단위로 하루 캐시.

## 6. 빌더에게 맡기는 것

- 가격표 JSON의 정확한 구조와 갱신 방법(수동 갱신 스크립트 포함 여부).
- 도넛/카드 컴포넌트 구현 방식(Recharts 사용 또는 CSS conic-gradient), 애니메이션.
- 글꼴 로딩 방식(Archivo Black·Caveat를 `next/font/google`로 이 페이지에만 적용 권장).
- 항목 묶음의 "기타" 기준, 정렬, 빈 상태 문구.
- 홈 요약 카드 형태.

## 7. 완료 기준

1. 이 계정(Sandbox)에서 페이지를 열면 EC2·NAT·ALB·VPC 엔드포인트·EIP·EBS가 항목별로 보이고, 손으로 계산한 값과 ±5% 이내로 맞는다(가격표 기준).
2. 상단 계정 선택을 Moyeota로 바꾸면 그 계정 리소스만으로 다시 계산된다.
3. 미사용 EIP·빈 타겟 그룹 등 실제로 존재하는 낭비가 추천에 나오고, 각 추천에 만든 사람(또는 "알 수 없음")과 복사 가능한 CLI 명령·콘솔 링크가 있다.
4. 추천 상세 어디에도 실행 버튼이 없다.
5. "추정치" 문구와 가격표 기준일이 항상 보인다.
6. 페이지 첫 로드 10초 이내, 이후 5분 캐시. 다른 대시보드 페이지 속도에 영향 없음.
7. ko/en/zh 전환 시 모든 문구가 바뀐다.
