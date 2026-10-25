# ADR-010: Slack Approval-Gated EC2 Control / Slack 승인 기반 EC2 제어

## Status: Accepted / 상태: 승인됨 (2026-10-26)

## Context / 컨텍스트

AWSops was read-only by rule, and on 2026-10-26 the AI's AWS tools were locked down to read-only
(commit ac581fb) after `call_aws` + a broad Lambda role turned out to let a chat message stop or
delete resources in the shared sandbox account. The team still wants to act from Slack — e.g. stop a
server someone forgot to turn off — without opening that hole again.

AWSops는 읽기 전용이 원칙이고, 같은 날 AI 도구를 읽기 전용으로 잠갔다. 그래도 팀은 Slack에서
"깜빡 켜 둔 서버 끄기" 같은 조치를 하고 싶어 한다 — 그 구멍을 다시 열지 않으면서.

## Decision / 결정

Add a narrow, separate write path for EC2 start/stop/reboot that never goes through the AI:

1. **Rule-based parsing, no LLM** — `src/lib/slack-control/parse.ts` reads command forms only
   (꺼줘/켜줘/재시작/stop/start/reboot) and a whole-word instance name or ID. A model can't misread
   the target or be prompt-injected into picking one.
2. **Two human steps** — step 1: the requester confirms the parsed target on a card; step 2: an
   approver from `config.slackControl.approverIds` who is *not* the requester (unless
   `allowSelfApproval`) gives the final approval, behind Slack's native confirm dialog. Requests are
   single-use, expire after 15 minutes, and live only in memory (a restart drops them).
3. **Two system layers** — the code re-checks the instance right before executing (still tagged,
   state fits the action), and the IAM role `AWSopsSlackControlRole` only allows
   `ec2:Start/Stop/RebootInstances` on instance IDs an admin listed in
   `scripts/16-setup-slack-control.sh` **and** that carry the tag `awsops:control=allow`. The tag
   alone is not enough: anyone in the shared account can add a tag, but not edit this policy.
4. **Audit** — every state change goes to `data/slack-control/audit.jsonl`, and the role is assumed
   with `SourceIdentity=slack-<approver>`, so CloudTrail shows who approved each call.

AI 경로와 분리된 좁은 쓰기 경로: 규칙 기반 해석(LLM 없음), 사람 2단계(요청자 확인 → 다른 승인자
최종 승인), 시스템 2겹(실행 직전 재확인 + 태그 조건 IAM), 감사 로그 + CloudTrail SourceIdentity.

## Trust boundary / 신뢰 경계

The approval checks run inside the dashboard process, and `SourceIdentity` is set by the caller.
Anyone with a shell on the dashboard host (SSM session, `/vscode` code-server) can assume the role
directly and skip both steps — so **host shell access equals control authority** over the listed
instances. Mitigations: IMDSv2 is required on the host (`HttpTokens=required`, so an SSRF GET cannot
fetch role credentials), the blast radius is the explicit instance list, and stop/start/reboot are
reversible. Moving execution off-host (e.g. a Lambda that verifies the approval independently) is
the follow-up if this boundary must be stronger. Turning off `/vscode` in production is recommended.

승인 검사는 대시보드 프로세스 안에서 이뤄지고 SourceIdentity는 호출자가 정한다. 따라서 호스트 셸
접근(SSM, /vscode)은 목록에 있는 인스턴스에 대한 제어 권한과 같다. IMDSv2 필수, 명시적 인스턴스 목록,
되돌릴 수 있는 작업으로 피해 범위를 줄인다.

## Consequences / 결과

- The AI tools stay read-only; this path is the only way AWSops changes AWS from Slack.
- A server is controllable only when an admin lists its ID in `16-setup-slack-control.sh` and it is tagged `awsops:control=allow`.
- Off by default: nothing works until `slackControl.approverIds` is set and `scripts/16-setup-slack-control.sh` has run.
- Resource creation/deletion is out of scope here; if added later it must reuse the same two-step
  store and an equally narrow IAM role (templates only, tag-conditioned).
