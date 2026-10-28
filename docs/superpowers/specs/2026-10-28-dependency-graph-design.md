# 의존성 그래프와 영향 분석 — 설계

> 상태: 기본값으로 진행 (사용자가 질문 없이 "기본값으로 구현"을 요청). 아래 "내 판단"은 모두 빌더(나)의 결정이다.
> 관련: ADR-011 (안전한 AI 실행), 신규 ADR-012 (그래프 저장소 선택)

## 1. 왜 만드나

AWS 리소스끼리의 관계는 여러 곳에 흩어져 있다. 서버의 `SubnetId`, 네트워크 인터페이스의 `Groups`, 대상 그룹의 타깃 목록, IAM 정책 안의 `Resource` ARN 같은 데이터에 숨어 있다. 그래서 "이 보안그룹을 지우면 뭐가 깨지지?", "이 프로젝트를 통째로 정리하려면 뭘 어떤 순서로 지워야 하지?"에 바로 답할 수가 없다.

이 기능은 세 가지를 한다.
1. 관계를 직접 뽑아 **PostgreSQL `edges(src_arn, dst_arn, type)` 테이블**에 담는다.
2. **재귀 CTE**로 영향 범위를 계산한다.
3. 결과를 **화면에 그래프로 보여 준다**. 사용자가 진행 중에 추가로 요청한 부분이다: "어떻게 의존이 되어있는지 시각적으로".

이 그래프는 두 기능의 엔진이 된다.
- ① 안전한 AI 실행의 영향 범위 표시
- "프로젝트 통째로 정리" 미리보기

### 목표
- 핵심 15종 리소스의 관계 추출기: VPC, Subnet, ENI, EC2, SG, ELB, TG, RDS, Lambda, IAM Role, NAT, EIP, EBS, S3, CloudFront
- 그래프 저장과 질의:
  - 영향 받는 것: 나를 쓰는 것들, 거꾸로 따라감
  - 내가 쓰는 것: 정방향으로 따라감
  - 주변 그래프: 양방향
  - 가장 많이 쓰이는 리소스(허브)
  - 프로젝트 정리 미리보기
- `/dependency-graph` 화면:
  - 리소스를 검색해서 고르면 React Flow로 관계도를 그린다.
  - 노드를 누르면 그 노드를 중심으로 다시 그린다.
  - 옆 패널에 "이걸 바꾸거나 지우면 영향 받는 리소스 N개"를 보여 준다.
- `/api/graph`: 읽기 전용 API
- ① 안전한 AI 실행 카드에 "그래프로 본 영향" 한 줄 추가 (참고 정보)
- ADR-012: Postgres 재귀 CTE와 Neo4j를 비교한 트레이드오프

### 하지 않는 것
- 아무것도 지우거나 바꾸지 않는다. 그래프와 정리 미리보기는 **안내만** 한다. Cost Radar와 같은 원칙이다.
- 15종 밖의 리소스는 다루지 않는다: ECS, EKS, DynamoDB, ElastiCache, Route 53, VPC 엔드포인트 등. 나중에 추출기만 추가하면 된다.
- Slack 질문("sg-… 지우면 뭐 영향?")과 AI 라우트 연동은 후속 과제다.

### 반대 목표 (기술적으로는 돌아가도 실패인 것)
- **오래된 그래프를 실제처럼 믿게 하는 것.**
  - 그래프는 최대 15분 늦을 수 있다. 화면과 카드에 항상 "N분 전 기준"을 보여 준다.
  - ①의 정책 검사(ENI 개수 한도)는 지금처럼 **실시간 AWS 조회**를 쓴다. 그래프 값으로 바꾸지 않는다. 그래프 숫자는 카드의 참고 줄일 뿐이고, 허용·거부 판단에는 쓰지 않는다.
- **그래프 빌드가 대시보드를 느리게 만드는 것.**
  - Steampipe 쿼리는 기존 `runQuery()` 풀을 공유한다.
  - 15분마다 한 번, 겹치지 않게 돈다.
  - 쿼리 실패는 해당 종류만 빠지고, 빌드 전체는 계속된다.
- **Steampipe DB에 앱 상태를 쓰는 것.** `runQuery()`는 SELECT 전용이다(`validateQuery`). 이 규칙을 깨지 않는다.

## 2. 내 판단 (기본값)

### 저장소: PGlite
PGlite(`@electric-sql/pglite@0.5.12`)를 쓴다. WASM으로 Node 프로세스 안에서 도는 진짜 PostgreSQL이다.
- 메모리 모드로 쓴다. 빌드마다 새 인스턴스에 적재한 뒤 포인터를 바꿔 끼운다. 그래서 읽는 쪽은 항상 완성된 그래프를 본다.
- 직전 빌드 결과는 `data/graph/latest.json`에 저장한다. 서버를 재시작하면 이 파일을 먼저 적재해서 바로 쓸 수 있다.
- 고른 이유:
  - 과제가 요구한 "PostgreSQL edges 테이블 + 재귀 CTE"를 그대로 쓴다.
  - 새 인프라가 없다. 서버도 계정 리소스도 필요 없다.
  - vitest에서 진짜 SQL로 테스트할 수 있다.
  - Steampipe DB를 건드리지 않는다.
- 미리 확인한 것:
  - 로컬 Node v20.20.2에서 재귀 CTE가 동작한다. 첫 생성은 약 0.7초다.
  - 서버도 Node v20.20.2이고 메모리 여유가 14GB다.
  - 패키지 크기는 25MB다.
- Next 설정: `experimental.serverComponentsExternalPackages`에 `@electric-sql/pglite`를 추가해서 webpack이 WASM을 묶지 않게 한다.

### 규모
- 실측 행 수(호스트 계정 116662357283, 2026-10-28):

  | 리소스 | 개수 |
  |---|---|
  | VPC | 4 |
  | Subnet | 23 |
  | ENI | 32 |
  | EC2 | 11 |
  | SG | 19 |
  | SG 규칙 | 52 |
  | ALB | 3 |
  | NLB / CLB | 0 / 0 |
  | TG | 5 |
  | RDS | 2 |
  | Lambda | 21 |
  | Role | 64 |
  | NAT | 2 |
  | EIP | 7 |
  | EBS | 12 |
  | S3 | 5 |
  | CloudFront | 4 |

- 노드 약 230개, 간선은 수백 개 수준이다. 성능 걱정은 없지만, 질의에는 깊이와 개수 상한을 둔다.

### 스키마
```sql
nodes(arn text primary key, type text not null, id text not null, name text not null,
      account_id text not null, region text not null, attrs jsonb not null default '{}')
edges(src_arn text not null, dst_arn text not null, type text not null,
      primary key (src_arn, dst_arn, type))
create index on edges(dst_arn); create index on edges(src_arn);
```
- `attrs`에는 화면용 정보만 넣는다: 상태, 인스턴스 타입, CIDR, 엔진, DNS 이름 등. 태그는 `attrs.tags`에 담는다. 프로젝트 씨앗을 태그로 고르려면 키가 모두 필요하다. 상한은 리소스당 50개, 값은 256자다.
- 비밀값은 넣지 않는다. Lambda 환경 변수, 사용자 데이터, 정책 원문은 담지 않는다.

### 방향 규칙
간선 `src → dst`는 **"src가 dst를 쓴다 (src가 dst에 의존한다)"**는 뜻이다.
- **영향 받는 것(impact)**: dst에서 시작해 간선을 거꾸로 따라간다. "dst를 지우거나 바꾸면 src들이 영향 받는다."
- **정리 순서**: 의존하는 쪽(src)을 먼저 지운다.

### 노드 ID
- 모두 ARN을 쓴다. ARN 컬럼이 없는 ENI는 `arn:<partition>:ec2:<region>:<account>:network-interface/<id>`로 만든다.
- 다른 리소스를 ID로 참조할 때(`subnet_id` 등)는 `(account_id, 리소스ID)` → ARN 색인으로 찾는다.
- 찾지 못한 대상은 간선을 버리고 빌드 통계(`dropped`)에 센다. 예: 목록 조회가 실패했거나 다른 계정의 리소스일 때.

### 관계 목록 (src → dst, type)

| src | dst | type | 근거 컬럼 |
|---|---|---|---|
| subnet | vpc | `in_vpc` | `aws_vpc_subnet.vpc_id` |
| sg | vpc | `in_vpc` | `aws_vpc_security_group.vpc_id` |
| sg | sg | `allows_from` | `aws_vpc_security_group_rule`(ingress)의 `referenced_group_id` (규칙을 가진 쪽 → 참조된 쪽) |
| instance | subnet | `in_subnet` | `aws_ec2_instance.subnet_id` |
| instance | sg | `uses_sg` | `aws_ec2_instance.security_groups[].GroupId` |
| instance | role | `uses_role` | `iam_instance_profile_arn`가 `aws_iam_role.instance_profile_arns`에 들어 있는 역할 |
| instance | ebs | `uses_volume` | `aws_ebs_volume.attachments[].InstanceId` |
| instance | eni | `uses_eni` | `aws_ec2_network_interface.attached_instance_id` |
| eni | subnet | `in_subnet` | `aws_ec2_network_interface.subnet_id` |
| eni | sg | `uses_sg` | `aws_ec2_network_interface.groups[].GroupId` |
| lb | eni | `uses_eni` | ENI `description`이 `ELB app/<name>/<id>` 또는 `ELB net/<name>/<id>` → LB ARN 끝부분과 일치 |
| eni 또는 instance | eip | `uses_eip` | `aws_vpc_eip.network_interface_id`가 있으면 그 ENI, 없고 `instance_id`만 있으면 그 서버 |
| nat | subnet | `in_subnet` | `aws_vpc_nat_gateway.subnet_id` |
| nat | eni | `uses_eni` | `nat_gateway_addresses[].NetworkInterfaceId` |
| nat | eip | `uses_eip` | `nat_gateway_addresses[].AllocationId` |
| lb | subnet | `in_subnet` | ALB/NLB `availability_zones[].SubnetId`, CLB `subnets[]` |
| lb | sg | `uses_sg` | `security_groups[]` |
| lb | tg | `forwards_to` | `aws_ec2_target_group.load_balancer_arns[]` |
| tg | instance | `targets` | `target_type='instance'`일 때 `target_health_descriptions[].Target.Id` |
| tg | lambda | `targets` | `target_type='lambda'`일 때 `Target.Id`(ARN) |
| tg | vpc | `in_vpc` | `aws_ec2_target_group.vpc_id` |
| rds | subnet | `in_subnet` | `aws_rds_db_instance.subnets[].SubnetIdentifier` |
| rds | sg | `uses_sg` | `vpc_security_groups[].VpcSecurityGroupId` |
| lambda | role | `uses_role` | `aws_lambda_function.role` |
| lambda | subnet | `in_subnet` | `vpc_subnet_ids[]` |
| lambda | sg | `uses_sg` | `vpc_security_group_ids[]` |
| role | (모든 종류) | `can_access` | 아래 "정책 안의 ARN" |
| s3 | lambda | `notifies` | `event_notification_configuration.LambdaFunctionConfigurations[].LambdaFunctionArn` |
| cloudfront | s3 | `origin` | `origins[].DomainName`이 `<bucket>.s3.amazonaws.com`, `<bucket>.s3.<region>.amazonaws.com`, `<bucket>.s3-website-<region>.amazonaws.com`, `<bucket>.s3-website.<region>.amazonaws.com` 중 하나 |
| cloudfront | lb | `origin` | `origins[].DomainName`이 LB `dns_name`과 같음 (대소문자 무시) |

**정책 안의 ARN.** 역할의 정책 문서를 읽어 역할 → 리소스 간선을 만든다.
- 읽는 문서: 인라인 정책(`inline_policies_std`)과, 붙어 있는 **고객 관리형** 정책(`attached_policy_arns` ∩ `aws_iam_policy`(`is_aws_managed = false`)의 `policy_std`).
- `Effect = Allow`인 Statement의 `Resource`만 본다. 문자열과 배열 모두 처리한다.
- 정확한 ARN이 알려진 노드와 같으면 간선을 만든다.
- S3는 `arn:aws:s3:::bucket/*` 또는 `arn:aws:s3:::bucket/<prefix>...`도 해당 버킷으로 인정한다.
- 그 밖에 `*`나 `?`가 들어간 ARN은 건너뛴다. 와일드카드를 펼치면 거의 모든 리소스와 연결돼 의미가 없어진다.
- 정책 조회가 실패하면(권한·SCP) 정책 간선만 빠지고 경고를 남긴다.

### Steampipe 조회
- 종류마다 SQL 하나를 둔다. `src/lib/dep-graph/queries.ts`에 정의한다.
- 규칙:
  - 필요한 컬럼만 명시하고 `account_id`, `region`을 포함한다.
  - JSONB 원본 컬럼을 그대로 가져와 TS에서 해석한다. SQL 안에서 `jsonb_array_elements`는 쓰지 않고, `$`도 쓰지 않는다.
  - Lambda는 `tags`를 고르지 않는다(SCP).
- 컬럼은 서버에서 `information_schema.columns`로 확인했다(위 표의 근거 컬럼).
- `batchQuery()`로 계정을 지정하지 않고 실행한다. 집계(aggregator) 스키마를 써서 모든 계정을 한 번에 가져온다.
- 리전은 행의 `region` 컬럼을 쓴다.

### 빌드 주기
- 서버 기동 60초 뒤 첫 빌드, 이후 15분마다 돈다. 겹쳐 실행하지 않는다.
- 프로덕션에서만 돈다. `change-timeline/loop.ts`와 같은 패턴이며 `src/instrumentation.ts`에서 시작한다.
- API가 처음 불렸을 때 그래프가 없으면 다음 순서로 처리한다.
  1. 스냅샷 파일이 있으면 그것을 적재한다.
  2. 없으면 빌드를 한 번 시작하고 `{ status: 'building' }`을 돌려준다.
- 빌드 결과에 담는 것: `builtAt`, 종류별 노드 수, 간선 수, `dropped` 수, 실패한 쿼리 이름 목록(`warnings`).

### 질의 (모두 재귀 CTE, PGlite 안에서 실행)
| 질의 | 기본 깊이 | 깊이 범위 |
|---|---|---|
| `impact(arn, depth)` — 거꾸로 따라감 | 3 | 1–6 |
| `dependencies(arn, depth)` — 정방향 | 3 | 1–6 |
| `neighborhood(arn, depth)` — 양방향 | 2 | 1–3 |

- 공통 규칙:
  - 순환은 깊이 상한과 `UNION`(같은 (노드, 깊이) 쌍은 한 번만)으로 막는다. sg ↔ sg 순환이 실제로 생긴다. 경로 배열을 쓰지 않아서 결과 행은 최대 노드 수 × (깊이+1)개다. 경로가 폭발하지 않는다.
  - 노드마다 가장 짧은 깊이를 기록한다.
  - 결과 노드는 최대 300개다. 넘으면 `truncated: true`를 표시한다.
- `neighborhood`는 이웃 노드와 그 노드들 **사이의 간선 전부**를 돌려준다(화면용).
- `search(q)`: 이름·ID·ARN에 부분 일치, 대소문자 무시, 최대 20개.
- `hubs(limit=10)`: 나를 쓰는 간선(들어오는 간선)이 많은 순.
- `stats()`: 위의 빌드 통계.

### 프로젝트 정리 미리보기 (엔진만, 안내만)
1. **씨앗(seed)을 고른다.** 다음 중 하나다.
   - 태그 `키=값`: `attrs.tags`에 담긴 태그 기준
   - 이름 접두어: 예 `moyeota-`
   - VPC ARN
2. **후보를 정한다.** 이 계산은 PGlite가 아니라 TS 순수 함수가 메모리의 노드·간선으로 한다. 반복 계산을 SQL로 쓰면 읽기 어렵기 때문이다(내 판단).
   - 시작점은 씨앗 노드다. 씨앗이 VPC면 그 VPC를 거꾸로 따라가 닿는 모든 노드를 시작점에 넣는다.
   - 씨앗이 정방향으로 쓰는 노드 d를 하나씩 확인한다. **d를 쓰는 모든 노드가 이미 후보 안에 있으면** d도 후보에 넣는다. 이 확인은 더 이상 바뀌지 않을 때까지 되풀이한다.
   - 이렇게 해서 공유 리소스는 빠진다. 예: 다른 팀도 쓰는 보안그룹이나 역할.
3. **정리를 막는 것(blockers)을 찾는다.** 후보가 아니면서 후보를 쓰는 노드다. "이것부터 확인해야 해요."
4. **지우는 순서를 정한다.** 후보끼리의 간선으로 위상 정렬을 하고, 의존하는 쪽(src)을 먼저 둔다. 순환에 걸린 노드들은 한 단계로 묶고 `cycle: true`로 표시한다.
5. **돌려주는 것:** `{ seed, members[], order: Array<{ step, arns[], cycle }>, blockers[], shared[] }`. `shared`는 씨앗이 쓰지만 다른 곳에서도 쓰여서 후보에서 빠진 노드다.

### 화면 `/dependency-graph`
- **위치:** 사이드바 "네트워크/CDN" 묶음, "토폴로지" 아래. 이름은 "의존성 그래프"이고 아이콘은 `Share2`다.
- **위쪽:**
  - 빌드 상태 "N분 전 기준 · 노드 N · 관계 N"
  - 검색창(이름·ID)
  - 탭 2개: **관계 보기**, **프로젝트 정리 미리보기**
- **관계 보기:**
  - 시작 화면은 "가장 많이 쓰이는 리소스" 10개 카드다. 누르면 그 리소스가 중심이 된다.
  - 중심 노드를 고르면 다음 순서로 그린다.
    1. React Flow(`reactflow` 이미 설치됨)로 `neighborhood(arn, depth)`를 그린다.
    2. 배치: 중심은 가운데, 나를 쓰는 쪽은 왼쪽 열, 내가 쓰는 쪽은 오른쪽 열, 깊이마다 한 열씩 바깥으로. 같은 열 안에서는 종류 → 이름 순으로 세로 정렬한다.
    3. 노드 색은 종류별 테마 강조색이고, 간선 라벨은 관계 이름을 한국어로 쓴다(예: "서브넷 안", "보안그룹 사용").
    4. 노드를 누르면 그 노드를 중심으로 다시 그린다.
  - 깊이 선택: 1·2·3, 기본 2.
  - 오른쪽 패널:
    - "이걸 바꾸거나 지우면 영향 받는 리소스 N개": `impact` 결과를 종류별로 묶어 보여 준다.
    - "이 리소스가 쓰는 것 N개": `dependencies` 결과
    - 리소스 정보(`attrs`)
- **프로젝트 정리 미리보기:**
  - 씨앗을 입력한다: 태그 키·값, 이름 접두어, VPC 선택.
  - 결과: 지우는 순서 목록, 막는 것, 공유라 빠진 것, 후보 그래프.
  - 항상 이 문구를 보여 준다: "안내만 해요 — 실제로 지우지 않아요".
- **다국어:** ko/en/zh 키를 모두 추가한다(`depGraph.*`, `sidebar.depGraph`).
- **테마:** navy 배경, 기존 토폴로지 페이지의 노드 스타일을 따른다.

### API `/api/graph` (GET, 읽기 전용)
| 요청 | 하는 일 |
|---|---|
| `?op=stats` | 빌드 통계 |
| `?op=search&q=` | 리소스 검색 |
| `?op=hubs` | 가장 많이 쓰이는 리소스 |
| `?op=neighborhood&arn=&depth=` | 주변 그래프 |
| `?op=impact&arn=&depth=` | 영향 받는 것 |
| `?op=deps&arn=&depth=` | 내가 쓰는 것 |
| `?op=project&tag=키=값` / `&prefix=` / `&vpc=<arn>` | 프로젝트 정리 미리보기 |

- 입력 검사:
  - `arn`은 `arn:`으로 시작하고 1024자 이하
  - `depth`는 정수이고 범위 밖이면 기본값을 쓴다
  - `q`와 `prefix`는 100자 이하
  - `tag`는 `키=값` 형식이고 각각 128/256자 이하
- 응답에는 항상 `builtAt`을 넣는다.
- 그래프가 아직 없으면 `200 { status: 'building' }`을 돌려준다.
- 알 수 없는 `arn`은 `404`다.
- 오류 응답에는 오류 이름만 넣는다.
- 계정 선택(`accountId`)이 오면 `search`, `hubs`, `project` 결과를 그 계정으로 거른다. 관계 따라가기(`neighborhood`, `impact`, `deps`)는 사용자가 고른 노드에서 출발하므로 거르지 않는다. 그래프 자체는 모든 계정을 한 번에 담는다.

### ① 안전한 AI 실행 연동
- 카드의 영향 범위 부분(`blastLines`)에 참고 줄을 하나 더한다. 대상은 보안그룹 단계마다다.
  - 문구: `• 그래프로 본 영향(N분 전 기준): 이 보안그룹을 쓰는 리소스 N개 — 서버 a, ALB b 외 N개`
- 값은 계획 시점에 `impactSummary(sgArn)`로 구해 `ActionRequest.graphImpact`에 저장한다.
  - 깊이는 2로 둔다. 보안그룹 → ENI → 서버/LB까지 닿는다.
- 그래프가 없거나 실패하면 그 줄을 생략한다. 오류는 카드에 보이지 않는다.
- 정책(`policy.ts`)과 실행은 바뀌지 않는다.

## 3. 테스트 기준
- **추출기:** 서버에서 확인한 실제 컬럼 모양의 가짜 행(fixture)으로 관계 표의 행마다 간선이 하나씩 생기는지 확인한다. 함께 확인할 것:
  - 찾지 못한 참조는 `dropped`로 센다.
  - 와일드카드 ARN을 건너뛴다.
  - S3의 `bucket/*`를 버킷으로 인정한다.
  - ELB ENI 설명을 해석한다.
  - EIP의 ENI 우선 규칙을 지킨다.
- **저장소:** vitest 안에서 진짜 PGlite로 확인한다.
  - impact, deps, neighborhood가 순환에서 멈추는지
  - 노드마다 최단 깊이를 기록하는지
  - 300개 상한과 `truncated`
  - 검색, 허브
  - 빌드 중에 읽어도 이전 그래프를 그대로 보는지(포인터 교체)
- **프로젝트 미리보기:**
  - 공유 SG가 빠지는지
  - VPC 씨앗이 안쪽 전부를 넣는지
  - 막는 것을 찾는지
  - 순서가 의존하는 쪽부터인지
  - 순환을 묶는지
- **API:** 입력 검사, building 상태, 404.
- **화면:** 배치 함수(열 계산)는 순수 함수로 분리해서 테스트한다.
- **연동:** `graphImpact`가 있으면 카드에 줄이 생기고, 없으면 생기지 않는다.
- **마무리:** 전체 테스트, `tsc`, `next build`가 통과해야 한다.

## 4. 빌더에게 맡기는 것
- 추출기 파일을 어떻게 나눌지(종류군별 권장)
- 간선 라벨의 정확한 한국어 표현
- 화면 세부 여백과 아이콘
