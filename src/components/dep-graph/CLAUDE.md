# 의존성 그래프 화면 컴포넌트

## 역할
`/dependency-graph` 페이지 UI. 리소스가 서로 어떻게 의존하는지 **그림으로** 보여 주고, "이걸 바꾸거나 지우면 무엇이 영향 받는지"와 프로젝트 정리 순서를 미리 보여 준다. 조회만 한다 — AWS를 바꾸는 버튼은 없다. 데이터는 `GET /api/graph`.

## 주요 파일
- `DepGraphView.tsx` — 페이지 본문 (클라이언트). `Header` + 빌드 상태 줄(`depGraph.builtAgo`: "{minutes}분 전 기준 · 리소스 {nodes}개 · 관계 {edges}개", 1분마다 갱신, 쿼리 실패가 있으면 `depGraph.warnings` "일부 종류를 못 읽었어요: <이름>") + 탭 2개. 관계 보기: 검색창, 중심이 없으면 허브 카드(`op=hubs`), 중심을 고르면 `neighborhood`(깊이 1/2/3, 기본 2) + 패널용 `impact`·`deps`(깊이 3). `truncated`면 "일부만 보여요 (최대 300개)". 404는 "그래프에서 찾지 못했어요". 새로고침은 모든 요청을 다시 부른다
- `GraphCanvas.tsx` — React Flow 캔버스. `nodes`·`edges`·`positions`(부르는 쪽이 계산: 관계 보기는 `layoutNeighborhood`, 정리 탭은 `layoutSteps`)·`centerArn`·`onPick`·`frameKey`를 받는다. 토폴로지 `makeNode` 스타일 노드(종류 라벨·이름·첫 속성), 중심 노드는 3px 테두리 + 빛, 간선 라벨 `depGraph.edge.<type>`, 화살표는 src(쓰는 쪽) → dst(쓰이는 쪽). 드래그·연결 불가, 노드를 누르면 그 노드가 중심. `frameKey`가 바뀌면 재마운트해서 `fitView`
- `ImpactPanel.tsx` — 오른쪽 패널: 영향 받는 것 / 이 리소스가 쓰는 것을 종류별로 묶고(개수 많은 종류 먼저, 종류마다 10개까지 + "외 N개", 이름을 누르면 중심 이동), 리소스 정보(종류·ID·계정·리전 + `attrs`의 원시값, `tags`는 Name만, ARN)
- `ProjectPreviewPanel.tsx` — 프로젝트 정리 미리보기. 씨앗 라디오(태그 키=값 / 이름 접두어 / VPC — VPC는 `SearchBox onlyType="vpc"` 또는 ARN 직접 입력), "미리보기"를 눌러야 조회(`op=project&tag=|prefix=|vpc=&accountId=`). 결과: 요약, "N단계" 목록(순환은 "서로 연결돼 있어 함께 정리"), 후보 관계도(`GraphCanvas` + `layoutSteps`, 지우는 순서대로 최대 300개, 노드를 누르면 관계 보기로), 먼저 확인해야 하는 것(blockers + 쓰는 후보), "AWS가 관리하는 연결 (연결된 서비스를 지우면 같이 정리돼요)"(managed), 다른 곳에서도 써서 빠진 것(shared). 응답 `warnings`가 있으면 노란 경고 "일부 종류를 못 읽어서 결과가 틀릴 수 있어요: <이름>". **"안내만 해요 — 실제로 지우지 않아요"와 "15종 밖(ECS·EKS·IAM 사용자 등)에서 쓰는 것은 보이지 않아요"는 항상 보인다.** 400이면 서버의 한국어 메시지를 함께 보여 준다
- `SearchBox.tsx` — 검색창 + 결과 목록(`op=search`, 300ms 디바운스, 100자, 선택 시 비움). `onlyType`이면 서버에 `type=`을 보내 그 종류만 20개까지 받는다(VPC 고르기는 `type=vpc`)
- `api.ts` — `fetchGraph(params)`(`/api/graph?…`, `status:'building'` 구분, 실패는 `GraphFetchError{status,message}`), `useGraph(params|null, reloadKey)` 훅(그래프를 만드는 중이면 10초마다 다시 시도, 언마운트·요청 변경 시 abort + 타이머 정리, 다른 요청의 데이터는 즉시 버림), `minutesSince`, 응답 타입
- `layout.ts` — 순수 함수 + `__tests__/layout.test.ts`. `layoutNeighborhood`: 중심 x=0, 나를 쓰는 쪽 x=-depth*260, 내가 쓰는 쪽 x=+depth*260, 열 안은 종류→이름 순, `y = i*80 - (count-1)*40`. `layoutSteps(order)`: i번째 단계(0부터) x=i*260, 단계 안은 arn 순, `y = j*80 - (count-1)*40`. `TYPE_COLORS`, `typeColor`
- 페이지 래퍼 `src/app/dependency-graph/page.tsx` — 서버 컴포넌트, `<DepGraphView />`만 렌더
- 테스트에는 i18n 짝 맞추기 검사도 있다: ko.json의 `depGraph.*`·`sidebar.depGraph` 키가 en/zh에 모두 있어야 하고, 간선·종류 라벨이 빠짐없이 있어야 한다

## 종류별 색 (`TYPE_COLORS`, 테마 강조색 + 회색만)
| 색 | 종류 |
|----|------|
| cyan `#00d4ff` | vpc, sg, nat, lb, cloudfront (네트워크 경계·진입점) |
| green `#00ff88` | subnet, eni, eip, tg (네트워크 연결) |
| purple `#a855f7` | instance, lambda (컴퓨팅) |
| orange `#f59e0b` | rds, ebs, s3 (데이터·저장소) |
| red `#ef4444` | role (IAM) |
| gray `#6b7280` | 알 수 없는 종류 (폴백) |

## 규칙
- `@/lib/dep-graph`에서는 `types`(와 `project`의 타입)만 `import type`으로 가져온다 — `store.ts`·`build.ts` 등 PGlite를 끌어오는 코드는 클라이언트 번들에 넣지 않는다
- `search`·`hubs`·`project`에는 `accountId: currentAccountId`를 넘긴다(`__all__`은 서버가 무시). 관계 따라가기(`neighborhood`·`impact`·`deps`)는 계정으로 거르지 않는다
- 문구는 초보자용 쉬운 한국어 먼저, `depGraph.*`·`sidebar.depGraph` 키를 ko/en/zh 모두에 추가
- 테마는 navy 배경 + 위 강조색. 좁은 화면에서는 캔버스와 패널이 위아래로 쌓인다(`lg:`부터 나란히)

---

# Dependency Graph UI Components (English)

## Role
UI for `/dependency-graph`: shows **visually** how resources depend on each other, what is affected if you change or delete one, and a cleanup-order preview for a project. Read-only — no button changes AWS. Data comes from `GET /api/graph`.

## Files
- `DepGraphView.tsx` — page body (client). `Header` + build line (`depGraph.builtAgo`, refreshed every minute; names failed queries via `depGraph.warnings`) + two tabs. Relations: search box, hub cards when nothing is selected (`op=hubs`), and once a center is picked `neighborhood` (depth 1/2/3, default 2) plus `impact`/`deps` at depth 3 for the panel. Shows the "partial (max 300)" note on `truncated`, a not-found note on 404. Refresh re-runs every request
- `GraphCanvas.tsx` — React Flow canvas taking `nodes`, `edges`, `positions` (computed by the caller: `layoutNeighborhood` for relations, `layoutSteps` for cleanup), `centerArn`, `onPick`, `frameKey`; topology-style `makeNode` boxes (type label, name, first attr), center with a 3px border + glow, edge labels `depGraph.edge.<type>`, arrows src (user) → dst (used). No drag/connect; clicking a node re-centres. Remounts when `frameKey` changes so `fitView` reframes
- `ImpactPanel.tsx` — right panel: impact and deps grouped by type (largest group first, 10 names per type + "N more", names re-centre), resource details (type, ID, account, region, primitive `attrs`, only the Name tag, ARN)
- `ProjectPreviewPanel.tsx` — project cleanup preview. Seed radio (tag key=value / name prefix / VPC via `SearchBox onlyType="vpc"` or a pasted ARN); fetches only on "Preview" (`op=project&tag=|prefix=|vpc=&accountId=`). Results: summary, numbered steps (cycles marked "clean up together"), a candidate graph (`GraphCanvas` + `layoutSteps`, up to 300 in delete order; clicking a node opens it in Relations), blockers with the candidates they use, AWS-managed links (`managed`), shared. A yellow banner lists failed kinds when the response has `warnings`. **The "guidance only — nothing is deleted" notice and the "anything outside the 15 kinds is not shown" caveat are always visible.** Shows the server's Korean message on 400
- `SearchBox.tsx` — search box + dropdown (`op=search`, 300 ms debounce, 100 chars, clears on pick); `onlyType` sends `type=` so the server returns up to 20 of that kind (the VPC picker uses `type=vpc`)
- `api.ts` — `fetchGraph(params)` (separates `status:'building'`, throws `GraphFetchError{status,message}`), `useGraph(params|null, reloadKey)` (retries every 10 s while building, aborts and clears the timer on unmount/param change, drops data from a different request), `minutesSince`, response types
- `layout.ts` — pure + `__tests__/layout.test.ts`: `layoutNeighborhood` (center x=0, dependents x=-depth*260, dependencies x=+depth*260, sorted by type then name, `y = i*80 - (count-1)*40`), `layoutSteps(order)` (step i at x=i*260, sorted by arn, `y = j*80 - (count-1)*40`), `TYPE_COLORS`, `typeColor`
- Page wrapper `src/app/dependency-graph/page.tsx` — server component rendering `<DepGraphView />`
- The test file also checks i18n parity: every `depGraph.*` / `sidebar.depGraph` key in ko.json exists in en/zh, and every edge/type label exists

## Type colours
cyan: vpc, sg, nat, lb, cloudfront · green: subnet, eni, eip, tg · purple: instance, lambda · orange: rds, ebs, s3 · red: role · gray: fallback.

## Rules
- Import only types (`import type`) from `@/lib/dep-graph` — never pull `store.ts`/`build.ts` (PGlite) into the client bundle
- Pass `accountId: currentAccountId` on `search`, `hubs`, `project` (the server ignores `__all__`); walks are not account-filtered
- Plain beginner-friendly Korean first; add `depGraph.*` / `sidebar.depGraph` to ko/en/zh
- Navy theme + the accents above; canvas and panel stack on narrow screens (side by side from `lg:`)
