# 의존성 그래프 (Dep Graph) 모듈

## 역할
AWS 리소스 15종(VPC, Subnet, ENI, EC2, SG, ELB, TG, RDS, Lambda, IAM Role, NAT, EIP, EBS, S3, CloudFront)의 관계를 Steampipe에서 뽑아 PGlite(메모리 안의 진짜 PostgreSQL)의 `nodes`/`edges` 테이블에 담고, 재귀 CTE로 "이걸 지우거나 바꾸면 뭐가 영향 받는지"를 계산한다. **안내만 한다 — 아무것도 지우거나 바꾸지 않는다.** 결정 배경: `docs/decisions/012-dependency-graph-postgres-cte.md`. 설계: `docs/superpowers/specs/2026-10-28-dependency-graph-design.md`.

## 방향 규칙
간선 `src → dst`는 **"src가 dst를 쓴다(의존한다)"**이다. 영향(impact)은 dst에서 간선을 거꾸로, 의존(deps)은 정방향, 정리는 의존하는 쪽(src)부터 지운다.

## 주요 파일
- `types.ts` — 공용 계약 타입 (`GraphNode`, `GraphEdge`, `NodeType` 15종, `EdgeType`, `BuildStats`, `Neighborhood`, `GraphImpact`).
- `queries.ts` — 종류마다 SQL 하나(20개). 필요한 컬럼만, `account_id`·`region` 포함, JSONB는 원본 그대로 가져와 TS에서 해석, `$` 금지, Lambda `tags` 금지(SCP). 역할은 둘로 나눈다: `role`(노드 컬럼 + `instance_profile_arns`)과 `rolePolicy`(`inline_policies_std`, `attached_policy_arns`) — 정책 읽기가 SCP 등으로 실패해도 역할 노드와 `uses_role`은 남고 `can_access`만 빠진다(경고 `rolePolicy`).
- `nodes.ts` — 행 → 노드(`buildNodes`, `sgRule`·`rolePolicy`·`policy`는 노드를 만들지 않음), ARN 없는 ENI의 ARN 만들기(`eniArn`), `(계정, 리소스ID)` → ARN 색인(`buildIndex`). ENI는 `attrs.requesterManaged`(AWS가 관리하는 ENI). 태그는 `attrs.tags`(리소스당 50개, 값 256자). 비밀값(Lambda 환경 변수, user data, 정책 원문)은 담지 않는다.
- `sink.ts` — `EdgeSink`: 간선 수집. 대상을 못 찾으면 버리고 `dropped`로 센다.
- `extract/` — 종류군별 관계 추출기. `network.ts`(VPC/Subnet/SG/ENI/NAT/EIP, ELB·Lambda ENI 설명으로 lb/lambda → eni), `compute.ts`(EC2/EBS/Lambda), `delivery.ts`(LB/TG/RDS/S3/CloudFront, RDS ENI), `iam.ts`(`rolePolicy` 행을 ARN으로 역할 노드에 맞춰 `can_access`, 정책 안의 정확한 ARN과 S3 `bucket/*`만, `*`·`?` 포함 ARN은 건너뜀), `util.ts`, `index.ts`(전체 실행). Lambda·LB·TG·RDS 행은 자기 노드를 **ARN으로** 찾는다(이름은 리전마다만 유일). Lambda ENI: 설명 `AWS Lambda VPC ENI-<이름>-<uuid>`, 실데이터의 Hyperplane ENI처럼 uuid가 없는 `AWS Lambda VPC ENI-<이름>`도 — 같은 계정·리전의 그 이름 람다 → eni, 못 찾으면 간선도 dropped도 없음. RDS ENI(설명 `RDSNetworkInterface`): 같은 계정에서 ENI 서브넷이 rds 서브넷 중 하나이고 SG 집합이 같은 모든 rds → eni(서브넷·SG가 같은 DB가 둘이면 둘 다 잇는다).
- `store.ts` — `createGraphStore(data, stats)`: PGlite 적재와 질의(`impact`/`dependencies` 깊이 기본 3·1–6, 선택 `{ edgeTypes }`로 따라갈 간선 종류 제한; `neighborhood` 기본 2·1–3, 쪽마다 150개(`SIDE_CAP`)·남는 예산은 반대쪽으로·합계 300 + 중심; `search` 20개, 선택 `type`; `hubs` 10개, `stats`). `UNION` over (노드, 깊이) + 깊이 상한(경로 배열 없음), 노드마다 최단 깊이, 300개 상한(`WALK_CAP`)과 `truncated`. `getCurrentStore`/`setCurrentStore`: 포인터를 갈아 끼우고 직전 인스턴스는 60초 뒤 닫는다. **되돌리지 않는다** — 지금 저장소의 `builtAt`이 더 새면 들어온 것을 닫고 `false`.
- `build.ts` — `collectRows`(`batchQuery`, 종류별 실패는 `warnings`), `rebuildGraph`(추출 → 저장소 적재 → 교체 → 스냅샷), `loadSnapshot`, `runBuildOnce(fn)`(프로세스 전체 잠금 `globalThis.__awsopsDepGraphBuild = { inflight, lastFailureAt }` — 빌드·스냅샷 적재는 한 번에 하나, 두 번째 호출은 같은 promise), `ensureGraph`(현재 저장소 → 빌드 중이면 바로 null → 스냅샷 → 없으면 빌드 시작 후 null, 둘 다 `runBuildOnce`로; 빌드 실패 뒤 60초(`REBUILD_COOLDOWN_MS`)는 새로 시작하지 않음). **모든 쿼리가 실패하면 `GraphSourceUnavailable`을 던지고 이전 그래프를 유지한다.**
- `loop.ts` — `ensureDepGraphStarted()`: `globalThis` 싱글턴, 프로덕션에서만. 기동하자마자 `runBuildOnce`로 스냅샷을 적재하고(실패는 이름만 로그) — 재시작 직후에도 Slack 카드에 그래프 줄이 나온다 — 60초 뒤 첫 빌드, 이후 15분마다. `tick`도 `runBuildOnce`를 써서 `ensureGraph`의 빌드와 겹치지 않는다(쿨다운은 무시). `src/instrumentation.ts`만 기동한다(`/api/graph`는 기동하지 않는다).
- `project.ts` — `previewProject(data, seed)`: 프로젝트 정리 미리보기(순수 TS). 씨앗(태그 `키=값` / 이름 접두어 / VPC ARN) → 후보(후보에서 **권한이 아닌** 간선으로 닿고, 들어오는 간선의 출발점이 모두 후보면 포함 — `can_access`·`allows_from`으로만 닿는 대상은 흡수하지 않고 `shared`로, 비멤버가 권한 간선으로 쓰고 있어도 빠짐) → `blockers`, `managed`(blockers 중 `attrs.requesterManaged`인 ENI — 연결된 서비스를 지우면 AWS가 같이 정리), `shared`, `edges`(후보끼리), 의존하는 쪽부터의 `order`(순환은 한 단계 + `cycle: true`).
- `api.ts` — `parseGraphRequest`(입력 검사: `search`의 `type`은 15종만, 태그 키·값·접두어는 공백 제거 후 비면 오류)와 `handleGraphRequest`(분기: `project` 응답에 `warnings`, 모르는 VPC 씨앗은 404). 순수 함수.
- `summary.ts` — `impactSummary(resourceId)`: 메모리 그래프만 읽는 보안그룹 영향 요약(`count`, `sample`, `builtAt`, `truncated`). 깊이 2에서 `uses_sg`·`uses_eni` 간선만 따라가(sg ← eni·instance·lb·rds·lambda, eni ← instance·lb·nat·lambda·rds) ENI가 아닌 것만 센다 — `allows_from` 보안그룹이나 서버 앞의 대상 그룹은 세지 않는다. 카드는 `N개`, 상한에 걸리면 `N+개`. `sg, eni, instance, alb, nlb, clb, rds, lambda, nat` 중 하나라도 경고면 숫자가 틀리므로 null. 빌드를 일으키지 않는다. 안전한 AI 실행 카드가 쓴다.
- 연결: `src/app/api/graph/route.ts`(GET 읽기 전용), `src/lib/action-plan/cards.ts`의 `graphImpact` 줄(참고용), 화면은 `src/app/dependency-graph/page.tsx` + `src/components/dep-graph/`.

## 주기와 저장
- 서버 기동 60초 뒤 첫 빌드, 이후 15분마다. 모든 빌드(루프·첫 요청)는 잠금 하나를 같이 써서 겹치지 않고, 프로덕션에서만 돈다. 그래서 그래프는 **최대 15분 늦을 수 있다** — 화면과 카드에 "N분 전 기준"을 보여 준다.
- 스냅샷: `data/graph/latest.json`(git 제외, 임시 파일에 쓴 뒤 rename). 기동할 때(프로덕션) 바로 적재하고, 그 전에 요청이 오면 첫 요청에서도 적재한다. 더 오래된 스냅샷은 더 새 그래프를 덮지 않는다.
- 일부 쿼리가 실패하면 그 이름이 `warnings`에 남고 화면의 빌드 줄("일부 종류를 못 읽었어요")과 정리 탭 경고에 보인다.
- 실측(공유 샌드박스 계정, 2026-10-28): 쿼리 19/19 성공 약 8초, 노드 230 · 간선 274 · dropped 0. 같은 계정 덤프로 이번 수정 뒤 다시 추출: 노드 214 · 간선 280 · dropped 0, Lambda→ENI 2 · RDS→ENI 4.

## 관계 표 요약
`in_vpc`(subnet/sg/tg → vpc), `in_subnet`(instance/eni/nat/lb/rds/lambda → subnet), `uses_sg`(instance/eni/lb/rds/lambda → sg), `allows_from`(sg → sg), `uses_role`(instance/lambda → role), `uses_volume`(instance → ebs), `uses_eni`(instance/lb/nat/lambda/rds → eni), `uses_eip`(eni·instance/nat → eip), `forwards_to`(lb → tg), `targets`(tg → instance/lambda), `can_access`(role → 리소스), `notifies`(s3 → lambda), `origin`(cloudfront → s3/lb). 전체 근거 컬럼은 설계 문서의 "관계 목록".

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
- `queries.ts` — one SQL per kind (20). Only needed columns incl. `account_id` and `region`; JSONB fetched raw and parsed in TS; no `$`; no Lambda `tags` (SCP). Roles are split: `role` (node columns + `instance_profile_arns`) and `rolePolicy` (`inline_policies_std`, `attached_policy_arns`) — if the policy read fails (SCP etc.) role nodes and `uses_role` stay, only `can_access` is missing (warning `rolePolicy`).
- `nodes.ts` — rows to nodes (`buildNodes`; `sgRule`, `rolePolicy`, `policy` make no nodes), ARN for ENIs that have none (`eniArn`), `(account, resourceId)` to ARN index (`buildIndex`). ENIs carry `attrs.requesterManaged`. Tags in `attrs.tags` (50 per resource, 256-char values). No secrets (Lambda env vars, user data, policy documents).
- `sink.ts` — `EdgeSink`: collects edges; unresolved targets are dropped and counted in `dropped`.
- `extract/` — relationship extractors by group: `network.ts` (VPC/Subnet/SG/ENI/NAT/EIP; lb/lambda → eni from ELB and Lambda ENI descriptions), `compute.ts` (EC2/EBS/Lambda), `delivery.ts` (LB/TG/RDS/S3/CloudFront, RDS ENIs), `iam.ts` (`rolePolicy` rows matched to role nodes by ARN → `can_access`; exact ARNs and S3 `bucket/*` only, ARNs containing `*` or `?` skipped), `util.ts`, `index.ts` (runs all). Lambda, LB, TG and RDS rows resolve their own node **by ARN** (names are only unique per region). Lambda ENI: description `AWS Lambda VPC ENI-<name>-<uuid>`, or `AWS Lambda VPC ENI-<name>` without a uuid as real Hyperplane ENIs show — links the lambda of that name in the same account and region; no match adds nothing and is not dropped. RDS ENI (`RDSNetworkInterface`): every rds in the same account whose subnets include the ENI's subnet and whose SG set equals the ENI's (two DBs sharing subnets and SGs both link).
- `store.ts` — `createGraphStore(data, stats)`: PGlite load and queries (`impact`/`dependencies` default depth 3, range 1-6, optional `{ edgeTypes }` filter; `neighborhood` default 2, range 1-3, up to 150 per side (`SIDE_CAP`) with unused budget going to the other side, total 300 + center; `search` 20 with optional `type`; `hubs` 10; `stats`). `UNION` over (node, depth) with a depth bound (no path arrays), min depth per node, 300-node cap (`WALK_CAP`) with `truncated`. `getCurrentStore`/`setCurrentStore` swap the pointer and close the previous instance after 60 s; **no rollback** — if the current store's `builtAt` is newer, the incoming one is closed and `false` returned.
- `build.ts` — `collectRows` (`batchQuery`; per-kind failures go to `warnings`), `rebuildGraph` (extract, load store, swap, snapshot), `loadSnapshot`, `runBuildOnce(fn)` (one process-wide lock on `globalThis.__awsopsDepGraphBuild = { inflight, lastFailureAt }`: one build or snapshot load at a time, a second caller gets the same promise), `ensureGraph` (current store → null at once while building → snapshot → else start a build and return null, both through `runBuildOnce`; no new build for 60 s (`REBUILD_COOLDOWN_MS`) after a failure). **If every query fails it throws `GraphSourceUnavailable` and keeps the previous graph.**
- `loop.ts` — `ensureDepGraphStarted()`: `globalThis` singleton, production only. Loads the snapshot at once through `runBuildOnce` (errors logged by name) so Slack cards have graph lines right after a restart, then first build 60 s after boot and every 15 min. `tick` uses `runBuildOnce` too, so it never overlaps an `ensureGraph` build (it ignores the cooldown). Started from `src/instrumentation.ts` only (not from `/api/graph`).
- `project.ts` — `previewProject(data, seed)`: project cleanup preview (pure TS). Seed (tag `key=value` / name prefix / VPC ARN) -> candidates (a node joins when a member reaches it through a **non-permission** edge and every edge into it comes from a member; targets reached only via `can_access`/`allows_from` go to `shared`, and a non-member permission edge keeps a target out) -> `blockers`, `managed` (blockers that are `attrs.requesterManaged` ENIs; AWS removes them with their service), `shared`, `edges` (among members), dependents-first `order` (cycles as one step with `cycle: true`).
- `api.ts` — `parseGraphRequest` (validation: `search` `type` must be one of the 15 kinds; tag key/value and prefix are trimmed, empty is an error) and `handleGraphRequest` (dispatch; `project` adds `warnings`, unknown VPC seed is 404). Pure.
- `summary.ts` — `impactSummary(resourceId)`: SG impact summary read from the in-memory graph only (`count`, `sample`, `builtAt`, `truncated`). Walks depth 2 over `uses_sg`/`uses_eni` only (sg ← eni/instance/lb/rds/lambda, eni ← instance/lb/nat/lambda/rds) and counts non-ENI nodes, so `allows_from` SGs and target groups in front of a server are not counted. The card shows `N개`, or `N+개` when capped. Returns null when any of `sg, eni, instance, alb, nlb, clb, rds, lambda, nat` is in the build warnings (the count would be wrong). Never triggers a build. Used by the safe-AI-actions card.
- Wiring: `src/app/api/graph/route.ts` (read-only GET), the `graphImpact` line in `src/lib/action-plan/cards.ts` (informational), UI in `src/app/dependency-graph/page.tsx` + `src/components/dep-graph/`.

## Timings and Storage
- First build 60 s after boot, then every 15 min; every build (loop or first request) shares one lock, so they never overlap; production only. So the graph can be **up to 15 minutes stale** — the screen and cards show "as of N minutes ago".
- Snapshot: `data/graph/latest.json` (git-ignored, written via temp file + rename). Loaded at boot (production) and, if a request comes first, on that request. An older snapshot never replaces a newer graph.
- Failed queries stay in `warnings`; the screen names them on the build line and warns on the cleanup tab.
- Real-data dry run (shared sandbox account, 2026-10-28): 19/19 queries in about 8 s, 230 nodes, 274 edges, 0 dropped. Re-extracted from the same account's dump after this fix wave: 214 nodes, 280 edges, 0 dropped, Lambda→ENI 2, RDS→ENI 4.

## Relation Table Summary
`in_vpc` (subnet/sg/tg -> vpc), `in_subnet` (instance/eni/nat/lb/rds/lambda -> subnet), `uses_sg` (instance/eni/lb/rds/lambda -> sg), `allows_from` (sg -> sg), `uses_role` (instance/lambda -> role), `uses_volume` (instance -> ebs), `uses_eni` (instance/lb/nat/lambda/rds -> eni), `uses_eip` (eni or instance / nat -> eip), `forwards_to` (lb -> tg), `targets` (tg -> instance/lambda), `can_access` (role -> resource), `notifies` (s3 -> lambda), `origin` (cloudfront -> s3/lb). Source columns for each row are in the spec's "관계 목록".

## Rules
- Guidance only. Never change AWS and never write to Steampipe's database (`runQuery()` is SELECT-only).
- Graph numbers never decide allow/deny. Policy (`action-plan/policy.ts`) keeps using live AWS reads.
- Every response carries `builtAt`; errors carry the name only.
- Adding an extractor: (1) add `NodeType`/`EdgeType`/`QueryName` in `types.ts`; (2) add the SQL in `queries.ts` (verify columns via `information_schema.columns`); (3) node mapping in `nodes.ts`; (4) write the extractor under `extract/` and wire it in `extract/index.ts`; (5) fixture tests in `__tests__/`; (6) UI color/label per kind, then update this doc and the spec.
