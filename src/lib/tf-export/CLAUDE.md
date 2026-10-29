# Terraform 내보내기 (tf-export) 모듈

## 역할
콘솔에서 손으로 만든 리소스를 Terraform 코드로 옮긴다. `terraform plan -generate-config-out`으로 코드를 만들고, 결정적 규칙으로 먼저 고치고, 규칙이 못 고친 것만 AI가 고치며, plan JSON에서 "가져오기만 있고 바뀔 것 0개"(diff 0)인 리소스만 묶음(zip)에 넣는다. AWS는 읽기만 한다. 설계 문서: `docs/superpowers/specs/2026-10-29-terraform-export-design.md`, 결정: ADR-014. 설치: `scripts/18-setup-terraform.sh`.

## 주요 파일
- `types.ts` — 공용 타입: 지원 Terraform 종류, 단계, 씨앗(`ExportSeed`), `JobRecord`.
- `select.ts` — 의존성 그래프에서 내보낼 리소스 고르기(그래프 종류 → Terraform 종류), 제외 이유.
- `hcl.ts` · `_scan.ts` — 파서 없는 HCL 텍스트 도구와 토큰 스캐너(문자열·주석·heredoc 안전).
- `rules.ts` — 생성된 코드를 고치는 결정적 규칙(null 제거, 오류 줄 규칙, 종류별 규칙).
- `ai.ts` — Bedrock에 오류 블록만 보내 대체 블록을 받고 엄격히 검증.
- `refactor.ts` — 결정적 정리: 참조, 이름, 레이어 파일, 비밀 변수화.
- `secrets.ts` — 비밀 값 → `sensitive` 변수, AI에 보내기 전 가리기(`scrubForAi`, `scrubErrorText`).
- `planjson.ts` — `terraform show -json`으로 diff 0 판정.
- `runner.ts` — 허용 목록 Terraform 실행기(안전 경계), 설치 확인.
- `job.ts` — 단일 작업 파이프라인, 작업 폴더 검사, 30분 상한, 복구·청소.
- `store.ts` — 작업·지표 JSON 저장(원자적 쓰기, 직렬 체인).
- `readme.ts` · `zip.ts` — 묶음의 한국어 README, 의존성 없는 zip 작성기.
- `api.ts` — `/api/terraform-export` 처리기. 라우트 파일은 얇다.

## 규칙
- Terraform 하위 명령은 `version`·`init`·`plan`·`show`·`validate`·`fmt`만, 플래그도 허용 목록(`Object.hasOwn` 검사). **`apply`와 상태 쓰기는 없다.**
- 상속된 `TF_*`·엔드포인트·프록시 환경 변수와 `AWS_PROFILE`·`AWS_CONFIG_FILE`·`AWS_SHARED_CREDENTIALS_FILE`은 버리고(호스트는 IMDS), 고정한 CLI 설정으로 `hashicorp/aws`만 `data/tf-export/plugin-cache`의 `filesystem_mirror`에서 설치한다(`direct` 없음, `TF_PLUGIN_CACHE_DIR` 없음 — 캐시 폴더가 미러와 같으면 init이 실패하고, 실행 중 다운로드는 없다). `HOME`은 작업 폴더. 매 plan 전에 작업 폴더를 검사한다(`UnsafeConfig`, `aws_lambda_invocation` data/resource 포함).
- terraform은 `detached` 프로세스 그룹으로 돈다. 중단·시간 초과·출력 초과 때 그룹 전체를 SIGKILL하고(프로바이더 플러그인까지) 끝난 뒤에 돌려준다. `nice`나 terraform 바이너리가 없으면 `NotInstalled`.
- 작업 폴더의 `providers.tf`는 `required_version = "= 1.9.8"`, 묶음의 `providers.tf`는 `">= 1.5.0, < 2.0.0"`(프로바이더는 둘 다 `= 5.100.0`). `scripts/18-setup-terraform.sh`는 ec2-user로만 돈다(root 거부).
- 호스트 역할은 완전한 읽기 전용이 아니므로 안전 경계는 실행기다. 교차 계정은 자격 증명이 없으면 닫힌 채 실패하고(`NoCredentials`) 명령마다 새 AssumeRole 자격 증명을 쓴다.
- 비밀은 생성 직후 `sensitive` 변수로 뽑는다. 실제 값은 작업 폴더의 `secrets.auto.tfvars`에만 있고 묶기·실패·상한 때 지운다. 묶음에는 `CHANGE_ME`만 나간다. AI에는 가린 텍스트만 준다.
- AI 블록은 `provisioner`, `data external/http`, `module`, `provider`, `count`, `for_each`, `prevent_destroy`, 비ASCII 식별자를 금지하고 `ignore_changes`는 `user_data`·`user_data_base64`·`tags_all`(`aws_lambda_function`은 `filename`·`source_code_hash`, `aws_instance`는 `user_data_replace_on_change`도)과 보낸 블록에 이미 있던 항목만 허용한다.
- 내보내는 묶음은 항상 diff 0인 마지막 단계다. diff 0이 아닌 것을 통과로 표시하지 않는다. 예외 하나: 가져오기이면서 값이 같고 모르는 값도 없이 숨김 표시만 바뀐 `update`(비밀 변수 때문)는 `sensitiveOnly`로 통과시키되 🟡(`pass-ignore`)로 세고 README의 기대 `change` 수에 넣는다.
- 로그와 API 오류에는 오류 이름만 남긴다. 작업은 한 번에 하나, 30분 상한.
- 규칙을 바꾸면 테스트를 돌리고, 사전 시험 수치는 탐색용이라 출하 파이프라인 수치로 쓰지 않는다.

---

# Terraform Export Module (English)

## Role
Moves resources created by hand in the console into Terraform code. Generates code with `terraform plan -generate-config-out`, fixes it with deterministic rules first, lets the AI fix only what the rules cannot, and puts only resources that are import-only with zero changes (diff 0) in the plan JSON into the bundle (zip). AWS is read-only. Spec: `docs/superpowers/specs/2026-10-29-terraform-export-design.md`, decision: ADR-014. Install: `scripts/18-setup-terraform.sh`.

## Key Files
- `types.ts` — shared types: supported Terraform types, stages, `ExportSeed`, `JobRecord`.
- `select.ts` — pick exportable resources from the dependency graph (graph kind to Terraform type), exclusion reasons.
- `hcl.ts` · `_scan.ts` — parser-free HCL text utilities and token scanner (string, comment and heredoc safe).
- `rules.ts` — deterministic rules that fix generated code (null drop, error-line rules, per-type rules).
- `ai.ts` — sends only error blocks to Bedrock and strictly validates the replacement.
- `refactor.ts` — deterministic tidy: references, names, layer files, secret variables.
- `secrets.ts` — secrets to `sensitive` variables; scrubbing before the AI (`scrubForAi`, `scrubErrorText`).
- `planjson.ts` — diff-0 verdict from `terraform show -json`.
- `runner.ts` — allowlisted Terraform executor (the safety boundary), install check.
- `job.ts` — single-job pipeline, job folder scan, 30-minute cap, recovery and sweep.
- `store.ts` — job and stats JSON store (atomic writes, serialized chain).
- `readme.ts` · `zip.ts` — Korean bundle README, dependency-free zip writer.
- `api.ts` — `/api/terraform-export` handlers. The route file is thin.

## Rules
- Only the subcommands `version`, `init`, `plan`, `show`, `validate`, `fmt`, with an allowlist of flags (`Object.hasOwn` checks). **No `apply`, no state writes.**
- Drop inherited `TF_*`, endpoint and proxy env vars and `AWS_PROFILE`/`AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` (the host uses IMDS); a pinned CLI config installs only `hashicorp/aws`, only from the `filesystem_mirror` at `data/tf-export/plugin-cache` (no `direct`, no `TF_PLUGIN_CACHE_DIR` — a cache dir that is also the mirror fails init, and nothing is downloaded at run time); `HOME` is the job folder. Scan the job folder before every plan (`UnsafeConfig`, including `aws_lambda_invocation` data/resource).
- terraform runs in a `detached` process group; abort, timeout and output overflow SIGKILL the whole group (provider plugins too) and the call returns only after exit. A missing `nice` or terraform binary is `NotInstalled`.
- The job folder's `providers.tf` has `required_version = "= 1.9.8"`; the bundle's has `">= 1.5.0, < 2.0.0"` (provider `= 5.100.0` in both). `scripts/18-setup-terraform.sh` runs as ec2-user only (refuses root).
- The host role is not fully read-only, so the executor is the safety boundary. Cross-account fails closed (`NoCredentials`) and uses fresh AssumeRole credentials per command.
- Secrets become `sensitive` variables right after generation. Real values live only in `secrets.auto.tfvars` in the job folder and are deleted at packaging, failure and cap. Only `CHANGE_ME` ships in the bundle. The AI gets scrubbed text only.
- AI blocks may not contain `provisioner`, `data external/http`, `module`, `provider`, `count`, `for_each`, `prevent_destroy` or non-ASCII identifiers; `ignore_changes` may list only `user_data`, `user_data_base64`, `tags_all` (plus `filename`, `source_code_hash` for `aws_lambda_function`, `user_data_replace_on_change` for `aws_instance`) and entries already in the block sent.
- The shipped bundle is always the last diff-0 level. Never show a non-diff-0 resource as passed. One exception: an import `update` whose values are identical, with nothing unknown, where only sensitivity marks change (from secret variables) passes as `sensitiveOnly`, counted yellow (`pass-ignore`) and included in the README's expected `change` count.
- Logs and API errors carry error names only. One job at a time, 30-minute cap.
- After changing a rule, rerun the tests; the pre-test numbers are probe numbers and must not be quoted as the shipped pipeline's.
