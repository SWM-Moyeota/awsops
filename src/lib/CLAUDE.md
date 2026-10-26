# 라이브러리 모듈

## 역할
핵심 라이브러리: Steampipe 데이터베이스 연결, SQL 쿼리 정의, 인벤토리, 설정 관리.

## 주요 파일
- `steampipe.ts` — pg 풀 + 배치 쿼리 + 캐시 + Cost 가용성 + buildSearchPath + runCostQueriesPerAccount
- `resource-inventory.ts` — 리소스 인벤토리 스냅샷 (data/inventory/, 계정별 디렉토리)
- `cost-snapshot.ts` — Cost 데이터 스냅샷 폴백 (data/cost/, 계정별)
- `app-config.ts` — 앱 설정 (costEnabled, agentRuntimeArn, accounts[], customerLogo, adminEmails 등)
- `cache-warmer.ts` — 백그라운드 캐시 프리워밍 (대시보드 쿼리 38개, 4분 주기, lazy-init — 모니터링 쿼리는 풀 고갈 방지 위해 제외)
- `health/` — 서버 내장 헬스 모니터 (checks, state, slack, monitor — 5분 루프 + AgentCore 호출 훅, Slack 장애/복구 알림, data/health-status.json)
- `agentcore-stats.ts` — AgentCore 호출 통계 + 모델별 토큰 사용량 추적 (data/agentcore-stats.json)
- `agentcore-memory.ts` — 대화 이력 저장/검색, 사용자별 분리 (data/memory/)
- `auth-utils.ts` — Cognito JWT에서 사용자 정보 추출 (Lambda@Edge 검증 후 payload 디코딩)
- `eks-optimize-queries.ts` — EKS 리소스 최적화 (Prometheus 메트릭 디스커버리 + K8s 리소스 수집 + 비용 분석 프롬프트)
- `report-pptx.ts` — PPTX 리포트 생성 (WADD 스타일: 타이틀바, 요약바, 2컬럼/카드 레이아웃, 인라인 테이블, 마크다운 파싱)
- `report-docx.ts` — DOCX 리포트 생성 (docx 패키지, A4/라이트 테마, TOC, 마크다운→문단/테이블/블릿 변환, 헤더/푸터/페이지 번호)
- `report-pdf.ts` — PDF 리포트 생성 (puppeteer-core + marked, Playwright Chromium 바이너리 사용, CJK/컬러 이모지 폰트 — `scripts/02-setup-nextjs.sh`가 폰트/Chromium 설치)
- `report-scheduler.ts` — 리포트 스케줄러 (주기적 자동 진단, weekly/biweekly/monthly, KST 기준, data/report-schedule.json)
- `report-generator.ts` / `report-prompts.ts` — 진단 데이터 수집 오케스트레이터 / 15섹션 진단 프롬프트 정의
- `datasource-client.ts` / `datasource-registry.ts` / `datasource-prompts.ts` — 외부 데이터소스 HTTP 클라이언트(7종, SSRF 방지) / 타입 레지스트리 / AI 쿼리 생성 프롬프트
- `sns-notification.ts` — SNS 이메일 알림 (토픽 생성, 구독 동기화, 진단 완료 발행)
- `collectors/` — auto-collect 에이전트 (db-optimize, eks-optimize, idle-scan, incident, msk-optimize, trace-analyze — 공통 `Collector` 인터페이스)
- `cost-radar/` — 비용 레이더 (수집·가격 추정·정리 추천·생성자 조회·일별 이력, 안내만) — 상세는 `cost-radar/CLAUDE.md`
- `slack-chatops/` — Slack ChatOps 봇 (Socket Mode, `@AWSops` 멘션 → `/api/ai` → 스레드 답글, `src/instrumentation.ts`에서 기동) — 상세는 `slack-chatops/CLAUDE.md`
- `slack-control/` — Slack 2단계 승인 EC2 시작/정지/재부팅 (규칙 기반 해석, 메모리 상태 머신, 태그 조건 IAM 역할) — 상세는 `slack-control/CLAUDE.md`
- `change-timeline/` — 변경 기록 (CloudTrail 생성·삭제 수집, 월별 JSON 저장, 조회, Slack 질문·아침 요약) — 상세는 `change-timeline/CLAUDE.md`
- `cloudtrail-access.ts` — CloudTrail 공용 호출 간격(계정·리전당 초당 1회(1 request/s, 공유 limiter), globalThis) + 교차 계정 자격 증명 캐시 (변경 기록·비용 레이더 생성자 조회가 공유)
- `queries/*.ts` — 26개 SQL 쿼리 파일 (idle-resources, ebs, msk, opensearch, container-cost, eks-container-cost, bedrock 포함)

## 규칙
- 모든 DB 접근은 `steampipe.ts`의 `runQuery()` 또는 `batchQuery()`를 통해 수행
- Steampipe CLI 사용 금지 — pg Pool이 660배 빠름
- Steampipe는 `--database-listen network`으로 실행 (VPC Lambda :9193 접근)
- 쿼리 작성 전 `information_schema.columns`로 컬럼명 확인
- JSONB 중첩 주의: MSK `provisioned`, OpenSearch `encryption_at_rest_options`, ElastiCache `cache_nodes`
- SQL에서 `$` 사용 금지
- 목록 쿼리에서 SCP 차단 컬럼 사용 금지

---

# Lib Module (English)

## Role
Core libraries: Steampipe database connection, SQL query definitions, inventory, config management.

## Key Files
- `steampipe.ts` — pg Pool + batchQuery + cache + Cost probe + buildSearchPath + runCostQueriesPerAccount
- `resource-inventory.ts` — Resource inventory snapshots (data/inventory/, per-account directories)
- `cost-snapshot.ts` — Cost data snapshot fallback (data/cost/, per-account)
- `app-config.ts` — App config (costEnabled, agentRuntimeArn, accounts[], customerLogo, adminEmails, etc.)
- `cache-warmer.ts` — Background cache pre-warming (38 dashboard queries, 4-min interval, lazy-init — monitoring queries excluded to prevent pool exhaustion)
- `health/` — In-server health monitor (checks, state, slack, monitor — 5-min loop + AgentCore invoke hook, Slack fail/recovery alerts, data/health-status.json)
- `agentcore-stats.ts` — AgentCore call stats + per-model token usage tracking (data/agentcore-stats.json)
- `agentcore-memory.ts` — Conversation history save/search, per-user isolation (data/memory/)
- `auth-utils.ts` — Extract Cognito user from JWT (payload decode after Lambda@Edge verification)
- `eks-optimize-queries.ts` — EKS resource optimization (Prometheus metric discovery + K8s resource collection + cost analysis prompt)
- `report-pptx.ts` — PPTX report generation (WADD-style: title bars, summary bars, 2-column/card layouts, inline tables, markdown parsing)
- `report-docx.ts` — DOCX report generation (docx package, A4/light theme, TOC, markdown→paragraph/table/bullet conversion, header/footer/page numbers)
- `report-pdf.ts` — PDF report generation (puppeteer-core + marked, uses Playwright Chromium binary, CJK/color-emoji fonts — installed by `scripts/02-setup-nextjs.sh`)
- `report-scheduler.ts` — Report scheduler (periodic auto-diagnosis, weekly/biweekly/monthly, KST-based, data/report-schedule.json)
- `report-generator.ts` / `report-prompts.ts` — Diagnosis data collection orchestrator / 15-section diagnosis prompt definitions
- `datasource-client.ts` / `datasource-registry.ts` / `datasource-prompts.ts` — External datasource HTTP clients (7 platforms, SSRF-protected) / type registry / AI query generation prompts
- `sns-notification.ts` — SNS email notifications (topic creation, subscription sync, diagnosis completion publish)
- `collectors/` — Auto-collect agents (db-optimize, eks-optimize, idle-scan, incident, msk-optimize, trace-analyze — shared `Collector` interface)
- `cost-radar/` — Cost Radar (collection, price estimate, cleanup recommendations, creator lookup, daily history; guidance only) — see `cost-radar/CLAUDE.md`
- `slack-chatops/` — Slack ChatOps bot (Socket Mode, `@AWSops` mention → `/api/ai` → thread reply, started from `src/instrumentation.ts`) — see `slack-chatops/CLAUDE.md`
- `slack-control/` — Two-step-approved EC2 start/stop/reboot from Slack (rule-based parsing, in-memory state machine, tag-conditioned IAM role) — see `slack-control/CLAUDE.md`
- `change-timeline/` — Change timeline (CloudTrail create/delete ingest, monthly JSON store, queries, Slack question + morning summary) — see `change-timeline/CLAUDE.md`
- `cloudtrail-access.ts` — Shared CloudTrail pacing (1 request/s per account+region, shared limiter, globalThis) + cross-account credential cache (change timeline and Cost Radar creators)
- `queries/*.ts` — 26 SQL query files (incl. idle-resources, ebs, msk, opensearch, container-cost, eks-container-cost, bedrock)

## Rules
- ALL database access through `runQuery()` or `batchQuery()` in steampipe.ts
- Never use Steampipe CLI — pg Pool is 660x faster
- Steampipe runs with `--database-listen network` (VPC Lambda access on :9193)
- Verify column names via `information_schema.columns` before writing queries
- Watch JSONB nesting: MSK `provisioned`, OpenSearch `encryption_at_rest_options`, ElastiCache `cache_nodes`
- No `$` in SQL. Avoid SCP-blocked columns in list queries.
