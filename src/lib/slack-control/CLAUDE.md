# Slack Control 모듈

## 역할
Slack에서 EC2 시작/정지/재부팅을 **2단계 승인**으로 실행한다. AI를 거치지 않는 유일한 쓰기 경로다. 결정 배경: `docs/decisions/010-slack-approval-gated-control.md`. 운영 안내: `docs/runbooks/slack-chatops.md` "Slack 제어" 절.

## 주요 파일
- `parse.ts` — `detectAction(text)`(명령형만: 꺼줘/켜줘/재시작/stop/start/reboot — "켜진/켜져" 같은 상태 질문은 매칭 안 됨), `parseControlRequest(text, instances)` → none / request / no-target / ambiguous. 인스턴스 이름은 단어 단위로, ID는 `i-...`로 찾는다. **LLM 미사용**.
- `requests.ts` — `createRequestStore()`: 메모리 상태 머신. proposed →(요청자 `confirm`)→ pending →(다른 승인자 `beginApproval`)→ executing → executed/failed, 그 밖에 cancelled/rejected/expired. 동기 전이라 1회만 실행되고, TTL이 지나면 만료된다. 요청자 본인은 승인할 수 없다(`allowSelfApproval`이면 가능). 서버를 재시작하면 대기 중인 요청은 사라진다.
- `ec2.ts` — `listControllableInstances()`(태그 `awsops:control=allow`), `describeControllable(id)`(실행 직전 재조회), `executeControl(action, id, approverId)`: `AWSopsSlackControlRole`을 `SourceIdentity=slack-<승인자>`로 AssumeRole한 뒤 Start/Stop/Reboot를 실행한다. `ALLOWED_FROM`은 작업별로 실행 가능한 현재 상태다.
- `cards.ts` — `controlCard(req, cfg)`: 상태별 카드(1단계 확인 버튼, 2단계 최종 승인 + Slack confirm 대화상자, 결과). 버튼 `action_id`는 `CTL.*`(접두사 `awsops_ctl_`), 값은 요청 ID다.
- `handle.ts` — `maybeHandleControlMention(event, deps)`(제어 명령이면 true → AI로 보내지 않음), `handleControlAction(payload, deps)`(버튼 처리, 권한이 없으면 ephemeral 안내, 실행 직전 태그와 상태 재확인), `getControlConfig()`(`config.slackControl`, 승인자가 없으면 null = 꺼짐).
- `audit.ts` — `appendAudit(req)`: `data/slack-control/audit.jsonl`에 추가만 한다(예외 없음, `SLACK_CONTROL_DATA_DIR`로 경로 변경 가능).
- 연결: `slack-chatops/bot.ts`가 `ControlDeps`를 만들고, 멘션은 `tryControl`, `interactive` 이벤트 중 `awsops_ctl_*`는 `handleControlAction`으로 보낸다.
- IAM: `scripts/16-setup-slack-control.sh`. 역할의 신뢰 정책은 `awsops-ec2-role`만 허용하고 `sts:SourceIdentity`가 `slack-*`여야 한다. 권한은 태그 조건이 걸린 Start/Stop/Reboot뿐이다.

## 규칙
- 제어 명령 해석에 LLM을 쓰지 않는다.
- 권한 규칙(누가 어느 단계를 누를 수 있는지)은 `requests.ts`에만 둔다.
- IAM 태그 조건을 지우거나 넓히지 않는다. 이것이 다른 팀 리소스를 지키는 최종 경계다.
- 새 작업(생성·삭제 등)을 추가할 때도 같은 2단계 저장소를 쓰고, 그 작업 전용의 좁은 IAM 권한을 따로 만든다.

---

# Slack Control Module (English)

## Role
Runs EC2 start/stop/reboot from Slack behind a **two-step approval**. It is the only write path, and it never goes through the AI. Why it exists: `docs/decisions/010-slack-approval-gated-control.md`.

## Key Files
- `parse.ts` — `detectAction` matches command forms only. `parseControlRequest` finds the target by whole-word name or `i-...` ID. No LLM.
- `requests.ts` — In-memory state machine: requester `confirm` (step 1), then a different approver `beginApproval` (step 2), which executes exactly once. Requests expire after a TTL and are lost on restart.
- `ec2.ts` — Lists tagged instances and re-reads one right before execution. `executeControl` assumes `AWSopsSlackControlRole` with `SourceIdentity=slack-<approver>`.
- `cards.ts` — One card per request, redrawn on every state change. The final-approve button uses Slack's confirm dialog.
- `handle.ts` — Mention and button entry points. Unauthorized clicks get an ephemeral notice. Tag and state are re-checked before executing. `getControlConfig()` returns null (off) until approvers are set.
- `audit.ts` — Appends to `data/slack-control/audit.jsonl`.
- IAM: `scripts/16-setup-slack-control.sh`. Only Start/Stop/Reboot, only on instances tagged `awsops:control=allow`. Only `awsops-ec2-role` may assume the role, and only with a `slack-*` SourceIdentity.

## Rules
- No LLM in command parsing.
- Permission rules live only in `requests.ts`.
- Never widen or remove the IAM tag condition.
- New actions reuse the two-step store and get their own narrow IAM permissions.
