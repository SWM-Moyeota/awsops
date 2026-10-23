# Health Alerts (Slack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect AWSops component failures (Steampipe, Bedrock, AgentCore, tool Lambdas, external reachability, EC2 stopped/unresponsive) and post a Slack message only when state changes.

**Architecture:** Two layers. (1) An in-server monitor inside Next.js (`src/lib/health/*`, 5-min loop, state persisted to `data/health-status.json`, heartbeat to CloudWatch). (2) An out-of-server Python Lambda `awsops-health-watchdog` triggered by EventBridge (5-min rate + EC2 state-change + CloudTrail API-call events), state in SSM. Both read the Slack webhook from SSM SecureString `/ops/awsops/slack-webhook-url`. AWS resources are created by a CLI script run from the admin's Mac — never `cdk deploy`.

**Tech Stack:** Next.js 14 / TypeScript, AWS SDK v3, vitest (new devDependency, unit tests only), Python 3.12 + stdlib `unittest`, bash + AWS CLI v2.

**Spec:** `docs/superpowers/specs/2026-10-22-health-alerts-design.md`

## Global Constraints

- Branch `feature/sandbox-deploy`. Never run `cdk deploy` (UserData + ALB drift → EC2 replacement risk).
- Region `ap-northeast-2`, account `116662357283`, instance `i-0806bafeb330307d5`, ALB name `awsops-alb`, dashboard URL `https://awsops.moyeota.co.kr/`.
- Webhook lives only in SSM SecureString `/ops/awsops/slack-webhook-url` (AWS-managed key `alias/aws/ssm`). Never in Git, `data/config.json`, logs, or shell history.
- Alert only on state change; `ok→fail` needs 2 consecutive failures (3 for `agentcore-invoke`); `fail→ok` needs 1 success; `unknown→ok` never alerts.
- Intervals: monitor loop 5 min; Bedrock + Lambda probes every 30 min (every 6th loop); watchdog 5 min; heartbeat stale after 15 min; skip heartbeat judgement for 15 min after EC2 launch.
- Tool Lambdas = exactly these 19 (explicit list, no glob): `awsops-aws-knowledge awsops-cloudtrail-mcp awsops-cloudwatch-mcp awsops-core-mcp awsops-cost-mcp awsops-dynamodb-mcp awsops-ecs-mcp awsops-eks-mcp awsops-flow-monitor awsops-iac-mcp awsops-iam-mcp awsops-istio-mcp awsops-msk-mcp awsops-network-mcp awsops-rds-mcp awsops-reachability-analyzer awsops-steampipe-query awsops-terraform-mcp awsops-valkey-mcp`. Probe payload `{"tool_name":"__healthcheck__"}`.
- No synchronous `awsCli`/`execFileSync` in the monitor; use AWS SDK v3 clients.
- Repo rules from `CLAUDE.md`: fetch URLs `/api/*`, default exports for components, StatsCard `color` by name, i18n keys in all of `en/ko/zh.json`, DB access only through `src/lib/steampipe.ts`, update `src/lib/CLAUDE.md` / `src/app/CLAUDE.md` / new-dir `CLAUDE.md` when adding files.
- Slack copy is Korean. Each message: emoji + `[AWSops]` + item title, one-line cause, KST time, one-line action, dashboard link.

## Review Focus

1. **Server restart with an existing `data/health-status.json`** — previous `fail` items must still produce a 🟢 recovery when the first check passes, and previous `ok` items must not re-alert. → Task 1 test `restoredFailRecoversOnFirstSuccess`.
2. **Multi-route AI request where 3 routes fail in parallel** — counts as 1 AgentCore failure, not 3. → Task 3 test `parallelFailuresInOneRequestCountOnce`.
3. **Webhook not configured / Slack returns non-200** — monitor keeps running, UI still shows state, one warning log only. → Task 2 test `postSlackReturnsErrorOnNon200` + Task 3 test `noWebhookSkipsSendWithoutThrowing`.
4. **EC2 `stopping` then `stopped` events plus a scheduled run in the same minute** — exactly one 🛑 message. → Task 5 test `stoppingThenStoppedAlertsOnce`.
5. **ALB or target group missing (`TargetGroupNotFound`, LB not found)** — treated as failure, not a crash. → Task 5 test `missingTargetGroupIsDashboardFail`.

---

### Task 1: Health state machine (pure logic)

**Files:**
- Create: `src/lib/health/types.ts`, `src/lib/health/state.ts`, `src/lib/health/CLAUDE.md`
- Create: `vitest.config.ts`, test `src/lib/health/__tests__/state.test.ts`
- Modify: `package.json` (devDependency `vitest`, script `"test": "vitest run"`), `.gitignore` (add `data/health-status.json`)

**Interfaces:**
- Produces (types.ts):
  ```ts
  export type CheckId = 'steampipe' | 'bedrock' | 'agentcore-runtime' | 'agentcore-invoke' | 'lambda';
  export type CheckStatus = 'ok' | 'fail' | 'unknown';
  export interface CheckResult { id: CheckId; ok: boolean; message: string }
  export interface ItemState { status: CheckStatus; consecutiveFailures: number; lastChecked: string | null; message: string; since: string | null }
  export type HealthState = Record<CheckId, ItemState>;
  export interface Transition { id: CheckId; from: CheckStatus; to: 'ok' | 'fail'; message: string; at: string }
  export const CHECK_IDS: CheckId[];
  ```
- Produces (state.ts): `initialState(): HealthState`, `applyResults(prev: HealthState, results: CheckResult[], now: Date): { next: HealthState; transitions: Transition[] }`, `loadState(path: string): HealthState` (returns `initialState()` on missing/corrupt file), `saveState(path: string, s: HealthState): void` (write `path.tmp` then `renameSync`).
- Thresholds constant `FAIL_THRESHOLD: Record<CheckId, number>` = 2 for all except `agentcore-invoke` = 3.

- [ ] **Step 1: Write failing tests** in `state.test.ts`:
  - `firstFailureDoesNotTransition`: one fail from `unknown` → `transitions` empty, `consecutiveFailures === 1`.
  - `secondConsecutiveFailureTransitionsToFail`: two fails → one transition `{from:'unknown', to:'fail'}`.
  - `agentcoreInvokeNeedsThree`: 2 fails → none, 3rd → transition.
  - `unknownToOkIsSilent`: one ok from `unknown` → status `ok`, transitions empty.
  - `restoredFailRecoversOnFirstSuccess`: prev status `fail` → one ok → transition `{from:'fail', to:'ok'}`, counter 0.
  - `okStaysQuietOnRepeatSuccess`: `ok` + ok → no transition.
  - `resultsForUnlistedItemsLeaveThemUntouched`: results only for `steampipe` leave `bedrock` byte-identical.
  - `loadStateFallsBackOnCorruptFile`: write `"{not json"` to a temp file → `loadState` equals `initialState()`.
  - `saveStateIsAtomic`: after `saveState`, file parses and no `.tmp` file remains.
- [ ] **Step 2:** `npm i -D vitest && npx vitest run src/lib/health` → FAIL (module not found).
- [ ] **Step 3:** Implement `types.ts` and `state.ts` per Interfaces. `since` = ISO time of last status change.
- [ ] **Step 4:** `npx vitest run src/lib/health` → all PASS; `npx tsc --noEmit -p .` → no errors.
- [ ] **Step 5:** Write `src/lib/health/CLAUDE.md` (role + file list, bilingual like sibling CLAUDE.md files). Commit `feat(health): add health state machine with tests`.

### Task 2: Slack formatting and delivery

**Files:**
- Create: `src/lib/health/slack.ts`, test `src/lib/health/__tests__/slack.test.ts`
- Modify: `package.json` (dependency `@aws-sdk/client-ssm`)

**Interfaces:**
- Consumes: `Transition`, `CheckId` (Task 1).
- Produces:
  ```ts
  export const CHECK_TITLES: Record<CheckId, string>;      // e.g. steampipe: 'Steampipe 데이터베이스'
  export const REMEDIATION: Record<CheckId, string>;       // one-line action, Korean
  export function formatSlackMessage(transitions: Transition[], opts: { dashboardUrl: string; now: Date }): { text: string };
  export async function postSlack(webhookUrl: string, payload: { text: string }): Promise<{ ok: boolean; error?: string }>;
  export async function getWebhookUrl(): Promise<string | null>; // SSM GetParameter WithDecryption, cached 5 min, null on ParameterNotFound
  export async function sendTestMessage(): Promise<{ ok: boolean; error?: string }>;
  ```
- REMEDIATION exact copy: steampipe `SSM 접속 후 \`sudo su - ec2-user -c "cd ~/awsops && bash scripts/09-start-all.sh"\``; bedrock `Bedrock 모델 접근 권한·config.json의 bedrockModelId 확인`; agentcore-runtime `AgentCore 콘솔에서 런타임 상태 확인, 필요 시 scripts/06g-redeploy-agent.sh`; agentcore-invoke `/tmp/awsops-server.log의 [AgentCore Error] 확인`; lambda `실패한 함수의 CloudWatch 로그 확인 후 scripts/06c-setup-agentcore-tools.sh 재실행`.

- [ ] **Step 1: Write failing tests:**
  - `failMessageHasRedEmojiTitleCauseActionAndLink`: one fail transition for `steampipe` with message `connect ECONNREFUSED` → text contains `🔴`, `[AWSops]`, `Steampipe`, `ECONNREFUSED`, the REMEDIATION line, `https://awsops.moyeota.co.kr/`.
  - `recoveryMessageIsGreenWithoutRemediation`: `to:'ok'` → contains `🟢`, does not contain REMEDIATION text.
  - `multipleTransitionsBundleIntoOneMessage`: 2 transitions → one `text` with both titles.
  - `timeIsRenderedInKst`: `now = 2026-10-22T03:00:00Z` → text contains `12:00`.
  - `postSlackReturnsErrorOnNon200`: stub `global.fetch` → 404 `"no_service"` → `{ ok:false, error: contains '404' }`; never throws.
  - `postSlackNeverLogsWebhookUrl`: spy `console.*` across a failing call → no argument contains the URL.
- [ ] **Step 2:** `npx vitest run src/lib/health/__tests__/slack.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `postSlack` uses `fetch` POST JSON with 10s `AbortSignal.timeout`. `getWebhookUrl` uses `SSMClient` region `ap-northeast-2`.
- [ ] **Step 4:** Tests PASS, `tsc` clean.
- [ ] **Step 5:** Commit `feat(health): Slack message formatting and delivery`.

### Task 3: In-server checks, monitor loop, AI hook

**Files:**
- Create: `src/lib/health/checks.ts`, `src/lib/health/monitor.ts`, tests `src/lib/health/__tests__/checks.test.ts`, `__tests__/monitor.test.ts`
- Modify: `src/lib/steampipe.ts` (export `pingSteampipe`), `src/app/api/ai/route.ts` (`invokeAgentCore`, ~L723-769), `package.json` (deps `@aws-sdk/client-lambda`, `@aws-sdk/client-cloudwatch`, `@aws-sdk/client-bedrock-agentcore-control`)

**Interfaces:**
- Consumes: Task 1 `applyResults/loadState/saveState`, Task 2 `formatSlackMessage/postSlack/getWebhookUrl`; existing `getBedrockModelId()`, `getConfig()`.
- Produces:
  ```ts
  // steampipe.ts
  export async function pingSteampipe(): Promise<{ ok: boolean; message: string }>; // own pg Client, connect 3s, statement 5s, `select 1`, never uses cache/pool
  // checks.ts
  export const TOOL_LAMBDAS: string[];   // the 19 names from Global Constraints
  export function classifyLambdaProbe(functionError: string | undefined, payload: string): { ok: boolean; message: string };
  export async function checkSteampipe(): Promise<CheckResult>;
  export async function checkBedrock(): Promise<CheckResult>;          // max_tokens 1
  export async function checkAgentcoreRuntime(): Promise<CheckResult>; // runtime id from getConfig().agentRuntimeArn
  export async function checkLambdas(): Promise<CheckResult>;          // concurrency 4, per-call 20s
  // monitor.ts
  export function ensureHealthMonitorStarted(): void;   // singleton on globalThis.__awsopsHealthMonitor
  export function reportAgentcoreInvoke(requestId: string, outcome: 'success' | 'error' | 'timeout'): void;
  export function getHealthSnapshot(): { state: HealthState; lastRunAt: string | null; lastSlack: { at: string; ok: boolean; error?: string } | null };
  export async function runOnce(opts?: { includeSlow?: boolean }): Promise<void>; // exported for tests and the API
  ```
- `classifyLambdaProbe`: fail only if `functionError` is set AND payload `errorType` ∈ {`Runtime.ImportModuleError`,`Runtime.HandlerNotFound`,`Runtime.UserCodeSyntaxError`,`Runtime.ExitError`} or `errorMessage` matches `/timed out/i`; everything else (400 Unknown tool, `KeyError`) is ok.
- `reportAgentcoreInvoke`: `error` increments a pending failure for `agentcore-invoke` once per `requestId`; `timeout` only logs; `success` records ok. Feeds `applyResults` immediately (not on the 5-min loop).
- Loop: 5 min; `includeSlow` (bedrock + lambda) on first run and every 6th; after each run `PutMetricData` namespace `AWSops/Health`, metric `Heartbeat`, value 1; persist to `path.join(process.cwd(),'data','health-status.json')`; on transitions send one Slack message if webhook exists, else `console.warn` once per process.

- [ ] **Step 1: Write failing tests:**
  - `classifyImportErrorFails` / `classifyUnknownToolIsOk` / `classifyKeyErrorIsOk` / `classifyTimeoutFails` with literal Lambda payload strings.
  - `toolLambdaListHasExactly19AndExcludesWatchdog`.
  - `parallelFailuresInOneRequestCountOnce`: three `reportAgentcoreInvoke('r1','error')` → `consecutiveFailures === 1`.
  - `threeSeparateErrorRequestsTransition`: r1,r2,r3 errors → snapshot `agentcore-invoke.status === 'fail'`.
  - `timeoutDoesNotCount`: 5 timeouts → status not `fail`.
  - `noWebhookSkipsSendWithoutThrowing`: mock `getWebhookUrl` → null, force transitions via `runOnce` with mocked checks → resolves, `lastSlack` null.
  - `ensureStartedIsIdempotent`: call twice → one interval registered (spy `setInterval`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement checks/monitor (mock AWS clients in tests with `vi.mock`). In `invokeAgentCore`, call `reportAgentcoreInvoke(sessionOrRequestId, ...)` at the timeout branch (`'timeout'`), the catch branch (`'error'`), and the success return when the response is non-empty (`'success'`); pass the same id for all routes of one user request (thread the request id from the POST handler; generate with `crypto.randomUUID()` there).
- [ ] **Step 4:** `npx vitest run` PASS; `npx tsc --noEmit -p .` clean; `npx next lint --file src/app/api/ai/route.ts --file src/lib/steampipe.ts` clean.
- [ ] **Step 5:** Commit `feat(health): in-server checks, monitor loop, AgentCore failure hook`.

### Task 4: Health API, dashboard card, startup wiring

**Files:**
- Create: `src/app/api/health/route.ts`, `src/components/dashboard/SystemHealthCard.tsx`
- Modify: `src/app/page.tsx` (replace the `"8 GW"` AgentCore StatsCard at ~L235-238 with `<SystemHealthCard />`), `src/lib/i18n/translations/{en,ko,zh}.json`, `scripts/09-start-all.sh`, `scripts/13-setup-steampipe-systemd.sh`, `src/app/CLAUDE.md`, `src/components/CLAUDE.md`, `src/lib/CLAUDE.md`

**Interfaces:**
- Consumes: Task 3 `ensureHealthMonitorStarted`, `getHealthSnapshot`, `runOnce`; Task 2 `sendTestMessage`; existing `getUserFromRequest`, `getConfig().adminEmails`.
- Produces:
  - `GET /api/health` → `200 { items: Array<{id, status, message, lastChecked, since}>, lastRunAt, lastSlack, failing: number }`; calls `ensureHealthMonitorStarted()` first.
  - `POST /api/health` body `{action:'test'}` → admin-only (same rule as `steampipe/route.ts:58-62`: `adminEmails` empty ⇒ any non-anonymous user) → `{ok, error?}`; non-admin → 403. Body `{action:'run'}` → admin-only, `await runOnce({includeSlow:true})`, returns snapshot.
  - `SystemHealthCard` (default export): fetches `/api/health` every 60s; StatsCard `color` `green` when `failing===0`, `red` otherwise, `value` = `"정상"`/`"N개 이상"` via i18n, `change` lists failing titles; click opens a small panel with per-item status and a "테스트 알림 보내기" button (POST test).
  - i18n keys (all 3 files): `health.title`, `health.allOk`, `health.failing` (`{count}`), `health.testButton`, `health.testSent`, `health.testFailed`, `health.lastRun`, `health.item.steampipe`, `health.item.bedrock`, `health.item.agentcoreRuntime`, `health.item.agentcoreInvoke`, `health.item.lambda`.
  - `09-start-all.sh`: after the Next.js start block, `curl -s -o /dev/null --max-time 20 http://localhost:3000/api/health` and print `Health monitor: started`.
  - `13-setup-steampipe-systemd.sh`: in the `awsops.service` drop-in add `ExecStartPost=/bin/sh -c 'for i in 1 2 3 4 5 6; do sleep 5; curl -sf -o /dev/null http://localhost:3000/api/health && exit 0; done; exit 0'`.

- [ ] **Step 1:** Write `route.ts`, card, i18n keys, script edits.
- [ ] **Step 2:** `npx tsc --noEmit -p .`, `npx next lint`, `bash -n scripts/09-start-all.sh scripts/13-setup-steampipe-systemd.sh`, `npx next build` → all succeed.
- [ ] **Step 3:** Local smoke: `npx next start -p 3100` then `curl -s localhost:3100/api/health` → JSON with 5 `items`; `curl -s -XPOST localhost:3100/api/health -d '{"action":"test"}' -H 'content-type: application/json'` → returns `{ok:false, error}` without crashing when SSM/webhook is unreachable locally. Stop the server.
- [ ] **Step 4:** Update the three CLAUDE.md files (API list, component list, lib list). Commit `feat(health): health API, dashboard status card, auto-start on boot`.

### Task 5: Watchdog Lambda (Python)

**Files:**
- Create: `agent/lambda/health_watchdog.py`, `agent/lambda/test_health_watchdog.py`
- Modify: `agent/lambda/CLAUDE.md`

**Interfaces:**
- Produces:
  ```python
  def decide(prev: dict, obs: dict, now: float) -> tuple[dict, list[str]]
  # prev: {"server": "running"|"stopped"|"unknown", "dashboard": "ok"|"fail"|"unknown", "heartbeat": ..., "external": ...}
  # obs : {"source": "schedule"|"state-change"|"api-call",
  #        "ec2_state": str|None, "launch_epoch": float|None, "actor": str|None,
  #        "heartbeat_age_sec": float|None,          # None = no datapoint in window
  #        "targets": dict[str,str]|None,            # None = ALB/TG not found
  #        "url_status": int|None, "url_location": str|None}
  # returns (new_state, slack_texts)
  def lambda_handler(event, context) -> dict
  ```
- Env vars: `INSTANCE_ID`, `ALB_NAME` (`awsops-alb`), `DASHBOARD_URL`, `WEBHOOK_PARAM` (`/ops/awsops/slack-webhook-url`), `STATE_PARAM` (`/ops/awsops/health/watchdog-state`).
- Rules in `decide`: `stopping|stopped|shutting-down|terminated` ⇒ server `stopped`; only `running→stopped` and `stopped→running` emit (🛑 with actor when known, ▶️ with "09-start-all.sh 실행 필요"). While server is `stopped`, all other items are left unchanged and silent. Heartbeat fail when running AND `now - launch_epoch >= 900` AND (`heartbeat_age_sec is None or > 900`). Dashboard fail when targets is None or any value ≠ `healthy`. External ok iff `url_status == 302` and `amazoncognito.com` in `url_location`. Fail/recover emit once per transition. `api-call` events only record `actor` into state (`last_actor`) for the following state-change message; if the state-change already arrived, `api-call` emits nothing.
- Handler: gathers obs (boto3 `ec2.describe_instances`, `elbv2.describe_load_balancers`/`describe_target_groups`/`describe_target_health`, `cloudwatch.get_metric_data` on `AWSops/Health` `Heartbeat` last 20 min, `urllib.request` GET without following redirects, 10s timeout), reads/writes state JSON in SSM, posts each text to the webhook. Any AWS exception during gathering maps to the conservative obs value (e.g. targets=None), never raises.

- [ ] **Step 1: Write failing tests** (`unittest`, no AWS):
  - `test_stopping_then_stopped_alerts_once`
  - `test_stop_includes_actor_from_prior_api_call`
  - `test_running_after_stop_alerts_with_start_hint`
  - `test_quiet_while_stopped` (schedule run with failing targets while stopped → no texts)
  - `test_heartbeat_grace_period_after_launch`
  - `test_heartbeat_stale_alerts_once_then_recovers`
  - `test_missing_target_group_is_dashboard_fail`
  - `test_external_requires_302_to_cognito` (200 → fail, 302 to other host → fail)
- [ ] **Step 2:** `cd agent/lambda && python3 -m unittest test_health_watchdog -v` → FAIL.
- [ ] **Step 3:** Implement `decide` and `lambda_handler`.
- [ ] **Step 4:** Tests PASS; `python3 -m py_compile health_watchdog.py`.
- [ ] **Step 5:** Update `agent/lambda/CLAUDE.md`. Commit `feat(health): out-of-server watchdog Lambda`.

### Task 6: Setup script, IAM, CDK parity

**Files:**
- Create: `scripts/14-setup-health-alerts.sh`
- Modify: `infra-cdk/lib/awsops-stack.ts` (EC2 role statement), `CLAUDE.md` (deployment step list, both languages), `docs/runbooks/musinsa-deployment.md` is NOT touched (dev1-specific)

**Interfaces:**
- Consumes: Task 5 handler `health_watchdog.lambda_handler`, env var names; Global Constraints names.
- Creates (idempotent; create-or-update each):
  - IAM role `awsops-health-watchdog-role` (trust `lambda.amazonaws.com`), managed `AWSLambdaBasicExecutionRole`, inline `WatchdogAccess`: `ec2:DescribeInstances`, `elasticloadbalancing:Describe*`, `cloudwatch:GetMetricData` on `*`; `ssm:GetParameter` on `parameter/ops/awsops/slack-webhook-url` and `parameter/ops/awsops/health/watchdog-state`; `ssm:PutParameter` on `parameter/ops/awsops/health/watchdog-state`.
  - Lambda `awsops-health-watchdog` python3.12, handler `health_watchdog.lambda_handler`, timeout 30, memory 128, env vars from Task 5, reserved concurrency 1, tags as other awsops resources.
  - EventBridge rules (default bus) + targets + `lambda add-permission` (`events.amazonaws.com`): `awsops-health-5min` `rate(5 minutes)`; `awsops-ec2-state` pattern `{"source":["aws.ec2"],"detail-type":["EC2 Instance State-change Notification"],"detail":{"instance-id":["i-0806bafeb330307d5"],"state":["running","stopping","stopped","shutting-down","terminated"]}}`; `awsops-ec2-api-calls` pattern `{"source":["aws.ec2"],"detail-type":["AWS API Call via CloudTrail"],"detail":{"eventSource":["ec2.amazonaws.com"],"eventName":["StopInstances","StartInstances","TerminateInstances"]}}` (instance filtering happens in `decide`).
  - SSM: `/ops/awsops/slack-webhook-url` SecureString — prompt with `read -rsp` only if absent or `--reset-webhook` given; `/ops/awsops/health/watchdog-state` String `{}` if absent.
  - EC2 role inline `AWSopsHealthMonitor`: `lambda:InvokeFunction` on the 19 explicit function ARNs.
- Behaviour: prints a summary of what will be created/updated and asks `Proceed? (y/n)`; `--dry-run` prints only; ends by invoking the watchdog once and printing its result.
- CDK: add the same `lambda:InvokeFunction` statement (sid `HealthMonitorProbe`) to `ec2Role`; verify only with `cdk synth`, never deploy.

- [ ] **Step 1:** Write the script; `bash -n scripts/14-setup-health-alerts.sh`; `bash scripts/14-setup-health-alerts.sh --dry-run` → prints plan, makes no AWS changes (verify with `aws lambda get-function --function-name awsops-health-watchdog` still NotFound).
- [ ] **Step 2:** CDK edit; `cd infra-cdk && npx cdk synth AwsopsStack -c customDomain=awsops.moyeota.co.kr -c certificateArn=<p-e.kr cert arn> >/dev/null` succeeds.
- [ ] **Step 3:** Update root `CLAUDE.md` step list (Step 14). Commit `feat(health): setup script for watchdog, EventBridge, SSM and IAM`.

### Task 7: Deploy and verify on the real environment (operator + user)

Not delegated to a subagent: it needs the user's Slack webhook and admin shell.

- [ ] User creates the Slack Incoming Webhook; user runs `bash scripts/14-setup-health-alerts.sh` on the Mac and enters the webhook at the hidden prompt.
- [ ] Push branch; on EC2 `git pull && bash scripts/03-build-deploy.sh && bash scripts/09-start-all.sh`.
- [ ] Run spec §7 completion checks 1–7 and record results in the PR description.
