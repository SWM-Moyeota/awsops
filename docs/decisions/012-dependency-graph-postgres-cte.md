# ADR-012: Dependency Graph on Postgres Recursive CTE (PGlite) / Postgres 재귀 CTE(PGlite)로 만드는 의존성 그래프

## Status: Accepted / 상태: 승인됨 (2026-10-28)

## Context / 컨텍스트

Relationships between AWS resources are scattered: an instance's `SubnetId`, a network interface's `Groups`, a target group's target list, the `Resource` ARNs inside IAM policies. So "what breaks if I delete this security group?" and "what do I delete, and in what order, to clean up a whole project?" have no direct answer. The safe-AI-actions cards (ADR-011) also want a reference line about blast radius.

AWS 리소스끼리의 관계는 여러 곳에 흩어져 있다. 서버의 `SubnetId`, 네트워크 인터페이스의 `Groups`, 대상 그룹의 타깃 목록, IAM 정책 안의 `Resource` ARN 같은 곳이다. 그래서 "이 보안그룹을 지우면 뭐가 깨지지?", "프로젝트를 통째로 정리하려면 뭘 어떤 순서로 지워야 하지?"에 바로 답할 수 없다. 안전한 AI 실행 카드(ADR-011)에도 영향 범위 참고 줄이 필요하다.

## Decision / 결정

Extract the relationships ourselves into an `edges(src_arn, dst_arn, type)` table (plus `nodes`) and answer impact questions with a **recursive CTE**, running in **PGlite** (real PostgreSQL compiled to WASM, in the Node process, in memory) (`src/lib/dep-graph/`).

관계를 직접 뽑아 `edges(src_arn, dst_arn, type)` 테이블(과 `nodes`)에 담고, **재귀 CTE**로 영향 범위를 계산한다. 저장소는 **PGlite**다 — WASM으로 Node 프로세스 안에서 메모리로 도는 진짜 PostgreSQL이다.

1. **Direction rule** — edge `src -> dst` means "src uses (depends on) dst". Impact walks edges backwards from dst; cleanup deletes the dependent side first.
2. **Build from Steampipe, read-only** — one SELECT per resource kind (20 queries; role policies are read by a separate `rolePolicy` query so an SCP-blocked policy read keeps the roles) through the existing `batchQuery()` pool; nothing is written to Steampipe's database and no AWS resource is changed.
3. **Swap, not mutate** — every rebuild loads a fresh in-memory PGlite and swaps the pointer, so readers always see a complete graph; the previous instance closes after 60 s, and an older build never replaces a newer one. All builds and snapshot loads (the loop started from `src/instrumentation.ts` and the first API request) share one process-wide lock (`runBuildOnce`); after a failed build the API waits 60 s before trying again. The last result is saved to `data/graph/latest.json` and loaded at boot (and on the first request if that comes first).
4. **Bounded walks** — `UNION` over `(node, depth)` with a depth bound (no path arrays) so cycles such as sg <-> sg stop and rows stay at most nodes x (depth+1); minimum depth per node; 300-node cap with `truncated`.
5. **Display only** — the graph feeds the `/dependency-graph` screen, a reference line on action cards (`impactSummary(resourceId)`: only `uses_sg`/`uses_eni` edges, depth 2, non-ENI nodes, `N+` when capped, no line when a kind it depends on failed) and the project-cleanup preview (permission edges `can_access`/`allows_from` never make a member own its target; AWS-managed ENIs are listed apart as `managed`). Policy checks (for example the ENI limit in ADR-011) keep using live AWS reads.

- 방향 규칙: 간선 `src -> dst`는 "src가 dst를 쓴다"이다. 영향은 dst에서 거꾸로, 정리는 의존하는 쪽부터.
- Steampipe에서 읽기만 한다 — 종류마다 SELECT 하나(20개, 역할 정책은 `rolePolicy`로 따로 읽어 실패해도 역할은 남는다), 기존 풀 사용. Steampipe DB에 쓰지 않고 AWS도 바꾸지 않는다.
- 갈아 끼우기 — 빌드마다 새 PGlite에 적재한 뒤 포인터를 바꾼다. 직전 인스턴스는 60초 뒤 닫고, 더 오래된 빌드로는 되돌리지 않는다. 빌드와 스냅샷 적재는 잠금 하나(`runBuildOnce`)를 같이 쓴다 — 루프는 `src/instrumentation.ts`가 기동하고, 첫 API 요청도 같은 잠금을 쓴다. 빌드가 실패하면 API는 60초 동안 다시 시작하지 않는다. 결과는 `data/graph/latest.json`에 저장하고 기동할 때(먼저 온 요청이 있으면 그때) 적재한다.
- 깊이 상한 — `UNION`으로 (노드, 깊이) 쌍을 한 번만 방문해 순환을 막고, 노드마다 최단 깊이, 최대 300개(`truncated`).
- 표시용 — 카드 줄(`impactSummary(resourceId)`)은 `uses_sg`·`uses_eni`만 깊이 2로 따라가 ENI가 아닌 것만 센다(상한이면 `N+`, 필요한 종류를 못 읽었으면 줄 없음). 정리 미리보기는 권한 간선(`can_access`·`allows_from`)으로는 흡수하지 않고, AWS가 관리하는 ENI는 `managed`로 따로 보여 준다. 정책 검사는 계속 실시간 AWS 조회를 쓴다.

## Alternatives / 대안 비교

| | Postgres recursive CTE (PGlite) | Neo4j | Write into Steampipe's Postgres | In-memory JS graph |
|---|---|---|---|---|
| Query expressiveness / 질의 표현력 | SQL recursive CTE; fine for bounded impact walks, awkward for multi-hop pattern matching | Best: Cypher variable-length paths and pattern matching | Same SQL as PGlite | Hand-written traversal code, no query language |
| Operations / 운영 | None (in-process WASM) | A new server or container to run, patch, back up | None extra, but couples to Steampipe's lifecycle | None |
| Cost / 비용 | 25 MB package, ~0.7 s first create | Extra instance or license/hosting cost | None extra | None |
| Testability in vitest / 테스트 | Real SQL against real PGlite in vitest | Needs a container or mock | Needs a live Steampipe | Easy, but tests don't exercise SQL |
| Consistency with stack skills / 기존 스택과의 일관성 | SQL, same as the rest of the repo | New language (Cypher) and driver | SQL | Plain TS |
| Scale ceiling / 규모 한계 | Thousands of nodes comfortably (230 nodes, 274 edges today) | Wins at millions of nodes and deep pattern queries | Same as PGlite | Fine at this size, ad-hoc beyond it |
| Risk / 위험 | New dependency (WASM) | Heaviest | `runQuery()` is SELECT-only (`validateQuery`) and app state must not go into Steampipe's DB | Every new question needs new code |

Chosen: PGlite. It gives the requested "edges table + recursive CTE" with no new infrastructure and real-SQL tests, and it leaves Steampipe's database untouched. Neo4j is stronger at scale and for pattern queries but is overkill for a few hundred nodes.

PGlite를 골랐다. 새 인프라 없이 "edges 테이블 + 재귀 CTE"를 그대로 쓰고, vitest에서 진짜 SQL로 테스트하며, Steampipe DB를 건드리지 않는다. Neo4j는 대규모와 패턴 질의에서 강하지만 수백 노드에는 과하다.

## Consequences / 결과

- The graph can be up to 15 minutes stale (first build 60 s after boot, then every 15 min, never overlapping, production only). The screen and cards always show "as of N minutes ago".
- Display only: the graph never writes to AWS and never decides allow/deny; policy stays live. Cleanup preview is guidance only ("안내만 해요 — 실제로 지우지 않아요").
- If every query fails the previous graph is kept (`GraphSourceUnavailable`); if only some fail, those kinds are missing and listed in `warnings`, which the screen shows on the build line and as a cleanup-tab banner.
- Only 15 resource kinds are covered; others (ECS, EKS, DynamoDB, Route 53, VPC endpoints ...) need a new extractor.
- Adds `@electric-sql/pglite` (listed in `experimental.serverComponentsExternalPackages` so webpack does not bundle the WASM).
- Real-data dry run (shared sandbox account, 2026-10-28): 19/19 queries in about 8 s, 230 nodes, 274 edges, 0 dropped.

- 그래프는 최대 15분 늦을 수 있다. 화면과 카드에 "N분 전 기준"을 항상 보여 준다.
- 표시용이다. AWS를 바꾸지 않고 허용·거부 판단에도 쓰지 않는다. 정책은 실시간 조회를 쓴다.
- 쿼리가 모두 실패하면 이전 그래프를 유지하고, 일부만 실패하면 그 종류만 빠지고 `warnings`에 남아 화면의 빌드 줄과 정리 탭 경고에 보인다.
- 15종 밖의 리소스는 추출기를 추가해야 한다.

## When to revisit / 다시 검토할 때

- More than about 100k edges, or
- Needs for multi-hop pattern matching (for example "paths from the internet to any database") that the CTE makes unreadable or slow.

간선이 약 10만 개를 넘거나, 다단계 패턴 매칭 질의가 필요해 CTE로 읽기 어렵거나 느려질 때 Neo4j 같은 그래프 DB를 다시 검토한다.
