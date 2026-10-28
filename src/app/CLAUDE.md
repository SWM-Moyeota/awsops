# 앱 모듈

## 역할
Next.js 14 App Router 페이지 및 API 라우트. 각 하위 디렉토리는 라우트 세그먼트.

## 페이지 (45개)

### Overview (5)
- `page.tsx` — 대시보드 홈 (20 StatsCards, Cost 가용성 감지, 인벤토리 스냅샷, 캐시 워머 상태 바)
- `ai/page.tsx` — AI 어시스턴트 (실시간 Bedrock 스트리밍, 멀티 라우트, 도구 사용 표시, 사용자별 대화 이력, 토큰 비용 표시)
- `agentcore/page.tsx` — AgentCore 대시보드 (Runtime/Gateway/Tools 상태, 호출 통계, 대화 이력 검색, 캐시 상태)
- `bedrock/page.tsx` — Bedrock 모니터링 (모델별 사용량, 토큰 비용, 프롬프트 캐싱, Account vs AWSops 비교)
- `accounts/page.tsx` — 계정 관리 (추가/삭제/테스트, admin 전용 — adminEmails config)

### Compute (6)
- `ec2/page.tsx` — EC2 인스턴스 + 상세 패널
- `lambda/page.tsx` — Lambda 함수, 런타임
- `ecs/page.tsx` — ECS 클러스터/서비스/태스크
- `ecr/page.tsx` — ECR 리포지토리/이미지
- `k8s/page.tsx` — EKS Overview (클러스터, 노드, Pod 요약)
- `k8s/explorer/page.tsx` — K9s 스타일 터미널 UI

### EKS 하위 (4)
- `k8s/pods/page.tsx`, `k8s/nodes/page.tsx`, `k8s/deployments/page.tsx`, `k8s/services/page.tsx`

### Network & CDN (7)
- `vpc/page.tsx` — VPC/Subnet/SG/TGW/ELB/NAT/IGW + 리소스 맵
- `cloudfront-cdn/page.tsx` — CloudFront 배포
- `waf/page.tsx` — WAF Web ACL/규칙
- `topology/page.tsx` — 인프라 맵 + K8s 맵 (React Flow)
- `topology-view/page.tsx` — 편집 가능한 토폴로지 뷰 + 자연어 채팅 편집
- `dependency-graph/page.tsx` — 의존성 그래프 (리소스 검색 → React Flow 관계도, 영향 받는 리소스 패널, 프로젝트 정리 미리보기, 안내만)
- `diagram/page.tsx` — 2D 보고서 스타일 다이어그램 (PNG) + 자연어 채팅

### Storage & DB (7)
- `ebs/page.tsx` — EBS 볼륨/스냅샷 (암호화, EC2 어태치먼트 매핑)
- `s3/page.tsx` — S3 버킷 (TreeMap/검색/IAM)
- `rds/page.tsx` — RDS 인스턴스 (SG 체이닝/메트릭/CloudWatch 메트릭 테이블)
- `dynamodb/page.tsx` — DynamoDB 테이블
- `elasticache/page.tsx` — ElastiCache (Valkey/Redis/Memcached, 노드 메트릭 테이블)
- `opensearch/page.tsx` — OpenSearch 도메인 (암호화, VPC, 도메인 메트릭 테이블)
- `msk/page.tsx` — MSK 클러스터 (브로커 노드 + CPU/Memory/Network 메트릭)

### Diagnosis (2)
- `ai-diagnosis/page.tsx` — 종합 진단 (15섹션 AI 분석, TOC 사이드바, 멀티 확장, PPTX/DOCX/PDF 다운로드)
- `ai-diagnosis/report/page.tsx` — 인쇄용 리포트 (브라우저 Print-to-PDF, 흰 배경, A4 페이지 브레이크)

### Datasources (2)
- `datasources/page.tsx` — 외부 데이터소스 관리 (7종 CRUD, 연결 테스트, 인증 설정)
- `datasources/explore/page.tsx` — 데이터소스 탐색 (직접 쿼리 실행, AI 쿼리 생성 — 자연어→PromQL/LogQL/TraceQL/SQL)

### Monitoring & Cost (8)
- `monitoring/page.tsx` — CPU/메모리/네트워크/Disk I/O
- `cloudwatch/page.tsx` — CloudWatch 알람
- `cloudtrail/page.tsx` — CloudTrail 트레일/이벤트
- `changes/page.tsx` — 변경 기록 (누가 어떤 리소스를 만들고 지웠는지, 토스 스타일 다크, Pretendard는 `next/font/local`로 이 페이지에만)
- `cost/page.tsx` — Cost Explorer (MSP 자동 감지, 스냅샷 폴백)
- `inventory/page.tsx` — Resource Inventory (수량 추이, 비용 영향 추정)
- `container-cost/page.tsx` — ECS Container Cost (Fargate 가격 + Container Insights)
- `eks-container-cost/page.tsx` — EKS Container Cost (OpenCost + Request 기반 폴백)
- `cost-radar/page.tsx` — 비용 레이더 (켜 둔 리소스의 월 비용 추정 + 정리 추천, 안내만 — AWS 리소스를 바꾸는 버튼 없음)

### Security (3)
- `iam/page.tsx` — IAM 사용자/역할/트러스트 정책
- `security/page.tsx` — Public S3, Open SG, Unencrypted EBS, CVE
- `compliance/page.tsx` — CIS v1.5~v4.0 벤치마크

## API 라우트 (28개)

| API | 설명 |
|-----|------|
| `api/ai/route.ts` | AI 라우팅 진입점 — 얇은 파일: `GET`/`POST`만 두고, POST는 검증 후 `src/lib/ai/`의 `handleNonStreaming`(JSON) 또는 `runStreaming`(SSE)에 넘긴다. 분류·처리기·멀티 라우트·SSE·도구 추론·토큰 추적은 모두 `src/lib/ai/` (등록표 19 라우트, `src/lib/ai/CLAUDE.md`) |
| `api/steampipe/route.ts` | Steampipe 쿼리 + Cost 가용성 + 인벤토리 |
| `api/auth/route.ts` | 로그아웃 — HttpOnly 쿠키 서버 사이드 삭제 |
| `api/msk/route.ts` | MSK 브로커 노드 + CloudWatch 메트릭 |
| `api/rds/route.ts` | RDS 인스턴스 CloudWatch 메트릭 |
| `api/elasticache/route.ts` | ElastiCache 노드 CloudWatch 메트릭 |
| `api/opensearch/route.ts` | OpenSearch 도메인 CloudWatch 메트릭 |
| `api/agentcore/route.ts` | AgentCore Runtime/Gateway 상태 |
| `api/code/route.ts` | 코드 인터프리터 |
| `api/benchmark/route.ts` | CIS 컴플라이언스 벤치마크 |
| `api/container-cost/route.ts` | ECS 컨테이너 비용 (CloudWatch Container Insights + Fargate 가격) |
| `api/eks-container-cost/route.ts` | EKS 컨테이너 비용 (OpenCost API + Request 기반 폴백) |
| `api/bedrock-metrics/route.ts` | Bedrock 모델 사용량 (CloudWatch 메트릭 + AWSops 앱 토큰 통계) |
| `api/datasources/route.ts` | 외부 데이터소스 CRUD + 쿼리 실행 + AI 쿼리 생성 (SSRF 방지, admin 전용 쿼리) |
| `api/k8s/route.ts` | EKS kubeconfig 등록 |
| `api/report/route.ts` | AI 종합 진단 리포트 생성 + S3 저장 + 스케줄링 + DOCX/MD/PDF 다운로드 (`download-pdf`는 Puppeteer 서버 렌더링) |
| `api/notification/route.ts` | SNS 이메일 알림 (토픽/구독 관리, 진단 완료 알림) |
| `api/health/route.ts` | 헬스 모니터 상태 조회(GET, 모니터 기동) + 테스트 알림/즉시 점검(POST, admin 전용) |
| `api/cost-radar/route.ts` | 비용 레이더 — 월 비용 추정 + 정리 추천 + 7일 추세 (`?accountId=<12자리\|__all__>`, 5분 캐시, 잘못된 ID 400) |
| `api/cost-radar/creators/route.ts` | 리소스 생성자 조회 (`?ids=계정:리전:리소스ID,...` 최대 50개, CloudTrail) |
| `api/cost-radar/explain/route.ts` | 돈 탐정 — 월 예상 비용이 왜 바뀌었는지 설명 (`?accountId=<12자리\|__all__>&days=1\|7\|30`, 스냅샷 + 변경 기록 기반, 새 CloudTrail/Steampipe 호출 없음, 잘못된 입력 400, 500은 오류 이름만, `no-store`) |
| `api/changes/creators/route.ts` | 리소스별 만든 사람 (`?ids=계정:리소스ID[|생성시각ISO],...` 최대 200개, 잘못된 형식 400) — S3·EC2·RDS 목록 배지용 |
| `api/changes/route.ts` | 변경 기록 조회 (`?accountId=<12자리\|__all__>&range=24h\|7d\|30d\|90d\|all&kind=create\|delete&actor=&type=&q=`, 잘못된 계정·기간·종류·서비스 400, 500은 오류 이름만, `no-store`) |
| `api/graph/route.ts` | 의존성 그래프 (읽기 전용 GET: `?op=stats\|search\|hubs\|neighborhood\|impact\|deps\|project`, `arn`(`arn:` 시작, 1024자 이하)·`depth`(범위 밖은 기본값)·`q`/`prefix`(100자 이하)·`tag=키=값`·`vpc=<arn>`(태그 키·값·접두어는 앞뒤 공백 제거, 공백뿐이면 400), `search`의 `type`(15종 중 하나, 아니면 400 "알 수 없는 리소스 종류예요"), `project` 응답에 `managed`·`edges`(후보끼리)·`warnings`(못 읽은 쿼리), 응답에 `builtAt`, 그래프 없으면 `200 {status:'building'}`, 모르는 arn·VPC 404, 잘못된 입력 400, 500은 오류 이름만) |
| `api/inventory/export/route.ts` | 인벤토리 XLSX 내보내기 (리소스별 시트 + Summary) |
| `api/diagram/route.ts` | 2D 다이어그램 PNG 생성 (라이브 쿼리 → Python 렌더러) |
| `api/diagram-chat/route.ts` | 다이어그램 채팅 — 자연어 → 다이어그램 생성 옵션 |
| `api/topology-chat/route.ts` | 토폴로지 채팅 — 자연어 → JSON 패치 / 생성 옵션 / 답변 |

## 규칙
- 모든 페이지 파일은 `'use client'`로 시작
- 모든 fetch URL에 `/api/*` 접두사 필수
- 컴포넌트 임포트는 `import X from '...'` (default export)
- StatsCard `color`는 이름('cyan') 사용 — hex 아님
- CloudWatch 메트릭 API: `execFileSync`로 AWS CLI 호출 (shell injection 방지)

---

# App Module (English)

## Role
Next.js 14 App Router pages and API routes. Each subdirectory is a route segment.

## Pages (45)

### Overview (5)
- `page.tsx` — Dashboard home (20 StatsCards, Cost availability detection, inventory snapshot, cache warmer status)
- `ai/page.tsx` — AI Assistant (real-time Bedrock streaming, multi-route, tool usage, per-user history, token cost)
- `agentcore/page.tsx` — AgentCore dashboard (Runtime/Gateway/Tools status, call stats, history search, cache status)
- `bedrock/page.tsx` — Bedrock Monitoring (per-model usage, token costs, prompt caching, Account vs AWSops comparison)
- `accounts/page.tsx` — Account Management (add/remove/test, admin-only via adminEmails config)

### Compute (6)
- `ec2/page.tsx` — EC2 instances + detail panel
- `lambda/page.tsx` — Lambda functions, runtimes
- `ecs/page.tsx` — ECS clusters/services/tasks
- `ecr/page.tsx` — ECR repositories/images
- `k8s/page.tsx` — EKS Overview (clusters, nodes, pod summary)
- `k8s/explorer/page.tsx` — K9s-style terminal UI

### EKS Sub-pages (4)
- `k8s/pods/page.tsx`, `k8s/nodes/page.tsx`, `k8s/deployments/page.tsx`, `k8s/services/page.tsx`

### Network & CDN (7)
- `vpc/page.tsx` — VPC/Subnet/SG/TGW/ELB/NAT/IGW + Resource Map
- `cloudfront-cdn/page.tsx` — CloudFront distributions
- `waf/page.tsx` — WAF Web ACLs/rules
- `topology/page.tsx` — Infra Map + K8s Map (React Flow)
- `topology-view/page.tsx` — Editable topology view + natural-language chat edits
- `dependency-graph/page.tsx` — Dependency graph (resource search -> React Flow map, affected-resources panel, project cleanup preview; guidance only)
- `diagram/page.tsx` — 2D report-style diagram (PNG) + natural-language chat

### Storage & DB (7)
- `ebs/page.tsx` — EBS volumes/snapshots (encryption, EC2 attachment mapping)
- `s3/page.tsx` — S3 buckets (TreeMap/search/IAM)
- `rds/page.tsx` — RDS instances (SG chaining/metrics/CloudWatch metrics table)
- `dynamodb/page.tsx` — DynamoDB tables
- `elasticache/page.tsx` — ElastiCache (Valkey/Redis/Memcached, node metrics table)
- `opensearch/page.tsx` — OpenSearch domains (encryption, VPC, domain metrics table)
- `msk/page.tsx` — MSK clusters (broker nodes + CPU/Memory/Network metrics)

### Diagnosis (2)
- `ai-diagnosis/page.tsx` — Comprehensive diagnosis (15-section AI analysis, TOC sidebar, multi-expand, PPTX/DOCX/PDF download)
- `ai-diagnosis/report/page.tsx` — Print-friendly report (browser Print-to-PDF, white background, A4 page breaks)

### Datasources (2)
- `datasources/page.tsx` — External datasource management (7 platforms CRUD, connection test, auth config)
- `datasources/explore/page.tsx` — Datasource Explore (direct query execution, AI query generation — natural language to PromQL/LogQL/TraceQL/SQL)

### Monitoring & Cost (8)
- `monitoring/page.tsx` — CPU/Memory/Network/Disk I/O
- `cloudwatch/page.tsx` — CloudWatch alarms
- `cloudtrail/page.tsx` — CloudTrail trails/events
- `changes/page.tsx` — Change timeline (who created / deleted which resource; Toss-style dark; Pretendard via `next/font/local`, this page only)
- `cost/page.tsx` — Cost Explorer (MSP auto-detect, snapshot fallback)
- `inventory/page.tsx` — Resource Inventory (count trends, cost impact estimation)
- `container-cost/page.tsx` — ECS Container Cost (Fargate pricing + Container Insights)
- `eks-container-cost/page.tsx` — EKS Container Cost (OpenCost + request-based fallback)
- `cost-radar/page.tsx` — Cost Radar (monthly cost estimate of switched-on resources + cleanup recommendations; guidance only, no button changes AWS resources)

### Security (3)
- `iam/page.tsx` — IAM users/roles/trust policies
- `security/page.tsx` — Public S3, Open SGs, Unencrypted EBS, CVE
- `compliance/page.tsx` — CIS v1.5~v4.0 benchmarks (431 controls)

## API Routes (28)

| API | Description |
|-----|------------|
| `api/ai/route.ts` | AI routing entry point — thin: only `GET`/`POST`; POST validates, then hands off to `handleNonStreaming` (JSON) or `runStreaming` (SSE) in `src/lib/ai/`. Classification, handlers, multi-route, SSE, tool inference and token tracking all live in `src/lib/ai/` (19 routes in the registry, `src/lib/ai/CLAUDE.md`) |
| `api/steampipe/route.ts` | Steampipe queries + Cost availability + Inventory |
| `api/auth/route.ts` | Logout — server-side HttpOnly cookie deletion |
| `api/msk/route.ts` | MSK broker nodes + CloudWatch metrics |
| `api/rds/route.ts` | RDS instance CloudWatch metrics |
| `api/elasticache/route.ts` | ElastiCache node CloudWatch metrics |
| `api/opensearch/route.ts` | OpenSearch domain CloudWatch metrics |
| `api/agentcore/route.ts` | AgentCore Runtime/Gateway status |
| `api/code/route.ts` | Code Interpreter |
| `api/benchmark/route.ts` | CIS compliance benchmark |
| `api/container-cost/route.ts` | ECS Container Cost (CloudWatch Container Insights + Fargate pricing) |
| `api/eks-container-cost/route.ts` | EKS Container Cost (OpenCost API + request-based fallback) |
| `api/bedrock-metrics/route.ts` | Bedrock model usage metrics (CloudWatch + AWSops app token stats) |
| `api/datasources/route.ts` | External datasource CRUD + query execution + AI query generation (SSRF-protected, admin-only query) |
| `api/k8s/route.ts` | EKS kubeconfig registration |
| `api/report/route.ts` | AI diagnosis report generation + S3 storage + scheduling + DOCX/MD/PDF download (`download-pdf` renders server-side via Puppeteer) |
| `api/notification/route.ts` | SNS email notifications (topic/subscription management, diagnosis completion alerts) |
| `api/health/route.ts` | Health monitor status (GET, starts the monitor) + test alert / run-now (POST, admin-only) |
| `api/cost-radar/route.ts` | Cost Radar — monthly cost estimate + cleanup recommendations + 7-day trend (`?accountId=<12-digit\|__all__>`, 5-min cache, 400 on invalid id) |
| `api/cost-radar/creators/route.ts` | Resource creator lookup (`?ids=account:region:resourceId,...`, max 50, CloudTrail) |
| `api/cost-radar/explain/route.ts` | Cost Detective — why the monthly estimate changed (`?accountId=<12-digit\|__all__>&days=1\|7\|30`, from snapshots + change records, no new CloudTrail/Steampipe calls, 400 on bad input, 500 carries the error name only, `no-store`) |
| `api/changes/creators/route.ts` | Creator per resource (`?ids=account:resourceId[|createdAtISO],...`, max 200, 400 on bad format) — badges on S3/EC2/RDS lists |
| `api/changes/route.ts` | Change timeline (`?accountId=<12-digit\|__all__>&range=24h\|7d\|30d\|90d\|all&kind=create\|delete&actor=&type=&q=`; 400 on bad account/range/kind/type, 500 carries the error name only, `no-store`) |
| `api/graph/route.ts` | Dependency graph (read-only GET: `?op=stats\|search\|hubs\|neighborhood\|impact\|deps\|project`; `arn` (starts with `arn:`, max 1024), `depth` (out of range uses default), `q`/`prefix` (max 100), `tag=key=value`, `vpc=<arn>` (tag key/value and prefix trimmed, whitespace-only is 400); `search` takes `type` (one of the 15 kinds, else 400); `project` responses add `managed`, `edges` (among members) and `warnings` (failed queries); responses carry `builtAt`; `200 {status:'building'}` until a graph exists; 404 unknown arn or VPC seed, 400 bad input, 500 carries the error name only) |
| `api/inventory/export/route.ts` | Inventory XLSX export (one sheet per resource type + Summary) |
| `api/diagram/route.ts` | 2D diagram PNG generation (live queries -> Python renderer) |
| `api/diagram-chat/route.ts` | Diagram chat — natural language -> diagram generation options |
| `api/topology-chat/route.ts` | Topology chat — natural language -> JSON patch / generator options / answer |

## Rules
- All page files start with `'use client'`
- All fetch URLs must use `/api/*` prefix
- Component imports: `import X from '...'` (default export)
- StatsCard `color`: names ('cyan') not hex
- CloudWatch metric APIs use `execFileSync` (no shell injection)
