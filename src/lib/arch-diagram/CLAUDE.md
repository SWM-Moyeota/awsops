# 아키텍처 다이어그램 (arch-diagram) 모듈

## 역할
`/diagram` 화면의 그림을 만든다. Steampipe 행을 VPC > AZ > 서브넷 모델로 바꾸고, 좌표를 직접 계산한 뒤, 선 경로를 찾아 독립 SVG 문자열로 그린다. AWS는 읽기만 한다. 결정: ADR-015.

## 주요 파일
- `types.ts` — 모델과 입력 행 타입.
- `collect.ts` — 쿼리 실행. 핵심 소스 실패는 `DiagramQueryFailed`, 선택 소스 실패는 건너뛰고 범례에 이름을 적는다.
- `model.ts` — 행 → 모델. 티어 판정, ASG·EKS 접기, 리소스 배치, 관계, 범례 번호.
- `layout.ts` — 결정적 배치(`TB`: AZ 나란히, `LR`: AZ 위아래). AZ 사이에 티어 줄을 맞춘다.
- `route.ts` — 듬성한 격자 위 A* 직각 경로 탐색, 3초 예산. 경로가 없거나 예산을 넘긴 선은 그리지 않고 범례에 개수를 적는다.
- `svg.ts` — SVG 문자열과 범례. 다국어 문구도 여기에 있다.
- `icons.ts` — 공식 AWS 아이콘 19종(id 접두어 처리, 스크립트·외부 링크 없음 확인).

## 규칙
- 데이터로 확인되는 관계만 그린다: 대상 그룹(인스턴스 id, 정확한 사설 IP, draining·unused 제외), 라우트 테이블(서브넷 → NAT), 원본 DNS(CloudFront → 로드밸런서), Multi-AZ 대기. EC2와 DB·캐시 사이의 선은 추측하지 않고, 범례에 그렇게 적는다.
- S3·Route 53·DynamoDB와 이 VPC에 안 붙은 CloudFront는 계정 전체 개수다. `Account` 레일로 나누고 VPC 소속처럼 보이게 하지 않는다.
- 정지된 EC2와 RDS는 그리지 않고 범례에 개수만 적는다(사용자 결정). 그 때문에 비는 서브넷은 빈 서브넷으로 숨겨진다.
- 여러 서브넷을 쓰는 리소스는 첫 서브넷에 그리고, 다른 서브넷은 `also`로 남겨 빈 서브넷으로 숨기지 않는다.
- ElastiCache는 AZ만 알 수 있어 그 AZ의 첫 프라이빗 서브넷에 놓고, 없으면 VPC 띠에 놓는다. RDS는 주 AZ가 맞는 서브넷에만 놓는다.
- 퍼블릭은 기본 경로(0.0.0.0/0)가 IGW일 때만이다. IPv6 `::/0`은 IPv4 기본 경로가 없을 때만 본다.
- 모든 데이터 값은 `esc()`를 거친다. 화면은 `<img>`로 보여 주므로 SVG 안의 스크립트는 실행되지 않는다.
- `model.ts`·`layout.ts`·`route.ts`·`svg.ts`는 순수 함수로 유지한다(입출력 없음). 같은 입력이면 같은 출력이다.
- 시험 픽스처는 합성 데이터만 쓴다. 실제 계정 데이터를 커밋하지 않는다.

---

# Architecture Diagram Module (English)

## Role
Draws the `/diagram` picture. Turns Steampipe rows into a VPC > AZ > subnet model, computes coordinates directly, routes the edges and emits a standalone SVG string. AWS is read-only. Decision: ADR-015.

## Key Files
- `types.ts` — model and input row types.
- `collect.ts` — runs the queries. A core source failure is `DiagramQueryFailed`; a failed optional source is skipped and named in the legend.
- `model.ts` — rows to model: tiers, folding ASG/EKS, placement, relations, legend numbers.
- `layout.ts` — deterministic layout (`TB`: AZs side by side, `LR`: AZs stacked). Tier rows line up across AZs.
- `route.ts` — orthogonal A* over a sparse grid, 3-second budget. An edge with no route, or past the budget, is left out and counted in the legend.
- `svg.ts` — SVG string and legend, including the translated strings.
- `icons.ts` — 19 official AWS icons (ids prefixed, checked for scripts and external links).

## Rules
- Draw only relations the data proves: target groups (instance id, exact private IP, not draining or unused), route tables (subnet to NAT), origin DNS (CloudFront to load balancer), Multi-AZ standby. Do not guess links between EC2 and databases or caches; the legend says so.
- S3, Route 53, DynamoDB and CloudFront not attached to this VPC are account-wide counts. They go in the `Account` rail and must not look like VPC members.
- Stopped EC2 and RDS are not drawn; the legend gives their count (user decision). A subnet left empty by this is hidden as empty.
- A multi-subnet resource is drawn in its first subnet; the others keep it in `also`, so they are not hidden as empty.
- ElastiCache only reports an AZ, so it goes in that AZ's first private subnet, else the VPC band. RDS goes only in a subnet matching its primary AZ.
- Public means the default route (0.0.0.0/0) goes to an IGW; IPv6 `::/0` counts only when there is no IPv4 default route.
- Every data value goes through `esc()`. The page shows the SVG through `<img>`, so scripts inside it never run.
- Keep `model.ts`, `layout.ts`, `route.ts` and `svg.ts` pure (no I/O). Same input, same output.
- Test fixtures are synthetic. Never commit real account data.
