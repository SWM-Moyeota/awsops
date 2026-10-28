# 의존성 그래프 (Dep Graph) 모듈

## 역할
AWS 리소스 15종(VPC, Subnet, ENI, EC2, SG, ELB, TG, RDS, Lambda, IAM Role, NAT, EIP, EBS, S3, CloudFront)의 관계를 Steampipe에서 뽑아 PGlite(메모리 안의 진짜 PostgreSQL)의 `nodes`/`edges` 테이블에 담고, 재귀 CTE로 "이걸 지우거나 바꾸면 뭐가 영향 받는지"를 계산한다. **안내만 한다 — 아무것도 지우거나 바꾸지 않는다.** 결정 배경: `docs/decisions/012-dependency-graph-postgres-cte.md`. 설계: `docs/superpowers/specs/2026-10-28-dependency-graph-design.md`.

## 방향 규칙
간선 `src → dst`는 **"src가 dst를 쓴다(의존한다)"**이다. 영향(impact)은 dst에서 간선을 거꾸로, 의존(deps)은 정방향, 정리는 의존하는 쪽(src)부터 지운다.

## 주요 파일
- `types.ts` — 공용 계약 타입 (`GraphNode`, `GraphEdge`, `NodeType` 15종, `EdgeType`, `BuildStats`, `Neighborhood`, `GraphImpact`).
- `queries.ts` — 종류마다 SQL 하나(19개). 필요한 컬럼만, `account_id`·`region` 포함, JSONB는 원본 그대로 가져와 TS에서 해석, `$` 금지, Lambda `tags` 금지(SCP).
- `nodes.ts` — 행 → 노드(`buildNodes`), ARN 없는 ENI의 ARN 만들기(`eniArn`), `(계정, 리소스ID)` → ARN 색인(`buildIndex`). 태그는 `attrs.tags`(리소스당 50개, 값 256자). 비밀값(Lambda 환경 변수, user data, 정책 원문)은 담지 않는다.
- `sink.ts` — `EdgeSink`: 간선 수집. 대상을 못 찾으면 버리고 `dropped`로 센다.
- `extract/` — 종류군별 관계 추출기. `network.ts`(VPC/Subnet/SG/ENI/NAT/EIP), `compute.ts`(EC2/EBS/RDS/Lambda), `delivery.ts`(LB/TG/S3/CloudFront), `iam.ts`(역할 → 리소스 `can_access`, 정책 안의 정확한 ARN과 S3 `bucket/*`만, `*`·`?` 포함 ARN은 건너뜀), `util.ts`, `index.ts`(전체 실행).
- `store.ts` — `createGraphStore(data, stats)`: PGlite 적재와 질의(`impact`/`dependencies` 깊이 기본 3·1–6, `neighborhood` 기본 2·1–3, `search` 20개, `hubs` 10개, `stats`). `UNION` over (노드, 깊이) + 깊이 상한(경로 배열 없음), 노드마다 최단 깊이, 300개 상한(`WALK_CAP`)과 `truncated`. `getCurrentStore`/`setCurrentStore`: 포인터를 갈아 끼우고 직전 인스턴스는 60초 뒤 닫는다.
- `build.ts` — `collectRows`(`batchQuery`, 종류별 실패는 `warnings`), `rebuildGraph`(추출 → 저장소 적재 → 교체 → 스냅샷), `loadSnapshot`, `ensureGraph`(스냅샷 → 없으면 빌드 시작). **모든 쿼리가 실패하면 `GraphSourceUnavailable`을 던지고 이전 그래프를 유지한다.**
- `loop.ts` — `ensureDepGraphStarted()`: `globalThis` 싱글턴, 기동 60초 뒤 첫 빌드, 이후 15분마다, 겹치지 않음, 프로덕션에서만. `src/instrumentation.ts`와 `/api/graph`가 기동한다.
- `project.ts` — `previewProject(data, seed)`: 프로젝트 정리 미리보기(순수 TS). 씨앗(태그 `키=값` / 이름 접두어 / VPC ARN) → 후보(쓰는 모든 곳이 후보 안이면 포함) → `blockers`, `shared`, 의존하는 쪽부터의 `order`(순환은 한 단계 + `cycle: true`).
- `api.ts` — `parseGraphRequest`(입력 검사)와 `handleGraphRequest`(분기). 순수 함수.
- `summary.ts` — `impactSummary(arn)`: 메모리 그래프만 읽는 영향 요약(`count`, `sample`, `builtAt`). 빌드를 일으키지 않는다. 안전한 AI 실행 카드가 쓴다.
- 연결: `src/app/api/graph/route.ts`(GET 읽기 전용), `src/lib/action-plan/cards.ts`의 `graphImpact` 줄(참고용), 화면은 `src/app/dependency-graph/page.tsx` + `src/components/dep-graph/`.

## 주기와 저장
- 서버 기동 60초 뒤 첫 빌드, 이후 15분마다. 겹치지 않고 프로덕션에서만 돈다. 그래서 그래프는 **최대 15분 늦을 수 있다** — 화면과 카드에 "N분 전 기준"을 보여 준다.
- 스냅샷: `data/graph/latest.json`(git 제외, 임시 파일에 쓴 뒤 rename). 재시작하면 이 파일을 먼저 적재한다.
- 실측(공유 샌드박스 계정, 2026-10-28): 쿼리 19/19 성공 약 8초, 노드 230 · 간선 274 · dropped 0.

## 관계 표 요약
`in_vpc`(subnet/sg/tg → vpc), `in_subnet`(instance/eni/nat/lb/rds/lambda → subnet), `uses_sg`(instance/eni/lb/rds/lambda → sg), `allows_from`(sg → sg), `uses_role`(instance/lambda → role), `uses_volume`(instance → ebs), `uses_eni`(instance/lb/nat → eni), `uses_eip`(eni·instance/nat → eip), `forwards_to`(lb → tg), `targets`(tg → instance/lambda), `can_access`(role → 리소스), `notifies`(s3 → lambda), `origin`(cloudfront → s3/lb). 전체 근거 컬럼은 설계 문서의 "관계 목록".

## 규칙
- 안내만 한다. AWS를 바꾸거나 Steampipe DB에 쓰지 않는다 (`runQuery()`는 SELECT 전용).
- 그래프 숫자로 허용·거부를 판단하지 않는다. 정책(`action-plan/policy.ts`)은 실시간 AWS 조회를 쓴다.
- 응답에는 항상 `builtAt`을 넣고, 오류는 이름만 낸다.
- 새 추출기를 추가하려면: ① `types.ts`에 `NodeType`/`EdgeType`/`QueryName` 추가, ② `queries.ts`에 SQL 추가(`information_schema.columns`로 컬럼 확인), ③ `nodes.ts`에 노드 변환, ④ `extract/`에 추출 함수를 만들어 `extract/index.ts`에 연결, ⑤ fixture 테스트(`__tests__/`), ⑥ 화면의 종류별 색·라벨, 이 문서와 설계 문서 갱신.

---

# Dep Graph Module (English)

## Role
Extracts relationships between 15 AWS resource kinds (VPC, Subnet, ENI, EC2, SG, ELB, TG, RDS, Lambda, IAM Role, NAT, EIP, EBS, S3, CloudFront) from Steampipe into `nodes`/`edges` tables in PGlite (real PostgreSQL in memory) and answers "what is affected if I delete or change this" with recursive CTEs. **Guidance only — it never deletes or changes anything.** Why: `docs/decisions/012-dependency-graph-postgres-cte.md`. Spec: `docs/superpowers/specs/2026-10-28-dependency-graph-design.md`.

## Direction Rule
Edge `src -> dst` means **"src uses (depends on) dst"**. Impact walks edges backwards from dst, deps walks forwards, cleanup deletes the dependent side (src) first.

## Key Files
- `types.ts` — contract types (`GraphNode`, `GraphEdge`, `NodeType` x15, `EdgeType`, `BuildStats`, `Neighborhood`, `GraphImpact`).
- `queries.ts` — one SQL per kind (19). Only needed columns incl. `account_id` and `region`; JSONB fetched raw and parsed in TS; no `$`; no Lambda `tags` (SCP).
- `nodes.ts` — rows to nodes (`buildNodes`), ARN for ENIs that have none (`eniArn`), `(account, resourceId)` to ARN index (`buildIndex`). Tags in `attrs.tags` (50 per resource, 256-char values). No secrets (Lambda env vars, user data, policy documents).
- `sink.ts` — `EdgeSink`: collects edges; unresolved targets are dropped and counted in `dropped`.
- `extract/` — relationship extractors by group: `network.ts` (VPC/Subnet/SG/ENI/NAT/EIP), `compute.ts` (EC2/EBS/RDS/Lambda), `delivery.ts` (LB/TG/S3/CloudFront), `iam.ts` (role to resource `can_access`; exact ARNs and S3 `bucket/*` only, ARNs containing `*` or `?` skipped), `util.ts`, `index.ts` (runs all).
- `store.ts` — `createGraphStore(data, stats)`: PGlite load and queries (`impact`/`dependencies` default depth 3, range 1-6; `neighborhood` default 2, range 1-3; `search` 20; `hubs` 10; `stats`). `UNION` over (node, depth) with a depth bound (no path arrays), min depth per node, 300-node cap (`WALK_CAP`) with `truncated`. `getCurrentStore`/`setCurrentStore` swap the pointer and close the previous instance after 60 s.
- `build.ts` — `collectRows` (`batchQuery`; per-kind failures go to `warnings`), `rebuildGraph` (extract, load store, swap, snapshot), `loadSnapshot`, `ensureGraph` (snapshot first, else start a build). **If every query fails it throws `GraphSourceUnavailable` and keeps the previous graph.**
- `loop.ts` — `ensureDepGraphStarted()`: `globalThis` singleton, first build 60 s after boot, then every 15 min, never overlapping, production only. Started from `src/instrumentation.ts` and `/api/graph`.
- `project.ts` — `previewProject(data, seed)`: project cleanup preview (pure TS). Seed (tag `key=value` / name prefix / VPC ARN) -> candidates (a used node joins when all its users are candidates) -> `blockers`, `shared`, dependents-first `order` (cycles as one step with `cycle: true`).
- `api.ts` — `parseGraphRequest` (input validation) and `handleGraphRequest` (dispatch). Pure.
- `summary.ts` — `impactSummary(arn)`: impact summary read from the in-memory graph only (`count`, `sample`, `builtAt`); never triggers a build. Used by the safe-AI-actions card.
- Wiring: `src/app/api/graph/route.ts` (read-only GET), the `graphImpact` line in `src/lib/action-plan/cards.ts` (informational), UI in `src/app/dependency-graph/page.tsx` + `src/components/dep-graph/`.

## Timings and Storage
- First build 60 s after boot, then every 15 min; never overlapping; production only. So the graph can be **up to 15 minutes stale** — the screen and cards show "as of N minutes ago".
- Snapshot: `data/graph/latest.json` (git-ignored, written via temp file + rename). On restart it is loaded first.
- Real-data dry run (shared sandbox account, 2026-10-28): 19/19 queries in about 8 s, 230 nodes, 274 edges, 0 dropped.

## Relation Table Summary
`in_vpc` (subnet/sg/tg -> vpc), `in_subnet` (instance/eni/nat/lb/rds/lambda -> subnet), `uses_sg` (instance/eni/lb/rds/lambda -> sg), `allows_from` (sg -> sg), `uses_role` (instance/lambda -> role), `uses_volume` (instance -> ebs), `uses_eni` (instance/lb/nat -> eni), `uses_eip` (eni or instance / nat -> eip), `forwards_to` (lb -> tg), `targets` (tg -> instance/lambda), `can_access` (role -> resource), `notifies` (s3 -> lambda), `origin` (cloudfront -> s3/lb). Source columns for each row are in the spec's "관계 목록".

## Rules
- Guidance only. Never change AWS and never write to Steampipe's database (`runQuery()` is SELECT-only).
- Graph numbers never decide allow/deny. Policy (`action-plan/policy.ts`) keeps using live AWS reads.
- Every response carries `builtAt`; errors carry the name only.
- Adding an extractor: (1) add `NodeType`/`EdgeType`/`QueryName` in `types.ts`; (2) add the SQL in `queries.ts` (verify columns via `information_schema.columns`); (3) node mapping in `nodes.ts`; (4) write the extractor under `extract/` and wire it in `extract/index.ts`; (5) fixture tests in `__tests__/`; (6) UI color/label per kind, then update this doc and the spec.
