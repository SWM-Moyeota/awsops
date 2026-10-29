# ADR-014: Terraform Export Gated by "Diff 0", Rules First, AI Only for Leftovers / "바뀔 것 0개" 관문을 둔 Terraform 내보내기, 규칙 먼저 AI는 나머지만

## Status: Accepted / 상태: 승인됨 (2026-10-29)

## Context / 컨텍스트

Many resources were created by hand in the console. Moving them into Terraform means writing code that matches reality, and the only honest proof that code matches reality is `terraform plan` showing **no changes**. Asking an LLM to write HCL from the resource description is easy to build but easy to get wrong: there is no ground truth, and models invent attributes that do not exist.

콘솔에서 손으로 만든 리소스가 많다. 이것을 Terraform으로 옮기려면 현실과 같은 코드를 써야 하고, 코드가 현실과 같다는 정직한 증거는 `terraform plan`이 **바뀔 것 0개**를 보이는 것뿐이다. 리소스 설명만 보고 LLM이 HCL을 쓰게 하면 만들기는 쉽지만 틀리기도 쉽다. 정답이 없고, 모델이 없는 속성을 지어낸다.

## Decision / 결정

Generate with Terraform itself, fix with **deterministic rules first**, let the AI fix only what the rules cannot, and ship only code that passes a **diff-0 gate** read from the plan JSON (`src/lib/tf-export/`).

Terraform이 직접 코드를 생성하게 하고, **결정적 규칙으로 먼저** 고치고, 규칙이 못 고친 것만 AI가 고치며, plan JSON으로 확인한 **diff 0 관문**을 통과한 코드만 내보낸다.

1. **Generate** — pick resources from the dependency graph (ADR-012; 15 graph types plus ALB/NLB listeners), write `import` blocks, run `terraform plan -generate-config-out`. One account and one region per job.
2. **Rules** — drop null/empty attributes and fix errors line by line (`rules.ts`), plus per-type rules (for example `aws_lb` `subnet_mapping` vs `subnets`, `aws_lambda_function` code source, `aws_instance` `user_data` stored as a hash: remove it and add `ignore_changes = [user_data]`).
3. **AI for leftovers** — only the error blocks the rules could not fix go to Bedrock, with scrubbed text. The returned block is validated strictly: no `provisioner`, `data "external"`, `data "http"`, `module`, `provider`, `count`, `for_each`, `prevent_destroy`, no non-ASCII identifiers; `ignore_changes` may list only `user_data`, `user_data_base64`, `tags_all`.
4. **Diff-0 gate** — `terraform show -json` is read in `planjson.ts`; a resource passes only when its plan is import-only with zero changes. Levels: refactored (references and names tidied, layer files) → refactored with references undone for resources that change → named → raw. The shipped bundle is always the last level that is diff 0. A job is capped at 30 minutes; the cap aborts the running terraform process (AbortController).
5. **Allowlisted executor** — `runner.ts` is the safety boundary. The honest note: the host EC2 role is **not fully read-only** (ReadOnlyAccess plus some writes such as `ModifyListener`, S3 `PutObject`, `sts:AssumeRole`), so we do not rely on the role. The executor allows only `version`, `init`, `plan`, `show`, `validate`, `fmt` with an allowlist of flags (`Object.hasOwn` checks); all inherited `TF_*` env vars, endpoint and proxy variables are dropped; a pinned CLI config file in the job folder allows only `hashicorp/aws`; `HOME` is the job folder; a workspace scan before every plan rejects unsafe config (`UnsafeConfig`). Cross-account jobs fail closed (`NoCredentials`) and use fresh, uncached AssumeRole credentials per command. **`apply` and state are never used; no state file is written.**
6. **Secrets** — right after generation, secret values are moved into `sensitive` variables. Real values live only in `secrets.auto.tfvars` inside the job folder, which is deleted at packaging, failure and cap; non-done job folders are swept at recovery and at `startJob`. The bundle ships `terraform.tfvars.example` with `CHANGE_ME`. The AI only sees scrubbed text (`scrubForAi`, `scrubErrorText`, including ANSI and box prefixes). Logs carry error names only.

- 생성: 의존성 그래프(ADR-012)에서 리소스를 고르고(그래프 15종 + ALB/NLB 리스너) `import` 블록을 쓴 뒤 `terraform plan -generate-config-out`을 돌린다. 작업 하나는 계정 하나, 리전 하나다.
- 규칙: null·빈 속성을 지우고 오류를 줄 단위로 고치며(`rules.ts`), 종류별 규칙이 있다(예: `aws_lb`의 `subnet_mapping`과 `subnets` 충돌, `aws_lambda_function` 코드 소스, 해시로 저장된 `aws_instance` `user_data`는 지우고 `ignore_changes = [user_data]`).
- 나머지만 AI: 규칙이 못 고친 오류 블록만 가려진 텍스트로 Bedrock에 보낸다. 돌려받은 블록은 엄격히 검증한다: `provisioner`, `data "external"`, `data "http"`, `module`, `provider`, `count`, `for_each`, `prevent_destroy`, 비ASCII 식별자 금지, `ignore_changes`는 `user_data`·`user_data_base64`·`tags_all`만.
- diff 0 관문: `planjson.ts`가 `terraform show -json`을 읽고, 가져오기만 있고 바뀔 것이 0개인 리소스만 통과시킨다. 단계: 정리됨(참조·이름 정리, 레이어 파일) → 바뀌는 리소스는 참조를 되돌린 정리됨 → 이름 붙임 → 원본. 내보내는 묶음은 항상 diff 0인 마지막 단계다. 작업은 30분 상한이고 상한이 되면 실행 중인 terraform을 AbortController로 끊는다.
- 허용 목록 실행기: `runner.ts`가 안전 경계다. 솔직히 말하면 호스트 EC2 역할은 **완전한 읽기 전용이 아니다**(ReadOnlyAccess에 `ModifyListener`, S3 `PutObject`, `sts:AssumeRole` 같은 쓰기가 일부 있음). 그래서 역할을 믿지 않는다. 실행기는 `version`·`init`·`plan`·`show`·`validate`·`fmt`와 허용된 플래그만 통과시키고(`Object.hasOwn` 검사), 상속된 `TF_*` 환경 변수와 엔드포인트·프록시 변수를 모두 버리고, 작업 폴더에 고정한 CLI 설정 파일이 `hashicorp/aws`만 허용하며, `HOME`은 작업 폴더이고, 매 plan 전에 작업 폴더를 검사해 안전하지 않은 설정을 막는다(`UnsafeConfig`). 교차 계정 작업은 자격 증명이 없으면 닫힌 채로 실패하고(`NoCredentials`) 명령마다 새(캐시 안 한) AssumeRole 자격 증명을 쓴다. **`apply`도 상태도 쓰지 않고 상태 파일은 만들어지지 않는다.**
- 비밀: 생성 직후 비밀 값을 `sensitive` 변수로 뽑는다. 실제 값은 작업 폴더의 `secrets.auto.tfvars`에만 있고 묶기·실패·상한 때 지워진다. 끝나지 않은 작업 폴더는 복구 시점과 `startJob`에서 청소한다. 묶음에는 `CHANGE_ME`가 든 `terraform.tfvars.example`이 들어간다. AI는 가려진 텍스트만 본다(`scrubForAi`, `scrubErrorText`, ANSI·상자 접두어 포함). 로그에는 오류 이름만 남긴다.

## Alternatives / 대안 비교

| | Generate + rules + AI leftovers + diff-0 gate (chosen) | AI writes HCL from scratch | Terraformer | former2 | Manual |
|---|---|---|---|---|---|
| Ground truth / 정답 기준 | Terraform's own generator and plan | None | Provider reads | Describe calls | The author |
| Hallucinated attributes / 지어낸 속성 | Blocked by validation and the gate | Likely | No | No | No |
| Provider schema / 프로바이더 스키마 | Current pinned AWS provider | Model memory | Older schemas, weakly maintained | Browser-side, own templates | Current |
| Plan check / plan 확인 | Required (diff 0) | None | None | None | Manual |
| Speed / 속도 | Minutes per batch | Fast but unchecked | Fast | Fast | Slow |
| Weakness / 약점 | Needs the Terraform binary; BSL licence | Wrong silently | Output needs hand fixing | Output needs hand fixing | Slow, error-prone |

Chosen: the diff-0 gate is the only check that tells the user the code matches reality, and the rules-first order keeps the AI small, testable and cheap. The BSL 1.1 licence of Terraform 1.9.8 allows internal use; OpenTofu is a drop-in alternative to evaluate later.

결정: diff 0 관문만이 "코드가 현실과 같다"를 알려 주고, 규칙 먼저 순서가 AI를 작고 시험 가능하고 싸게 유지한다. Terraform 1.9.8의 BSL 1.1 라이선스는 내부 사용을 허용한다. OpenTofu는 그대로 바꿔 쓸 수 있는 대안이라 나중에 평가한다.

## Evaluation / 평가

**Pre-test (hand-run probe, not the shipped pipeline).** Real sandbox, 2026-10-29, read-only, Terraform 1.9.8, AWS provider 5.100.0, one resource per type, 14 resources.

**사전 시험(손으로 돌린 탐색이며 출하한 파이프라인의 수치가 아님).** 실제 샌드박스, 2026-10-29, 읽기만, Terraform 1.9.8, AWS 프로바이더 5.100.0, 종류당 리소스 1개, 14개.

| Step / 단계 | plan errors / 오류 | diff 0 |
|---|---|---|
| Raw generate / 원본 생성 | 18 | 0 |
| Null-drop + error-line rules, 4 rounds / 규칙 4라운드 | 5 (`aws_lb` `subnet_mapping` vs `subnets`, `aws_lambda_function` missing code source) | - |
| Plus type rules for those two / 두 종류 규칙 추가 | 0 | 13/14 |
| Remaining one: `aws_instance` `user_data` stored as a SHA1 hash / 남은 하나: SHA1 해시로 저장된 `user_data` | 0 | now a rule (remove + `ignore_changes [user_data]`), counted as "ignore 사용" / 이제 규칙, "ignore 사용"으로 센다 |

These are probe numbers, not the shipped pipeline's. The full evaluation (all 15 types, the real pipeline) runs after deploy and needs user approval; its numbers will be added here later. Until then no pass rate for the shipped pipeline is claimed.

이 수치는 탐색용이며 출하한 파이프라인의 수치가 아니다. 전체 평가(15종 전부, 실제 파이프라인)는 배포 뒤 사용자 승인을 받아 돌리고 수치는 나중에 여기에 더한다. 그때까지 출하한 파이프라인의 통과율은 주장하지 않는다.

## Consequences / 결과

- **Cost:** no AWS cost (plan only reads); Bedrock tokens only for AI fix rounds.
- **Limits:** Lambda code is not exported (placeholder zip + `ignore_changes`); `user_data` content is not exported (hash, then ignore); no child modules (layer files only); 15 graph types plus ALB/NLB listeners; one account and one region per job; Terraform 1.9.8 must be installed with `scripts/18-setup-terraform.sh`.
- Resources that cannot reach diff 0 are reported per resource, never presented as passed.
- The feature never applies anything and never writes state.

- 비용: AWS 비용 없음(plan은 읽기만). Bedrock 토큰은 AI 수정 라운드에서만 든다.
- 한계: Lambda 코드는 내보내지 않는다(자리 표시 zip + `ignore_changes`). `user_data` 내용은 내보내지 않는다(해시 → ignore). 하위 모듈 없음(레이어 파일만). 그래프 15종 + ALB/NLB 리스너. 작업 하나는 계정 하나, 리전 하나. Terraform 1.9.8은 `scripts/18-setup-terraform.sh`로 설치해야 한다.
- diff 0에 못 닿는 리소스는 리소스별로 알리고 통과로 보이지 않게 한다.
- 어떤 것도 적용하지 않고 상태도 쓰지 않는다.

## Follow-ups / 후속 과제

1. Full evaluation after deploy: all 15 types through the real pipeline (needs user approval; creates no AWS resources but runs against real ones). Add the numbers here.
2. Evaluate OpenTofu as a drop-in replacement for the BSL binary.
3. Decide whether Lambda code and `user_data` content can be exported safely.

1. 배포 뒤 전체 평가: 15종을 실제 파이프라인으로(사용자 승인 필요, AWS 리소스를 만들지는 않지만 실제 리소스를 대상으로 돈다). 수치는 여기에 더한다.
2. BSL 바이너리를 대신할 OpenTofu 평가.
3. Lambda 코드와 `user_data` 내용을 안전하게 내보낼 수 있는지 결정.

## When to revisit / 다시 검토할 때

- The full evaluation shows a pass rate far below the probe, or
- Terraform licence terms change, or OpenTofu proves equivalent.

전체 평가의 통과율이 탐색 수치보다 크게 낮을 때, Terraform 라이선스 조건이 바뀔 때, OpenTofu가 동등하다고 확인될 때 다시 검토한다.
