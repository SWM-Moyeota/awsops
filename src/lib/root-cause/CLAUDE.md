# 장애 원인 분석 (Root Cause) 모듈

## 역할
장애가 났을 때 "직전에 누가 뭘 바꿨지?"에 답한다. CloudWatch로 이상을 감지하고, 직전 CloudTrail **쓰기 이벤트**에 `시간 × 그래프 거리 × 변경 종류` 점수를 매겨 용의자 순위를 만든다. AI는 상위 용의자를 **설명만** 하고, 인용한 이벤트 ID가 근거 묶음에 없으면 그 원인을 버린다. 결과는 `/root-cause` 페이지와 Slack(새 사건 알림, "왜 고장났어 <리소스>" 질문)에 쓰인다. 조회만 하는 기능이다. 설계 문서: `docs/superpowers/specs/2026-10-29-root-cause-design.md`, 결정: ADR-013.

## 주요 파일
- `types.ts` — 공용 타입: `Signal`, `WriteEvent`, `Suspect`(점수 세 값), `Incident`, `Analysis`, `AiResult`.
- `signals.ts` — 신호 4종 감지(ALB 5xx, 비정상 대상, EC2 상태 검사, 알람). `GetMetricData`는 계정당 묶음 호출, 감시 대상은 현재 그래프에서 가져온다.
- `incidents.ts` — 사건 묶기(순수 함수): 키 `(계정, 리소스, 신호)` 중복 제거, 2단계 안 관련 신호 합치기, 30분 조용하면 `resolved`, 최대 200건.
- `events.ts` — CloudTrail 이벤트를 `WriteEvent`로: 실패 호출·잡음 목록 제거, 요청 파라미터 정리(비밀·IP 제거), 리소스 참조 추출.
- `graph.ts` — 이력 스냅샷 합치기(`mergeGraphs`), 이벤트 리소스를 같은 계정 노드로 찾기, 방향 무시 BFS 거리(최대 4단계, vpc·subnet·연결 15개 초과 노드는 경유 금지).
- `score.ts` — 점수의 세 요소(`timeWeight`, `graphWeight`, `kindWeight`). 추가형 동사(Authorize/Register/Attach/Associate/Enable)는 0.5 — ADR-013의 평가 조정.
- `rank.ts` — 파싱 → 창 필터 → 리소스 찾기 → 거리 → 점수 → 정렬(같으면 시작에 가까운 것, 그다음 eventId), 최대 50개.
- `bundle.ts` — 상위 8개 용의자를 최대 24,000자 근거 묶음으로. `scrubParams`가 소스 IP·userAgent·액세스 키·비밀 이름 파라미터를 뺀다.
- `explain.ts` — Bedrock 호출과 `parseAiAnswer`: 묶음에 없는 eventId 인용은 버리고, 유효한 원인이 0개면 `unverified`로 숨긴다.
- `analyze.ts` — `lookupWriteEvents`(`ReadOnly=false`, 창 `[시작-60분, 시작+5분]`, 리전당 최대 10페이지), `analyzeIncident`, 한 번에 하나씩 도는 큐 `enqueueAnalysis`, 수동 분석 `manualAnalyze`(30초 제한).
- `store.ts` — `data/root-cause/incidents.json`(최근 200건, 원자적 쓰기, 쓰기 체인 직렬화, 깨진 파일은 `.corrupt-<ts>`). `ROOT_CAUSE_DATA_DIR`로 경로를 바꿀 수 있다.
- `loop.ts` — `ensureRootCauseStarted()`: 90초 뒤 첫 tick, 이후 5분마다. 프로덕션에서만, 겹치지 않음. `rootCause.autoDetect: false`면 감지만 끈다.
- `api.ts` — `/api/root-cause` 처리기(목록·상세·수동 분석). 라우트 파일은 얇다.
- `slack.ts` — 새 사건 알림(봇 채널 우선, 안 되면 헬스 웹훅), `detectRcaQuestion`/`maybeHandleRcaQuestion`(규칙으로 감지, 리소스를 못 찾으면 AI로 넘김).
- `eval/scenarios.ts` + `__tests__/eval.test.ts` — 재현 시험 24개(+`knownLimit` 3개). 1위 ≥ 0.45, 3위 안 ≥ 0.9가 `npm test`의 관문이다.

## 규칙
- AWS를 바꾸는 API를 호출하지 않는다. 쓰는 것은 `LookupEvents`, `GetMetricData`, `DescribeAlarms`, Bedrock `InvokeModel`뿐이다.
- CloudTrail 호출은 반드시 `cloudTrailSlot`(계정·리전당 초당 1회, 변경 기록·비용 레이더와 공유)을 거친다.
- 로그에는 오류 이름만 남긴다. 소스 IP, userAgent, 액세스 키, 비밀 이름 파라미터는 근거 묶음에도 넣지 않는다.
- AI는 순위를 바꾸지 않고 설명만 한다. 인용한 eventId가 근거 묶음에 없으면 버린다. 유효한 인용이 없으면 AI 설명을 숨기고 점수 순위만 보여 준다.
- 점수식을 바꾸면 재현 시험을 다시 돌리고 전후 수치를 ADR-013에 적는다. 시나리오를 본 뒤 맞추는 조정은 과적합이다.
- 노드 찾기는 같은 계정 안에서만 한다. 분석은 프로세스 전체에서 한 번에 하나씩 돈다.
- 새 리소스 종류 거리를 재려면 먼저 `src/lib/dep-graph/`에 추출기를 추가한다(15종 밖은 "그래프에 없음" 가중치).

---

# Root Cause Module (English)

## Role
Answers "who changed what just before it broke?". Detects anomalies from CloudWatch, then scores the preceding CloudTrail **write events** by `time x graph distance x change kind` to rank suspects. The AI only **explains** the top suspects, and a cause citing an event ID that is not in the evidence bundle is dropped. Results feed the `/root-cause` page and Slack (a new-incident alert and the "왜 고장났어 <resource>" question). It is read-only. Spec: `docs/superpowers/specs/2026-10-29-root-cause-design.md`, decision: ADR-013.

## Key Files
- `types.ts` — shared types: `Signal`, `WriteEvent`, `Suspect` (three score parts), `Incident`, `Analysis`, `AiResult`.
- `signals.ts` — the four signals (ALB 5xx, unhealthy targets, EC2 status checks, alarms). One batched `GetMetricData` per account; watch targets come from the current graph.
- `incidents.ts` — incident grouping (pure): dedupe by `(account, resource, signal)`, join related signals within 2 hops, `resolved` after 30 quiet minutes, max 200.
- `events.ts` — CloudTrail event to `WriteEvent`: drops failed calls and the noise list, sanitizes request parameters (secrets and IPs removed), extracts resource refs.
- `graph.ts` — merge history snapshots (`mergeGraphs`), resolve event refs to same-account nodes, undirected BFS distance (max 4 hops, no passing through vpc/subnet or nodes with more than 15 edges).
- `score.ts` — the three score parts (`timeWeight`, `graphWeight`, `kindWeight`). Additive verbs (Authorize/Register/Attach/Associate/Enable) weigh 0.5 — the tuning recorded in ADR-013.
- `rank.ts` — parse, window, resolve, distance, score, sort (ties: closer to the start, then eventId), max 50.
- `bundle.ts` — packs the top 8 suspects into an evidence bundle of at most 24,000 characters. `scrubParams` removes source IPs, user agents, access keys and secret-named parameters.
- `explain.ts` — the Bedrock call and `parseAiAnswer`: citations of event IDs not in the bundle are dropped; zero valid causes hides the text as `unverified`.
- `analyze.ts` — `lookupWriteEvents` (`ReadOnly=false`, window `[start-60 min, start+5 min]`, max 10 pages per region), `analyzeIncident`, the one-at-a-time queue `enqueueAnalysis`, and `manualAnalyze` (30 s rate limit).
- `store.ts` — `data/root-cause/incidents.json` (newest 200, atomic writes, writes serialized on one chain, a broken file moves to `.corrupt-<ts>`; `ROOT_CAUSE_DATA_DIR` overrides the path).
- `loop.ts` — `ensureRootCauseStarted()`: first tick after 90 s, then every 5 min. Production only, no overlap. `rootCause.autoDetect: false` turns off detection only.
- `api.ts` — `/api/root-cause` handlers (list, get, manual analyze); the route file stays thin.
- `slack.ts` — new-incident alert (bot channel first, health webhook as fallback), `detectRcaQuestion`/`maybeHandleRcaQuestion` (rule-based; if no resource is found it falls through to the AI).
- `eval/scenarios.ts` + `__tests__/eval.test.ts` — 24 replayed scenarios (+3 `knownLimit`). top-1 >= 0.45 and top-3 >= 0.9 are the `npm test` gate.

## Rules
- Never call an AWS API that changes anything. The only calls are `LookupEvents`, `GetMetricData`, `DescribeAlarms` and Bedrock `InvokeModel`.
- Every CloudTrail call goes through `cloudTrailSlot` (1 request/s per account+region, shared with the change timeline and Cost Radar).
- Logs carry error names only. Source IPs, user agents, access keys and secret-named parameters never enter the evidence bundle.
- The AI never changes the ranking, it only explains. A cited eventId missing from the bundle is dropped; with no valid citation the AI text is hidden and only the score ranking is shown.
- If you change the formula, rerun the replay and record before/after numbers in ADR-013. Adjusting after seeing scenario results is overfitting.
- Node lookup stays inside one account. Analyses run one at a time per process.
- To measure distance for a new resource kind, add an extractor to `src/lib/dep-graph/` first (kinds outside the 15 get the "not in graph" weight).
