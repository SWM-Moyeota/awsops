# ADR-013: Root Cause by Scored Suspects, AI Only Explains / 점수로 순위를 매기는 장애 원인 분석, AI는 설명만

## Status: Accepted / 상태: 승인됨 (2026-10-29)

## Context / 컨텍스트

When something breaks, the first question is "who changed what just before?". Answering it today means opening the CloudTrail console, matching the time range, and deciding by hand whether a change is related to the broken resource. Sending every raw event to an LLM and asking "what is the cause?" is cheap to build but easy to get wrong: the model can invent a cause, cannot be tested for repeatability, and the event list is mostly noise.

장애가 나면 가장 먼저 묻는 질문은 "직전에 누가 뭘 바꿨지?"다. 지금은 CloudTrail 콘솔을 열고 시간대를 맞추고, 그 변경이 고장 난 리소스와 관련 있는지 사람이 따져야 한다. 원본 이벤트를 전부 LLM에 주고 "원인이 뭐야?"라고 묻는 방법은 만들기 쉽지만 틀리기도 쉽다. 모델이 원인을 지어낼 수 있고, 같은 입력에 같은 답이 나오는지 시험할 수 없고, 이벤트 대부분이 잡음이다.

Related work: Microsoft RCACopilot also gathers evidence with rules and lets the LLM reason only inside it. We cite it as related work only. Its task (classifying the root-cause category of an incident) differs from ours (ranking which change caused it), so we do not compare its numbers with ours.

관련 연구: Microsoft RCACopilot도 규칙으로 근거를 모으고 LLM은 그 안에서만 판단하게 한다. 관련 연구로만 인용한다. 그 과제(사건의 원인 종류 분류)는 우리 과제(어떤 변경이 원인인지 순위 매기기)와 달라서 수치를 비교하지 않는다.

## Decision / 결정

Rank suspects with a **deterministic score**; the LLM only **explains** the top suspects, and **every citation is verified** (`src/lib/root-cause/`).

점수를 **결정적으로** 계산해 용의자 순위를 매기고, LLM은 상위 용의자를 **설명**만 한다. 인용은 **모두 검증**한다.

1. **Detect** — every 5 minutes (production only, first tick after 90 s): ALB 5xx surge, unhealthy targets, EC2 status-check failure (CloudWatch `GetMetricData`), and CloudWatch alarms in `ALARM`. Manual analysis (screen, `POST /api/root-cause`, Slack question) works with detection off. Related signals within 2 hops are merged into one incident, so one alert and one AI call.
2. **Fetch** — `LookupEvents` with `ReadOnly=false`, window `[start-60 min, start+5 min]`; failed calls and a noise list are dropped; every CloudTrail call goes through `cloudTrailSlot` (1 request/s per account+region, shared with the change timeline and Cost Radar).
3. **Score** — `score = time x graph x kind`, each 0..1, shown on screen. Time `exp(-dt/20 min)`; graph distance by undirected BFS (max 4 hops, no passing through vpc/subnet or nodes with more than 15 edges): 1.0 / 0.85 / 0.65 / 0.45 / 0.3, unconnected 0.08, not in graph 0.12, no target 0.5; kind by verb: destructive 1.0, modify-like 0.8, create/start 0.5, tags 0.1, other 0.6. Ties: closer to the start, then eventId.
4. **Merged graph history** — a connection removed by the change is already gone from the current graph, so the graph builds keep snapshots (ADR-012, newest 12) and an analysis merges those inside the window plus the one just before it, and measures distance on that. The incident stores which snapshots were used.
5. **Explain** — top 8 suspects become an evidence bundle (24,000 characters max; source IP, user agent, access key ids and parameters named password/secret/token/credential/privatekey are removed). The model answers one JSON; a cause whose `eventId` is not in the bundle is dropped, and with zero valid causes the AI text is hidden (`unverified`) and only the score ranking is shown. The AI never changes the ranking.
6. **Read-only** — the feature calls only `cloudtrail:LookupEvents`, `cloudwatch:GetMetricData`, `cloudwatch:DescribeAlarms` and Bedrock `InvokeModel`. Logs carry error names only.

- 감지: 5분마다(프로덕션만, 기동 90초 뒤 첫 tick) ALB 5xx 급증, 비정상 대상, EC2 상태 검사 실패(CloudWatch `GetMetricData`), `ALARM` 상태 알람. 감지를 꺼도 수동 분석(화면·`POST /api/root-cause`·Slack 질문)은 된다. 2단계 안의 관련 신호는 한 사건으로 합쳐 알림과 AI 호출이 하나다.
- 수집: `LookupEvents`를 `ReadOnly=false`로, 창은 `[시작-60분, 시작+5분]`. 실패한 호출과 잡음 목록은 버린다. CloudTrail 호출은 모두 `cloudTrailSlot`(계정·리전당 초당 1회, 변경 기록·비용 레이더와 공유)을 거친다.
- 점수: `시간 × 그래프 × 종류`(각 0~1)이고 화면에 세 값을 모두 보여 준다. 같으면 시작에 더 가까운 것, 그다음 eventId.
- 합친 그래프 이력: 변경이 끊어 버린 연결은 현재 그래프에 이미 없다. 그래서 그래프 빌드마다 스냅샷을 남기고(ADR-012, 최근 12개) 분석은 창 안 스냅샷과 바로 앞 하나를 합쳐 거리를 잰다. 어떤 스냅샷을 썼는지 사건에 저장한다.
- 설명: 상위 8개를 근거 묶음(최대 24,000자, 소스 IP·userAgent·액세스 키·비밀 이름 파라미터 제외)으로 만들어 AI에 준다. 근거 묶음에 없는 `eventId`를 인용한 원인은 버리고, 유효한 원인이 0개면 AI 설명을 숨기고(`unverified`) 점수 순위만 보여 준다. AI는 순위를 바꾸지 않는다.
- 읽기 전용: `cloudtrail:LookupEvents`, `cloudwatch:GetMetricData`, `cloudwatch:DescribeAlarms`, Bedrock `InvokeModel`만 쓴다. 로그에는 오류 이름만 남긴다.

## Alternatives / 대안 비교

| | Deterministic score + AI explains (chosen) | LLM ranks the raw events | Plain prompt with all events | Time-only ranking | Graph-only |
|---|---|---|---|---|---|
| Repeatability / 재현성 | Same input, same ranking; unit-testable | Varies per call | Varies per call | Deterministic | Deterministic |
| Hallucination control / 지어냄 방지 | Citations checked against the bundle; unverified text hidden | None except a prompt rule | None | Not applicable | Not applicable |
| Tokens per incident / 토큰 | 4-8k (top 8) | Large: hundreds of events | Largest | None | None |
| Uses resource relationships / 관계 활용 | Yes, on the pre-change graph | Only if we paste the graph | No | No | Yes |
| Handles a recent harmless change / 최근 무관 변경 | Down-weighted by distance and kind | Depends on the model | Depends on the model | Ranks it first | Ranks by distance only, so an old connected change beats a fresh one |
| Measurable / 측정 가능 | Yes: top1/top3 on replayed scenarios | Costs money every run | Costs money every run | Yes | Yes |
| Weakness / 약점 | Weights are hand-set; 15 resource types only | Cost, noise, invention | Same | Blind to relationships | Blind to timing |

Chosen: the deterministic score, with the LLM limited to explaining inside verified evidence. The failure modes of the alternatives (invention, unmeasurable, blind to graph or time) are exactly what the combined score avoids, and the part that can be tested (the ranking) is separate from the part that cannot (the wording).

결정적 점수를 골랐고 LLM은 검증된 근거 안에서 설명만 한다. 대안의 약점(지어냄, 측정 불가, 그래프나 시간을 못 봄)을 점수가 막고, 시험할 수 있는 부분(순위)과 없는 부분(문장)이 분리된다.

## Evaluation / 평가

Replayed scenarios, not real incidents: `src/lib/root-cause/eval/scenarios.ts` has 24 scored scenarios plus 3 `knownLimit` ones (answer outside the 15 graph types, reported but not scored). `__tests__/eval.test.ts` runs the whole pipeline (parse, resolve, merge graph, distance, score) and computes top-1 and top-3.

실제 장애가 아니라 재현 시험이다. `eval/scenarios.ts`에 점수에 들어가는 시나리오 24개와 `knownLimit` 3개(정답이 그래프 15종 밖이라 결과만 보고하고 점수에는 안 넣음)가 있다. `eval.test.ts`가 전체 파이프라인을 돌려 1위·3위 안 적중률을 계산한다.

| Run / 실행 | top-1 | top-3 |
|---|---|---|
| First honest run, spec formula as written / 스펙 점수식 그대로 첫 실행 | 0.4167 (10/24) | 1.0 (24/24) |
| After the one allowed change / 허용된 변경 한 번 뒤 | 0.4583 (11/24) | 1.0 (24/24) |

- **Target missed.** The spec asked for top-1 >= 0.75 and top-3 >= 0.9. Top-3 passes; top-1 does not. Following the spec's fallback rule, the test asserts the measured values instead: **top-1 >= 0.45, top-3 >= 0.9**. We did not tune further to reach 0.75.
- **The one change was decided by the controller after seeing the failures**, not before: the additive verbs `Authorize`, `Register`, `Attach`, `Associate`, `Enable` moved from kind weight 0.8 to 0.5 (they add capacity or permission and rarely break things). Nothing else changed and the scenarios were untouched. It moved one scenario (`iam-detach-img-originals`) to rank 1. This is tuning after seeing results and should be read that way.
- Single-change experiments tried and **not** adopted (each alone, same scenarios): time scale 40 min 0.5000; sqrt time 0.5000; flatter graph weights 0.3750 (top-3 0.9583); kind squared 0.5000; graph squared 0.4167; kind cubed 0.5417. Only a two-change combination reached 0.75, which would be fitting the scenarios, so it was rejected.
- **Main failure pattern:** a closer, connected `Modify`-type change outranks an earlier `Revoke`/`Deregister`. Kind weights 0.8 vs 1.0 are too close to offset the time decay. In 13 of 24 scenarios the answer is rank 2-3, so the ranking works as a shortlist (top-3 100%) for the top-8 AI bundle, but it cannot yet be trusted to put the cause first.
- **`knownLimit` (3):** route-table blackhole, NACL deny and old-ALB DNS all rank the cause 2nd behind another change (not scored), as expected for types the graph does not cover.
- **Disclosure of how the scenarios were made.** The scenarios were written before the scorer, but the scenario author saw the weight values in a constraints file. After a review the scenarios were made harder (connected harmless distractors, ENI swaps that need the pre-change graph) before the scorer was run. This is still synthetic data written by the same team: the numbers say the formula behaves as designed on these cases, not that it will find real causes at that rate.
- RCACopilot's numbers are not comparable (different task) and are not used.

- **목표 미달.** 스펙은 top-1 >= 0.75, top-3 >= 0.9였다. top-3는 통과, top-1은 미달이다. 스펙의 대체 규칙대로 테스트는 실제 측정값을 기준으로 건다: **top-1 >= 0.45, top-3 >= 0.9**. 0.75를 맞추려고 더 손보지 않았다.
- **허용된 변경 한 번은 실패를 본 뒤에 컨트롤러가 정했다.** 사전에 정한 것이 아니다. 용량·권한을 더하는 동사(`Authorize`, `Register`, `Attach`, `Associate`, `Enable`)를 종류 가중치 0.8에서 0.5로 옮겼다(더하는 변경은 잘 안 깨진다). 다른 것은 바꾸지 않았고 시나리오도 그대로다. 시나리오 하나(`iam-detach-img-originals`)가 1위가 됐다. 결과를 보고 한 조정이므로 그렇게 읽어야 한다.
- 시험했지만 채택하지 않은 단일 변경: 시간 척도 40분 0.5000, 시간 제곱근 0.5000, 완만한 그래프 가중치 0.3750(top-3 0.9583), 종류 제곱 0.5000, 그래프 제곱 0.4167, 종류 세제곱 0.5417. 변경 두 개를 합칠 때만 0.75가 나왔는데 시나리오에 맞추는 일이라 버렸다.
- **주된 실패 패턴:** 더 가깝고 연결된 `Modify`류 변경이 더 이른 `Revoke`/`Deregister`보다 위에 온다. 종류 가중치 0.8 대 1.0이 시간 감쇠를 못 이긴다. 24개 중 13개에서 정답이 2~3위라서, AI에 주는 상위 8개 후보 목록으로는 쓸 만하지만(3위 안 100%) 1위를 믿기에는 아직 부족하다.
- **`knownLimit` 3개:** 라우팅 테이블 블랙홀, NACL 거부, 옛 ALB DNS는 그래프가 다루지 않는 종류라 예상대로 정답이 다른 변경 다음 2위다(점수에는 안 넣음).
- **시나리오를 만든 과정 공개.** 시나리오는 점수식보다 먼저 썼다. 다만 시나리오 작성자가 제약 파일에서 가중치 값을 보았다. 검토 뒤 점수식을 돌리기 전에 시나리오를 더 어렵게 고쳤다(연결된 무해한 방해물, 변경 전 그래프가 필요한 ENI 바꿔 끼우기). 같은 팀이 쓴 합성 데이터이므로 이 수치는 "이 사례에서 설계대로 동작한다"는 뜻이지 실제 원인을 그 비율로 찾는다는 뜻이 아니다.
- RCACopilot 수치는 과제가 달라 비교하지 않는다.

## Consequences / 결과

- **Cost:** CloudWatch `GetMetricData` is about $2/month at the sandbox's size (about 22 metrics x 288 runs/day x 30 days); `rootCause.autoDetect: false` in `data/config.json` turns detection off, and manual analysis still works. One Bedrock call per incident (maxTokens 1200); a manual re-analysis is limited to once per 30 s per process.
- **Limits:** only the 15 resource types of the dependency graph have a distance (others rank with the "not in graph" weight); no log analysis yet; CloudTrail delivery delay means a very recent change may not be visible yet (the window runs 5 minutes past the start); the merged graph can make a removed connection look slightly closer.
- Analyses run one at a time in the process because they share the CloudTrail slot with the change timeline.
- If the AI fails or its citations are all invalid, the incident and the ranking are still kept; only the explanation is hidden.
- The feature changes no AWS resource and has no undo button (undoing belongs to ADR-011).

- 비용: CloudWatch `GetMetricData`가 샌드박스 규모에서 월 약 2달러(지표 약 22개 × 하루 288회 × 30일)다. `data/config.json`의 `rootCause.autoDetect: false`로 감지를 끌 수 있고 수동 분석은 계속 된다. Bedrock 호출은 사건당 한 번(maxTokens 1200), 다시 분석은 프로세스 전체에서 30초에 한 번이다.
- 한계: 의존성 그래프 15종만 거리를 잰다(그 밖은 "그래프에 없음" 가중치). 로그 분석은 아직 없다. CloudTrail 전달 지연 때문에 아주 최근 변경은 안 보일 수 있다(창은 시작 뒤 5분까지). 합친 그래프는 끊어진 연결을 조금 가깝게 보이게 할 수 있다.
- 분석은 CloudTrail 호출 칸을 변경 기록과 나누므로 프로세스 안에서 한 번에 하나씩 돈다.
- AI가 실패하거나 인용이 모두 무효여도 사건과 순위는 남고 설명만 숨긴다.
- AWS 리소스를 바꾸지 않고 되돌리기 버튼도 없다(되돌리기는 ADR-011의 몫).

## Follow-ups / 후속 과제

1. Scoring research on a **separate held-out scenario set** (not these 24), so weights are tuned on one set and judged on another.
2. Drain-style log templates once the sandbox has usable application logs.
3. A real drill in the sandbox (create a test server and security group and break it on purpose). It creates AWS resources, so it needs explicit approval first.
4. Timeouts on the CloudWatch fetch (a hung call can currently delay a detection tick).

1. 지금 24개가 아닌 **별도의 보류 시나리오 세트**로 점수 연구를 한다(한 세트로 조정하고 다른 세트로 판단).
2. 샌드박스에 쓸 만한 애플리케이션 로그가 생기면 Drain 방식 로그 템플릿.
3. 샌드박스에서 실제 훈련(시험용 서버와 보안그룹을 만들어 일부러 망가뜨리기). AWS 리소스를 만드는 일이라 먼저 승인을 받는다.
4. CloudWatch 조회에 타임아웃(멈춘 호출이 감지 tick을 늦출 수 있다).

## When to revisit / 다시 검토할 때

- Real incidents show the top-1 hit rate well below the replayed numbers, or
- The held-out research finds weights that clearly beat the current ones.

실제 장애에서 1위 적중률이 재현 시험보다 크게 낮을 때, 또는 보류 세트 연구에서 현재 가중치를 분명히 이기는 값이 나올 때 점수식을 다시 검토한다.
