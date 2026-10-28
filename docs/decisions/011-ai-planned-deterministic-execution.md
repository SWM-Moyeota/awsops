# ADR-011: AI-Planned, Deterministic Execution / AI 계획 + 결정적 실행

## Status: Accepted / 상태: 승인됨 (2026-10-28)

## Context / 컨텍스트

ADR-010 added the only write path from Slack — EC2 start/stop/reboot — and banned LLMs from reading
control commands. The team now also wants to change tags and security-group inbound rules from Slack
("web-dev에 owner 태그 jiwoo로 붙여줘", "sg-web에 8080 열어줘"). These requests come in many shapes
(several steps, source aliases, removal by rule), so a regex parser like `slack-control/parse.ts`
would either reject most of them or grow into a fragile grammar.

ADR-010은 Slack에서 EC2를 켜고 끄는 유일한 쓰기 경로를 만들면서 제어 명령 해석에 LLM을 금지했다.
이제 팀은 태그와 보안그룹 인바운드 규칙도 Slack에서 바꾸고 싶어 한다. 이런 요청은 모양이 다양해서
(여러 단계, 출처 별칭, 규칙 삭제) 정규식 해석기로는 대부분 거절하거나 깨지기 쉬운 문법이 된다.

## Decision / 결정

Let an LLM **propose** a plan, and let code do everything that decides what actually changes
(`src/lib/action-plan/`). The LLM is a drafter, not an executor.

1. **The planner sees no data** — one Bedrock call with forced tool use (`submit_plan`) receives only
   the requester's current message (mentions stripped, ≤1000 chars), the fixed action catalog and the
   alias **names**. No thread history, resource names, tags, SG descriptions, alias CIDRs or logs, so
   there is nothing in its input for an attacker to plant instructions in except the request itself.
2. **Code fixes the targets** — the plan's `ref` is free text; `resolve.ts` maps it to a resource
   only among those tagged `awsops:control=allow` (terminated/shutting-down excluded). Ambiguous or
   unknown refs are rejected with the candidate list. Alias names expand to CIDRs from
   `config.actionPlan.sourceAliases`, never from the model.
3. **Rules and IAM are the final boundary** — `policy.ts` rejects the whole plan on any denial
   (prod-tagged resources, `awsops:*` tag keys, world-open ports other than 80/443, protocol `-1`,
   port spans over 1000, SGs used by more than `maxBlastRadius` ENIs, in-between instance states).
   Execution assumes `AWSopsActionExecutorRole` with an inline session policy holding exactly the
   plan's actions and ARNs, and that role only allows IDs an admin listed in
   `scripts/17-setup-action-executor.sh` **and** tagged `awsops:control=allow`, with an explicit
   Deny on `awsops:*` tag keys. A wrong plan can at worst propose something these layers refuse.
4. **Two people approve** — the same two-step store as ADR-010 (`slack-control/requests.ts`,
   generalized): the requester confirms the previewed before → after card, then a different approver
   from `slackControl.approverIds` approves behind Slack's confirm dialog. `slackControl.allowSelfApproval` is **not**
   inherited: action-plan forces it to `false` (`config.ts`), so one person can never run an AI action alone,
   even on a deployment that lets the requester self-approve slack-control start/stop. Right before executing,
   the targets are re-read; if any touched field changed since the preview, nothing runs.
5. **Audit and undo** — every state change is appended to a hash-chained
   `data/action-plan/audit.jsonl`; successful steps store their inverse, and "↩️ 되돌리기" (24 h)
   creates a new request that goes through the same checks and approvals.

LLM은 계획을 **제안**만 하고, 실제로 무엇이 바뀔지는 모두 코드가 정한다.
- 플래너는 데이터를 보지 않는다 — 이번 메시지, 고정 카탈로그, 별칭 이름만 받는다.
- 대상은 코드가 확정한다 — 태그 `awsops:control=allow`가 있는 리소스 중에서만 고른다.
- 규칙과 IAM이 최종 경계다 — 규칙 하나라도 걸리면 계획 전체를 거부하고, 세션 정책과 17번 스크립트의
  ID 목록·태그 조건·`awsops:*` 태그 Deny가 그 밖의 변경을 막는다.
- 사람 2명이 승인한다 — 요청자 확인 → 다른 승인자 최종 승인. 실행 직전에 다시 읽어 바뀐 게 있으면
  실행하지 않는다.

## Trust boundary / 신뢰 경계

Inherited unchanged from ADR-010: approvals run inside the dashboard process and the caller sets
`SourceIdentity`, so **host shell access equals execution authority** over the resources listed in
script 17. The same mitigations apply (IMDSv2 required, explicit ID list, reversible actions, `/vscode`
off in production), and moving execution off-host remains the follow-up if the boundary must be
stronger. ADR-010's rule still holds for `slack-control`: start/stop/reboot alone stays rule-based.

ADR-010의 신뢰 경계를 그대로 이어받는다. 승인 검사는 대시보드 프로세스 안에서 하고 SourceIdentity는
호출자가 정하므로, 호스트 셸 접근은 17번 스크립트에 등록된 리소스에 대한 실행 권한과 같다.

## Consequences / 결과

- Off by default: nothing runs until `actionPlan.enabled` is true, `slackControl.approverIds` is set
  and `scripts/17-setup-action-executor.sh` has listed the resources. While off, a detected request
  gets one line ("AI 실행 기능이 꺼져 있어요") and the planner is not called.
- Routing order: `control` → `action-plan` → change → cost → AI. `slack-control` skips sentences
  action-plan detects only while action-plan is on, so its behaviour is unchanged when off.
- The AI answer tools (MCP/Lambda) stay read-only; this pipeline is separate from them.
- Phase 1 covers tags, SG inbound rules and start/stop only. Creating or deleting resources stays out
  of scope.
