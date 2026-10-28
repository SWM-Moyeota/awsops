# 장애 원인 분석 화면 컴포넌트

## 역할
`/root-cause` 페이지 UI. 장애가 났을 때 "고장 나기 직전에 누가 뭘 바꿨지?"를 보여 준다. 사건(이상 감지 또는 직접 분석 한 건)마다 CloudTrail 쓰기 이벤트를 점수(시간 × 그래프 거리 × 변경 종류) 순으로 늘어놓고, 근거 인용이 검증된 AI 설명만 붙인다. 조회만 한다 — AWS를 바꾸는 버튼은 없다. 데이터는 `GET/POST /api/root-cause`, 리소스 검색은 `GET /api/graph?op=search`.

## 주요 파일
- `RootCauseView.tsx` — 페이지 본문 (클라이언트). `Header` + 자동 감지 꺼짐 배너(`autoDetect: false`일 때 `rootCause.autoDetectOff`) + `AnalyzeForm` + 왼쪽 `IncidentList`(lg부터 340px) · 오른쪽 `IncidentDetail`. `useAccountContext().currentAccountId`로 목록을 거른다. 선택은 URL `?id=rc-…`(Slack 링크와 같은 형식, `router.replace`), 없으면 가장 최근 사건. 특정 계정을 고른 상태에서 `?id` 사건이 다른 계정 것이면(`isForeign`, 사건 자신의 `accountId`로 판단) 상세를 숨기고 `?id`를 지운다 — "전체 계정"에서는 Slack 링크가 그대로 열린다. 분석 결과: 200 → "분석이 끝났어요" 알림 + 목록 새로고침 + 그 사건 선택, 202 → `rootCause.running` 알림 + **30초 뒤 목록 새로고침**, 429 → `rootCause.rateLimited`, 404 → 그래프에 없음, 400 → 시각 범위, 그 밖 → 실패. 알림은 오른쪽 아래 5초 토스트
- `AnalyzeForm.tsx` — 직접 분석. 리소스 검색(`useGraph`로 `op=search&q=&accountId=`, 250ms 디바운스, 100자, ↑/↓·Enter·Esc — 입력창의 Enter는 결과가 지금 입력한 글자의 것이고 불러오는 중이 아닐 때만 고르고, Tab으로 결과 버튼에 간 뒤 Enter는 그 버튼이 직접 고른다, 그래프를 만드는 중이면 안내), 고른 리소스 칩(지우기 버튼), `datetime-local` 시각(기본 지금, 지난 7일 안, "지금" 버튼). 시각을 건드리지 않으면 `at`을 보내지 않아 서버가 지금으로 잡는다. POST의 `accountId`는 **고른 노드의 계정**(전체 계정 보기에서도 동작). 도는 동안 버튼 비활성 "분석 중… (최대 2분)", 언마운트·**계정 변경 시 abort**(계정이 바뀐 뒤 도착한 결과는 버림 — 서버 쪽 분석은 계속되어 나중에 목록에 나타난다)
- `IncidentList.tsx` — 사건 카드: 신호 아이콘(5xx 삼각형 · 대상 그룹 심장 · 서버 · 알람 종 · 직접 분석 돋보기, 열린 자동 사건은 빨강), 이름(`incidentName`), 진행 중/해결됨, 신호 이름 + 추가 신호 수 + 시작 시각, "1위 · 12분 전 RevokeSecurityGroupIngress · kim" 한 줄(목록 API는 1순위만 준다). 빈 상태 안내
- `IncidentDetail.tsx` — 사건 카드(신호·수치·시작 시각·리소스 ARN·계정 별칭·리전) + `rootCause.graphBasis` "그래프 기준: 14:00~14:45 (4개)"(스냅샷이 없으면 `graphBasisCurrent`) + 살펴본 범위·이벤트 수, `truncated`·`failedRegions` 경고. **AI 블록은 `ai.status === 'ok'`일 때만**: 요약, 원인마다 인용 칩(`#순위 이벤트 · N분 전`, 누르면 그 용의자 줄로 부드럽게 스크롤 + 2.5초 강조), 확신 정도, 확인해 볼 것, "AI 설명은 아래 근거 안에서만 만들어져요", 버린 인용 수. `unverified`/`failed`는 흐린 `rootCause.aiHidden`, `skipped`는 `rootCause.aiSkipped`. 분석 전이면 "아직 분석 중이에요"
- `SuspectTable.tsx` — 순위(상위 3개 주황), 시각(`formatOffset` "12분 전"/"2분 후"), 이벤트 이름 + 서비스·리전, 누가 + 도구(`rootCause.tool.*`), 리소스(`resourceLabel`), 연결(`distanceLabel` + 경로 "mo(lb) → tg-a(tg) → sg-c(sg)"), 점수 + 시간(cyan)·거리(purple)·종류(orange) 막대. 줄 id는 `anchorId(eventId)`. 표 아래에 항상 `rootCause.rankCaveat`
- `SuspectTimeline.tsx` — Recharts 산점도: x = 시작 기준 분(−60~+5, 범위 밖은 끝으로 자름), y = 점수, x=0 빨간 점선. 상위 3개 주황 · 나머지 cyan, 점을 누르면 표의 그 줄로 이동. `SafeResponsiveContainer` 사용
- `api.ts` — `listIncidents(accountId, signal?)`, `getIncident(id, signal?)`, `analyze(body, signal?)`(202 → `{kind:'running'}`), 실패는 `RootCauseError{status,message}`. 훅 `useIncidentList(accountId, reloadKey)`, `useIncident(id|null, reloadKey)` — 키가 바뀌거나 언마운트되면 AbortController로 끊고, 다른 키의 데이터는 바로 버린다(`viewFor`: 효과가 돌기 전 한 번의 렌더에서도 이전 키의 데이터를 돌려주지 않음)
- `format.ts` — 순수 함수 + `__tests__/format.test.ts`. `formatOffset(eventIso, startIso, t)`(반올림, 0분은 "시작 무렵"), `offsetMinutes`, `clampOffset`, `signalLabel(kind, t)`, `distanceLabel(d, t)`, `pathLabel`, `resourceLabel`, `anchorId`, `toLocalInput`/`fromLocalInput`(로컬 시각 ↔ ISO), `localDateTime`, `localTime`, `arnTail`, `incidentName`
- `selection.ts` — 선택 규칙 순수 함수 + `__tests__/selection.test.ts`. `searchKeyAction`(검색창 키), `isFresh`(결과가 지금 입력의 것인지), `viewFor`(훅이 이전 키 데이터를 숨김), `isForeign`(선택 계정 밖 사건)
- 페이지 래퍼 `src/app/root-cause/page.tsx` — 서버 컴포넌트. 변경 기록과 같은 Pretendard(`../changes/fonts/PretendardVariable.woff2`)를 `--font-pretendard`로 주입, `useSearchParams` 때문에 `<Suspense>`로 감싼다
- 테스트에는 i18n 짝 맞추기 검사도 있다: ko.json의 `rootCause.*`·`sidebar.rootCause` 키가 en/zh에 모두 있고, en/zh에만 있는 키가 없어야 한다. 정해진 문구(`running`, `rankCaveat`)와 도구 라벨 7종도 확인한다

## 규칙
- `@/lib/root-cause`에서는 `types`만 `import type`으로 가져온다 — 서버 코드(CloudTrail·Bedrock·저장소)를 클라이언트 번들에 넣지 않는다. 검색은 `@/components/dep-graph/api`의 `useGraph`를 재사용
- AI가 순위를 바꾸지 않는다 — 화면 순위는 항상 서버의 점수 순위. 검증되지 않은 AI 설명은 보이지 않는다
- 시각은 브라우저 로컬 시간으로 보여 주고 입력받는다(서버에는 ISO로)
- 문구는 초보자용 쉬운 한국어 먼저, `rootCause.*`·`sidebar.rootCause` 키를 ko/en/zh 모두에 추가
- 테마는 navy 배경 + 강조색(cyan·purple·orange·red·green). 좁은 화면에서는 목록과 상세가 위아래로 쌓이고 표는 가로 스크롤

---

# Root-Cause UI Components (English)

## Role
UI for `/root-cause`: when something breaks, shows "who changed what right before it broke". For each incident (a detected anomaly or a manual analysis) the CloudTrail write events are listed by score (time × graph distance × change kind), with an AI explanation only when its citations were verified. Read-only — no button changes AWS. Data comes from `GET/POST /api/root-cause`; resource search uses `GET /api/graph?op=search`.

## Files
- `RootCauseView.tsx` — page body (client). `Header` + an auto-detect-off banner (`rootCause.autoDetectOff` when `autoDetect: false`) + `AnalyzeForm` + `IncidentList` on the left (340px from lg) and `IncidentDetail` on the right. Filters the list by `useAccountContext().currentAccountId`. Selection lives in `?id=rc-…` (same format as the Slack link, via `router.replace`), defaulting to the newest incident. With a specific account selected, an `?id` incident from another account (`isForeign`, judged by the incident's own `accountId`) is hidden and `?id` is cleared; under "all accounts" a Slack link still opens. Analyze outcomes: 200 → "Analysis finished" toast, list refresh and select it; 202 → `rootCause.running` toast and **a list refresh after 30 s**; 429 → `rootCause.rateLimited`; 404 → not in graph; 400 → time range; otherwise failed. Toasts sit bottom-right for 5 s
- `AnalyzeForm.tsx` — manual analysis. Resource search (`useGraph` on `op=search&q=&accountId=`, 250 ms debounce, 100 chars, ↑/↓/Enter/Esc — Enter in the input picks only when the results belong to the current text and nothing is loading; after Tab onto a result, Enter is handled by that button, building notice), a picked-resource chip with a clear button, a `datetime-local` time (defaults to now, last 7 days, "Now" button). An untouched time sends no `at`, so the server uses now. The POST `accountId` is **the picked node's account** (works in the all-accounts view). Button disabled while running ("Analyzing… (up to 2 min)"); aborts on unmount and **on account change** (a result arriving after the switch is ignored; the server-side run continues and shows up in the list later)
- `IncidentList.tsx` — incident cards: signal icon (triangle 5xx, heart target group, server, bell alarm, magnifier manual; open auto incidents in red), name (`incidentName`), open/resolved, signal label + extra signal count + start time, and a "Top · 12 min before RevokeSecurityGroupIngress · kim" line (the list API returns the top suspect only). Empty state
- `IncidentDetail.tsx` — incident card (signals with numbers, start time, resource ARN, account alias, region) + `rootCause.graphBasis` "Graph as of 14:00–14:45 (4 snapshots)" (`graphBasisCurrent` without snapshots) + window and event count, `truncated` / `failedRegions` warnings. **The AI block renders only for `ai.status === 'ok'`**: summary, a citation chip per cause (`#rank event · N min before`; click smooth-scrolls to that suspect row and highlights it for 2.5 s), confidence, things to check, "The AI explanation only uses the evidence below", dropped citation count. `unverified`/`failed` show the muted `rootCause.aiHidden`; `skipped` shows `rootCause.aiSkipped`. Without an analysis: "Still analyzing"
- `SuspectTable.tsx` — rank (top 3 in orange), time (`formatOffset` "12분 전" / "2분 후"), event name + service/region, who + tool (`rootCause.tool.*`), resource (`resourceLabel`), connection (`distanceLabel` + path "mo(lb) → tg-a(tg) → sg-c(sg)"), score + time (cyan) / distance (purple) / kind (orange) bars. Row ids come from `anchorId(eventId)`. `rootCause.rankCaveat` is always shown under the table
- `SuspectTimeline.tsx` — Recharts scatter: x = minutes from the start (−60..+5, clamped), y = score, red dashed line at x=0. Top 3 orange, others cyan; clicking a dot jumps to its row. Uses `SafeResponsiveContainer`
- `api.ts` — `listIncidents(accountId, signal?)`, `getIncident(id, signal?)`, `analyze(body, signal?)` (202 → `{kind:'running'}`); failures throw `RootCauseError{status,message}`. Hooks `useIncidentList(accountId, reloadKey)` and `useIncident(id|null, reloadKey)` abort via AbortController on key change/unmount and drop data from a different key (`viewFor`: even the one render before the effect never returns the previous key's data)
- `format.ts` — pure + `__tests__/format.test.ts`: `formatOffset(eventIso, startIso, t)` (rounded; 0 min is "at the start"), `offsetMinutes`, `clampOffset`, `signalLabel(kind, t)`, `distanceLabel(d, t)`, `pathLabel`, `resourceLabel`, `anchorId`, `toLocalInput`/`fromLocalInput` (local time ↔ ISO), `localDateTime`, `localTime`, `arnTail`, `incidentName`
- `selection.ts` — pure selection rules + `__tests__/selection.test.ts`: `searchKeyAction` (search-box keys), `isFresh` (results belong to the current text), `viewFor` (hooks hide the previous key's data), `isForeign` (incident outside the selected account)
- Page wrapper `src/app/root-cause/page.tsx` — server component; injects the same Pretendard font as the change timeline (`../changes/fonts/PretendardVariable.woff2`) as `--font-pretendard`, wrapped in `<Suspense>` because of `useSearchParams`
- The test file also checks i18n parity: every `rootCause.*` / `sidebar.rootCause` key in ko.json exists in en/zh and en/zh have no extra ones; it also pins the agreed copy (`running`, `rankCaveat`) and the 7 tool labels

## Rules
- Import only types (`import type`) from `@/lib/root-cause` — never pull server code (CloudTrail, Bedrock, store) into the client bundle. Search reuses `useGraph` from `@/components/dep-graph/api`
- The AI never reorders — the on-screen ranking is always the server's score ranking. Unverified AI text is never shown
- Times are shown and entered in the browser's local time (sent to the server as ISO)
- Plain beginner-friendly Korean first; add `rootCause.*` / `sidebar.rootCause` to ko/en/zh
- Navy theme + accents (cyan, purple, orange, red, green); list and detail stack on narrow screens, the table scrolls horizontally
