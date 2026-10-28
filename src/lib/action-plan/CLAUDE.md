# Action Plan 모듈 (안전한 AI 실행)

## 역할
Slack에서 태그, 보안그룹 인바운드 규칙, EC2 켜기·끄기를 바꿔 달라는 말을 받으면 **AI는 계획만 짜고**, 대상 확정·규칙 검사·실행은 코드가, 승인은 사람 2명이 한다. 결정 배경: `docs/decisions/011-ai-planned-deterministic-execution.md`(ADR-010의 신뢰 경계를 이어받는다). 운영 안내: `docs/runbooks/slack-chatops.md` "AI 실행" 절.

## 흐름
멘션 → `detect` → (꺼져 있으면 한 줄 안내) → `planner` → `validate` → `resolve` → `snapshot` → `changes` → `policy` → 권한 미리 확인(DryRun) → 카드 1장 → 1단계 요청자 확인 → 2단계 다른 승인자 최종 승인 → 다시 읽고 `findDrift` → 세션 정책으로 좁힌 역할로 `executeChanges` → 실행 기록 + 감사 로그 → (24시간 안) 되돌리기는 새 요청으로 같은 단계를 거친다.

## 주요 파일
- `types.ts`, `config.ts` — 공용 타입(계약)과 `config.actionPlan` 읽기. `getActionPlanConfig()`는 `enabled === true`이고 `slackControl.approverIds`가 있어야 값이 있고, 아니면 null. 기본값 `maxSteps 5`, `maxResources 3`, `maxBlastRadius 5`, `undoHours 24`. `isActionPlanEnabled()`는 `enabled`만 본다. `slackControl.allowSelfApproval`은 물려받지 않고 항상 `false`로 고정한다 — AI 실행은 언제나 요청자가 아닌 다른 승인자가 최종 승인해야 한다(Slack 제어는 기존 동작 그대로).
- `detect.ts` — `detectActionIntent(text)`: 명령형 동사(붙여/달아/바꿔/지워/열어/닫아 … + 줘·줘요·주세요·라)와 대상 단어(태그/보안그룹/sg-…/포트/인바운드/규칙)가 함께 있어야 true. 열어/닫아/막아/허용해는 포트 번호(2-5자리, IP·날짜·개수 제외)나 `sg-…`만 있어도 대상으로 본다("web-dev 8080 열어줘"). 방법·가정 질문("방법", "어떻게", "할 수 있어?", "하면 돼?")은 false. 순수 함수, LLM 없음.
- `planner.ts` — `callPlanner(message, aliasNames, invoke)`, `bedrockInvoke`(30초). 강제 tool 호출 `submit_plan`. **플래너가 받는 것은 이번 메시지(멘션 제거, 1000자), 고정 작업 목록, 별칭 이름뿐이다.**
- `validate.ts` — 플래너 출력 형식 검사. 하나라도 틀리면 계획 전체를 거부한다. 별칭은 여기서 CIDR로 펼친다(`maxSteps`는 펼친 뒤 센다). CIDR은 모두 표준 표기로 바꾸고(`canonicalCidr`: 앞자리 0, 대문자, `::` 표기 정리) 호스트 비트가 0이 아니면(`1.2.3.4/0`) 거부한다. 태그 키·값과 SG 설명에 백틱·줄바꿈 같은 제어 문자가 있으면 거부한다(카드에 그대로 보여 줄 수 없음).
- `resolve.ts` — 계획의 `ref`(사람이 쓴 말)를 태그 `awsops:control=allow` 리소스 중에서만 찾는다. 여러 개·못 찾음·리소스 수 초과는 거부.
- `snapshot.ts`, `changes.ts` — 대상마다 지금 상태(인스턴스 상태·태그, SG 규칙 전체, SG를 쓰는 ENI 수)를 읽고, 단계별 전 → 후, "이미 되어 있음", 역연산을 계산한다.
- `policy.ts` — `evaluatePolicy`: 운영 태그(`env=prod` 등), `awsops:` 태그 키, 80·443이 아닌 전체 공개(접두사 길이 `/0`이면 표기와 상관없이 전체 공개로 본다), 프로토콜 `-1`, 포트 1000개 초과, ENI `maxBlastRadius` 초과(ENI 수를 모르면 거부), 중간 상태(stopping/pending/shutting-down)를 거부한다. 하나라도 걸리면 전체 거부.
- `session-policy.ts` — `buildSessionPolicy(steps, account, region)`: 계획의 액션과 정확한 ARN만 담은 인라인 세션 정책(2048자 한도). 보안그룹 작업은 security-group ARN만 쓴다(`security-group-rule/*` 없음 — AWS 서비스 권한 문서 근거는 파일 주석). `findDrift`: 실행 직전 상태가 계획 때와 다르면 이유 목록.
- `aws.ts` — `createEc2Reader()`(대시보드 역할로 조회, 태그된 것만, terminated/shutting-down 제외, SG 규칙 설명은 되돌리기를 위해 원문 그대로 보관), `createWriterFactory()`: `AWSopsActionExecutorRole`을 `SourceIdentity=slack-<사람>`, `DurationSeconds 900`, 세션 정책으로 AssumeRole. 모든 호출 15초 제한, 리전 `ap-northeast-2`.
- `execute.ts` — `dryRunAll`(DryRun으로 권한 미리 확인), `executeChanges`(순서대로, 첫 실패에서 멈춤, 자동 롤백 없음, `requestId` 기록).
- `executions.ts` — 실행 기록 `data/action-plan/executions/<id>.json`(역연산 포함). 원자적 쓰기.
- `undo.ts` — 저장한 역연산을 거꾸로 돌려주고, 그 사이 다른 변경이 있던 단계는 뺀다. `undoHours` 안에서만.
- `audit.ts` — `data/action-plan/audit.jsonl`에 추가만 한다. 줄마다 `prevHash`/`hash`(sha256 체인), `verifyAuditChain(file)`. 쓰기 실패는 예외를 던지지 않는다. `ACTION_PLAN_DATA_DIR`로 경로 변경 가능.
- `cards.ts` — 요청 하나에 카드 하나, 상태가 바뀔 때마다 다시 그린다. 버튼 `action_id`는 `AP.*`(접두사 `awsops_ap_`), 값은 요청 ID다. AWS로 보내는 값(태그 키·값, CIDR/출처, SG 설명)은 `code()`로 코드 블록 안에 그대로 보여 준다(`& < >`만 엔티티, 자르거나 지우지 않음).
- `handle.ts` — `maybeHandleActionMention(event, deps)`(실행 요청이면 true → AI로 보내지 않음), `handleActionClick(payload, deps)`(확인·취소·승인·거절·되돌리기). 최종 승인 때 다시 읽은 상태로 `findDrift`와 `evaluatePolicy`를 모두 다시 돌리고, 하나라도 걸리면 실행하지 않는다. 실행은 요청 하나당 1회, 되돌리기도 실행 하나당 1회.
- 연결: `slack-chatops/bot.ts`가 `ActionDeps`를 만든다. 승인 저장소는 `slack-control/requests.ts`의 `createApprovalStore<ActionRequest>()`(같은 2단계 규칙). 멘션은 `tryControl` 다음 `tryActionPlan`, `interactive` 이벤트 중 `awsops_ap_*`는 `handleActionClick`으로 보낸다(제어 버튼처럼 중복 제거 없음).
- IAM: `scripts/17-setup-action-executor.sh i-... sg-...`. 인자로 받은 ID **그리고** 태그 `awsops:control=allow`인 리소스에만 6개 액션을 허용하고, `awsops:*` 태그 키를 건드리는 CreateTags/DeleteTags와 태그 목록 없는 DeleteTags(전체 삭제)는 Deny. 신뢰 정책은 16번과 같다(`awsops-ec2-role`만, `sts:SourceIdentity`가 `slack-*`). ID 없이 실행하면 권한을 모두 지운다.

## 규칙
- 플래너 입력에 메시지·작업 목록·별칭 이름 말고는 아무것도 넣지 않는다 (스레드, 리소스 이름·태그, SG 설명, CIDR, 로그 금지).
- 대상은 코드가 정한다. 후보는 태그 `awsops:control=allow` 리소스뿐이다.
- 규칙에 하나라도 걸리면 계획 전체를 실행하지 않는다. "이미 되어 있음"은 거부가 아니라 제외다.
- 실행 직전 다시 읽은 상태가 계획 때와 다르거나, 그 상태로 규칙 검사를 다시 했을 때 거부되면 실행하지 않는다.
- 이름·플래너의 `summary`/`question`처럼 실행되지 않는 값이 들어가는 Slack 문구는 `safeName()`(또는 `cards.ts`의 `clean`)을 거친다. 실행되는 값(태그 키·값, CIDR, SG 설명)은 `cards.ts`의 `code()`로 원문 그대로 보여 준다 — 미리 보기와 실행이 달라지면 안 된다.
- 오류는 이름만 보여 주고 남긴다. 자격 증명과 토큰은 로그에 남기지 않는다.
- IAM의 ID 목록·태그 조건·`awsops:*` Deny를 지우거나 넓히지 않는다. 세션 정책과 17번 스크립트의 리소스 범위를 맞춘다.
- AI 답변 도구(MCP/Lambda)는 계속 읽기 전용이다. 이 파이프라인과 섞지 않는다.

---

# Action Plan Module (Safe AI Actions, English)

## Role
When a Slack mention asks to change tags, security-group inbound rules or EC2 start/stop, **the AI only drafts a plan**; code resolves the targets, checks the rules and executes, and two people approve. Why: `docs/decisions/011-ai-planned-deterministic-execution.md` (inherits ADR-010's trust boundary). Runbook: `docs/runbooks/slack-chatops.md`, "AI 실행" section.

## Flow
mention → `detect` → (one-line notice when off) → `planner` → `validate` → `resolve` → `snapshot` → `changes` → `policy` → permission dry-run → one card → step 1 requester confirms → step 2 a different approver approves → re-read + `findDrift` → `executeChanges` with a session-policy-scoped role → execution record + audit → undo (24 h) is a new request through the same steps.

## Key Files
- `types.ts`, `config.ts` — Contract types and `config.actionPlan`. `getActionPlanConfig()` is null unless `enabled === true` and `slackControl.approverIds` is set. `isActionPlanEnabled()` reads `enabled` only. `slackControl.allowSelfApproval` is not inherited — it is forced to `false`, so the final approver is always someone other than the requester (slack-control keeps its own behaviour).
- `detect.ts` — `detectActionIntent`: an imperative verb plus a target word (for open/close/allow/block, a 2-5 digit port number or an `sg-…` name also counts); how-to and hypothetical questions are excluded. Pure, no LLM.
- `planner.ts` — One Bedrock call (30 s) with forced `submit_plan`. Input is only the message (≤1000 chars), the fixed catalog and alias names.
- `validate.ts` / `resolve.ts` — Shape check (any problem rejects the plan; aliases expand to CIDRs here; every CIDR is canonicalized and host bits must be zero; no backticks/control characters in tag keys, values or SG descriptions) / free-text refs to tagged resources only.
- `snapshot.ts` / `changes.ts` — Current state per target; before → after, no-ops and inverses.
- `policy.ts` — Whole-plan denial on prod tags, `awsops:` keys, world-open (any `/0` prefix) ports other than 80/443, protocol `-1`, spans over 1000 ports, ENIs over `maxBlastRadius` (unknown ENI count denies), in-between states.
- `session-policy.ts` — Inline session policy with exactly the plan's actions and ARNs (SG ARN only, no `security-group-rule/*`); `findDrift` before execution.
- `aws.ts` — Reader (dashboard role) and writer factory (`AWSopsActionExecutorRole`, `SourceIdentity=slack-<user>`, 900 s, session policy). 15 s per call, `ap-northeast-2`.
- `execute.ts` / `executions.ts` / `undo.ts` — Dry-run, ordered execution that stops at the first failure; execution records with inverses; undo planning that skips steps changed since.
- `audit.ts` — Append-only, hash-chained `data/action-plan/audit.jsonl`; `verifyAuditChain`; never throws.
- `cards.ts` / `handle.ts` — One card per request (`awsops_ap_*` buttons; executed values shown verbatim in code spans via `code()`); mention and click entry points. Final approval re-runs `findDrift` and `evaluatePolicy` on the fresh snapshot. The reader keeps raw SG rule descriptions so undo restores them exactly.
- Wiring: `slack-chatops/bot.ts` builds `ActionDeps` with `createApprovalStore<ActionRequest>()` from `slack-control/requests.ts`. Mentions go `tryControl` → `tryActionPlan`; `awsops_ap_*` clicks go to `handleActionClick` without dedupe.
- IAM: `scripts/17-setup-action-executor.sh i-... sg-...` — the 6 actions only on listed IDs **and** tagged `awsops:control=allow`, explicit Deny on `awsops:*` tag keys and on DeleteTags without a Tags list (delete-all), same trust as script 16. No IDs removes all permissions.

## Rules
- The planner gets nothing beyond the message, the catalog and alias names.
- Code picks the targets; candidates are tagged resources only. Any denial rejects the whole plan.
- Drift since the preview, or a policy denial on the fresh state at approval, means no execution.
- Slack text built from names or planner text goes through `safeName()`/`clean`; values that execute are shown verbatim through `code()`.
- Errors carry the name only; never log credentials or tokens.
- Never widen or remove the IAM ID list, tag condition or `awsops:*` Deny. Keep the session policy and script 17 resource scope in step.
- The AI answer tools stay read-only and separate from this pipeline.

- `graphImpact` (informational): at plan time `handle.ts` reads `dep-graph/summary.impactSummary` per SG; `cards.ts` shows one extra line. Not used by policy/approval/execution.
