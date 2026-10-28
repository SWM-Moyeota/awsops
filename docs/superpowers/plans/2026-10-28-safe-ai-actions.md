# Safe AI Actions (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a Slack mention, an LLM drafts a typed ActionPlan. Deterministic code validates it, resolves targets, snapshots them, checks policy, previews the diff, dry-run checks permissions, takes two-person approval, executes with an ARN-scoped 15-minute session policy, writes a hash-chained audit log, and offers undo. This covers six reversible EC2/SG/tag actions.

**Architecture:** New module `src/lib/action-plan/`, built mostly from pure functions with injected AWS/Bedrock/Slack dependencies. `slack-control/requests.ts` is generalized so both features share one approval state machine. `handle.ts` orchestrates, and `slack-chatops/bot.ts` wires it in.

**Tech Stack:** Next.js 14, TypeScript, AWS SDK v3 (`client-ec2`, `client-sts`, `client-bedrock-runtime`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-safe-ai-actions-design.md`. Every implementer reads §2 (anti-goals), §3 (defaults) and §4 (constraints).

## Global Constraints

- The planner LLM receives **only** three things: the requester's current message (mentions stripped, ≤1000 chars), the fixed action catalog text, and the alias **names**. It never receives thread history, resource names or tags, SG descriptions, alias CIDRs, or logs.
- Targets are resolved by code. Candidates are only resources tagged `awsops:control=allow`. Instances in state `terminated` or `shutting-down` are excluded from candidates.
- Limits:
  - `maxSteps` defaults to 5 (counted after alias expansion).
  - `maxResources` defaults to 3.
  - `maxBlastRadius` defaults to 5 ENIs.
  - `undoHours` defaults to 24.
  - Request TTL, approvers and self-approval come from `config.slackControl`.
- Policy denial applies to the whole plan; a partial plan is never executed. "Already done" steps are dropped, not denied.
- Execution happens only after a re-snapshot equals the plan-time snapshot for every field a step touches. The session is assumed with `SourceIdentity=slack-<approver>`, `DurationSeconds: 900`, and an inline session policy containing exactly the plan's actions and ARNs. Steps run in order and execution stops at the first failure.
- Region `ap-northeast-2`. Host account only. Every AWS call is aborted after 15 s; the planner call after 30 s.
- Slack text built from names, tag values, descriptions or LLM `summary`/`question` goes through `safeName()` from `src/lib/slack-control/ec2.ts`. The 200-char prompt quote is escaped the same way.
- Errors shown or logged carry the error **name** only. Never log credentials or tokens.
- Audit: `data/action-plan/audit.jsonl` (override with `ACTION_PLAN_DATA_DIR`). It is append-only and hash-chained, as in §3.10, and an audit write failure never throws.
- Existing behaviour stays identical: slack-control on/off, change questions, cost questions, the AI fallback. All existing tests must pass.
- Copy is in plain Korean (해요체).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Verify with `npx vitest run`, `npx tsc --noEmit` and `npx next build`.

## Review Focus

1. **Injected text in a tag, Name or SG description reaching the planner.** The planner input must be built only from the message and the config. Test: Task 4 `plannerInputHasOnlyMessageCatalogAndAliasNames`.
2. **State drifts between preview and approval.** Example: someone adds the same tag value, or the server stops. Nothing may execute, and the card must say so. Test: Task 13 `driftBetweenPreviewAndApprovalBlocksExecution`.
3. **Undo after someone else changed the resource.** That step is skipped with a reason, never overwritten. Test: Task 11 `undoSkipsStepsWhoseStateChangedSince`.
4. **A how-to question** ("8080 포트 여는 방법 알려줘"). It must not be intercepted, and when `enabled:false` the planner must never be called. Tests: Task 2 `howToQuestionsAreNotIntents` and Task 13 `disabledRepliesWithoutCallingPlanner`.
5. **A second step failing after the first succeeded.** The first step stays recorded as done with its inverse, the second shows as failed, the rest as not-run, and undo offers only the first. Test: Task 8 `stopsAtFirstFailureAndKeepsInverseOfDoneSteps`.

---

### Task 0 (controller): contract types and config

**Files:**
- Create: `src/lib/action-plan/types.ts`
- Create: `src/lib/action-plan/config.ts`
- Modify: `src/lib/app-config.ts` (add `actionPlan?` next to `slackControl?`)
- Modify: `src/lib/slack-control/types.ts` (split out `ApprovalRecord`)

```ts
// src/lib/slack-control/types.ts — ControlRequest keeps every field it has today.
export interface ApprovalRecord {
  id: string; requesterId: string; channel: string; threadTs: string; cardTs?: string;
  status: RequestStatus; createdAt: number; confirmedAt?: number; deciderId?: string; decidedAt?: number; result?: string;
}
export interface ControlRequest extends ApprovalRecord { action: ControlAction; instance: ControllableInstance }

// src/lib/action-plan/types.ts
export type ActionKind = 'ec2.start' | 'ec2.stop' | 'tag.set' | 'tag.remove' | 'sg.ingress.add' | 'sg.ingress.remove';
export type ResourceType = 'instance' | 'security-group';
export interface IngressRule { protocol: 'tcp' | 'udp'; fromPort: number; toPort: number; source: string; description?: string } // source: IPv4/IPv6 CIDR or sg-…
export interface PlannedStep { action: ActionKind; ref: string; key?: string; value?: string; rule?: IngressRule }
/** Validated planner output; alias sources are already expanded to CIDRs. */
export type PlannerOutput =
  | { kind: 'plan'; steps: PlannedStep[]; summary: string }
  | { kind: 'clarify'; question: string }
  | { kind: 'not-action' };
export interface Resource {
  type: ResourceType; id: string; name: string; groupName?: string; tags: Record<string, string>;
  state?: string; securityGroupIds?: string[];   // instance only
}
export interface TargetRef { type: ResourceType; id: string; name: string }
export interface ResolvedStep { action: ActionKind; target: TargetRef; key?: string; value?: string; rule?: IngressRule; ruleId?: string }
export interface SnapshotRule extends IngressRule { ruleId: string }
export interface ResourceSnapshot {
  type: ResourceType; id: string; name: string; tags: Record<string, string>;
  state?: string;                                  // instance
  ingress?: SnapshotRule[];                        // security group
  eniCount?: number; attachedInstances?: Array<{ id: string; name: string }>; // security group
}
export type Snapshot = Record<string, ResourceSnapshot>; // by resource id
/** What must be true right after a step ran — used by undo's overwrite guard. */
export type AfterCheck =
  | { kind: 'instance-state'; id: string; states: string[] }
  | { kind: 'tag'; id: string; key: string; value: string | null }
  | { kind: 'rule-present'; sgId: string; ruleId: string }
  | { kind: 'rule-absent'; sgId: string; rule: IngressRule };
export interface StepChange {
  index: number; step: ResolvedStep; before: string; after: string; noop: boolean;
  inverse?: ResolvedStep;   // known before execution (tag.set/remove, ec2.*, sg.ingress.remove); sg.ingress.add gets it from the result
}
export interface StepResult {
  index: number; status: 'done' | 'failed' | 'not-run'; requestId?: string; error?: string;
  inverse?: ResolvedStep; after?: AfterCheck;
}
export interface PolicyResult { ok: boolean; denials: string[] }
export interface ActionRequest extends ApprovalRecord {
  prompt: string; summary: string; plannerRaw: unknown;
  changes: StepChange[];          // includes noop entries (shown as "이미 되어 있음")
  snapshot: Snapshot;             // plan-time
  policy: PolicyResult; permission: { ok: boolean; error?: string };
  undoOf?: string; skippedForDrift?: string[]; results?: StepResult[];
}
export interface ExecutionRecord {
  id: string; executedAt: string; requesterId: string; approverId: string; channel: string; threadTs: string;
  results: StepResult[]; undoOf?: string;
}
export interface ActionPlanConfig {
  approval: ControlConfig; maxSteps: number; maxResources: number; maxBlastRadius: number; undoHours: number;
  sourceAliases: Record<string, string[]>;
}
/** AWS read side (real impl in aws.ts, fakes in tests). */
export interface Ec2Reader {
  listTaggedInstances(): Promise<Resource[]>;
  listTaggedSecurityGroups(): Promise<Resource[]>;
  describeInstance(id: string): Promise<Resource | null>;
  describeSecurityGroup(id: string): Promise<Resource | null>;
  listIngressRules(sgId: string): Promise<SnapshotRule[]>;
  listEniUsers(sgId: string): Promise<{ eniCount: number; instances: Array<{ id: string; name: string }> }>;
}
/** One assumed, session-policy-scoped session. dryRun resolves on DryRunOperation, rejects otherwise. */
export interface Ec2Writer { run(step: ResolvedStep, dryRun: boolean): Promise<{ requestId?: string; ruleId?: string }> }
export type WriterFactory = (sessionLabel: string, sessionPolicy: object) => Promise<Ec2Writer>;
```

`config.ts` exports `getActionPlanConfig(): ActionPlanConfig | null`. It returns null unless `config.actionPlan?.enabled === true` **and** `getControlConfig()` is non-null. It applies the defaults above and normalizes `sourceAliases` to `{}`. It also exports `isActionPlanEnabled(): boolean`.

- [ ] Write the files, run `npx tsc --noEmit` (clean), and commit `feat(action-plan): contract types and config`.

---

### Task 1: Generalize the approval store

**Files:** Modify `src/lib/slack-control/requests.ts`. Test `src/lib/slack-control/__tests__/requests.test.ts` (existing, unchanged) plus a new `approval-store.test.ts` next to it.

**Interfaces:** Produces `createApprovalStore<R extends ApprovalRecord>(opts?: { now?: () => number }): ApprovalStore<R>`, where `create(input: Omit<R, keyof ApprovalRecord> & Pick<ApprovalRecord, 'requesterId' | 'channel' | 'threadTs'>): R`. The methods `get`, `setCardTs`, `confirm`, `beginApproval`, `finish`, `reject` and `cancel` keep today's signatures and messages. `RequestStore = ApprovalStore<ControlRequest>` and `createRequestStore()` remain exported.

- [ ] Test `genericStoreRunsSameTwoStepRulesOnCustomPayload`: with `R = ApprovalRecord & { prompt: string }`:
  - `create` keeps `prompt`;
  - the requester's `beginApproval` fails with "요청한 본인은 최종 승인할 수 없어요" before confirm and after confirm;
  - a different approver succeeds once, and a second `beginApproval` fails.
- [ ] Run it and confirm it fails. Implement. Run the whole `src/lib/slack-control` suite and confirm everything passes. Commit.

### Task 2: Intent detection

**Files:** Create `src/lib/action-plan/detect.ts` and test `src/lib/action-plan/__tests__/detect.test.ts`.

**Interfaces:** Produces `detectActionIntent(text: string): boolean`. Mentions `<@…>` are stripped first.

- [ ] Test `detectsImperativeActionsOnTagsAndSecurityGroups`. Each of these is true:
  - `web-dev에 owner=jiwoo 태그 붙여줘`
  - `sg-0abc 8080 포트 열어줘`
  - `api 서버 인바운드 규칙 삭제해 주세요`
  - `web-dev 태그 env 지워줘`
  - `web-dev 끄고 owner 태그 달아줘`
- [ ] Test `howToQuestionsAreNotIntents`. Each of these is false:
  - `8080 포트 여는 방법 알려줘`
  - `태그 어떻게 붙여?`
  - `보안그룹 규칙 추가할 수 있어?`
  - `포트 열면 돼?`
  - `web-dev 꺼줘` (no tag/SG/port word, so it stays with slack-control)
  - `지금 열린 포트 뭐 있어?`
- [ ] Implement, confirm the tests pass, and commit.

### Task 3: Planner-output validation and alias expansion

**Files:** Create `src/lib/action-plan/validate.ts` and test `__tests__/validate.test.ts`.

**Interfaces:** Produces `validatePlannerOutput(raw: unknown, opts: { aliases: Record<string, string[]>; maxSteps: number }): { ok: true; value: PlannerOutput } | { ok: false; error: string }`.

The raw shape is the `submit_plan` tool input:

```
{ kind, steps?: [{ action, ref, key?, value?, protocol?, fromPort?, toPort?, source?, description? }], summary?, question? }
```

For `sg.*` steps, build `rule` from the flat fields. A `source` of `alias:<name>` expands to one step per CIDR. Unknown aliases are an error, with a message naming the alias.

- [ ] Test `rejectsUnknownActionsFieldsAndBadValues`. Each of these makes the whole result `ok:false`:
  - an unknown action
  - an extra unknown field on a step
  - port 70000
  - from > to
  - CIDR `10.0.0.0/33`
  - `aws:foo` as a tag key
  - a key of 129 chars
  - a value of 257 chars
  - protocol `-1`
- [ ] Test `expandsAliasToOneStepPerCidrAndCountsTowardMaxSteps`: alias `사무실 → [a/32, b/32]` becomes 2 steps; 3 aliased steps against `maxSteps` 5 give `ok:false`.
- [ ] Test `acceptsClarifyAndNotAction`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 4: Planner

**Files:** Create `src/lib/action-plan/planner.ts` and test `__tests__/planner.test.ts`.

**Interfaces:**
- `buildPlannerRequest(message: string, aliasNames: string[]): { system: string; messages: [{ role: 'user'; content: string }]; tools: object[]; tool_choice: { type: 'tool'; name: 'submit_plan' } }`.
- `callPlanner(message: string, aliasNames: string[], invoke: (body: object) => Promise<unknown>): Promise<unknown>` returns the `input` of the first `tool_use` block, or throws `PlannerError`.
- `bedrockInvoke(body)` is the real `InvokeModelCommand` call. It uses `bedrockClient` from `src/lib/ai/clients`, `getBedrockModelId()`, `anthropic_version: 'bedrock-2023-05-31'`, `max_tokens` 1024, and a 30 s abort.

The system prompt is fixed Korean/English text. It describes the six actions and their params, says `ref` must copy the user's words verbatim, and says to return `clarify` when unsure and `not-action` for questions.

- [ ] Test `plannerInputHasOnlyMessageCatalogAndAliasNames`:
  - the JSON-serialized request contains the message, the alias names and the 6 action ids;
  - for the alias `사무실 → 203.0.113.0/24`, the string `203.0.113` does not appear;
  - the message is truncated to 1000 chars;
  - `<@U123>` is stripped.
- [ ] Test `returnsToolInputAndThrowsOnTextOnlyReply`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 5: Target resolution

**Files:** Create `src/lib/action-plan/resolve.ts` and test `__tests__/resolve.test.ts`.

**Interfaces:** Produces `resolveSteps(steps: PlannedStep[], c: { instances: Resource[]; groups: Resource[] }, maxResources: number): { kind: 'ok'; steps: ResolvedStep[] } | { kind: 'not-found' | 'ambiguous'; ref: string; candidates: TargetRef[] } | { kind: 'too-many-resources'; count: number }`.

Matching:
- An `i-`/`sg-` ref matches by exact ID.
- Otherwise the ref matches by whole token, case-insensitive, against `name` (and `groupName` for groups), the same as `mentionsName` in `slack-control/parse.ts`.
- `ec2.*` steps search instances, `sg.*` steps search groups, and `tag.*` steps search both.
- For an `sg.*` step whose ref matches exactly one instance:
  - if that instance's `securityGroupIds` contains exactly one ID present in `groups`, use that group;
  - otherwise return `ambiguous`, with the instance's groups as candidates.

- [ ] Test `resolvesByIdAndWholeTokenName`: `api-dev` does not match `api-dev-2`.
- [ ] Test `sgStepOnInstanceUsesItsOnlyTaggedGroupElseAmbiguous`.
- [ ] Test `untaggedResourcesAreNeverCandidates`: the inputs are already tagged-only, and a ref naming something outside them gives `not-found` with the candidate list.
- [ ] Test `moreThanMaxResourcesIsRejected`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 6: Snapshot and change computation

**Files:** Create `src/lib/action-plan/snapshot.ts` and `src/lib/action-plan/changes.ts`. Tests `__tests__/snapshot.test.ts` and `__tests__/changes.test.ts`.

**Interfaces:**
- `takeSnapshot(steps: ResolvedStep[], r: Ec2Reader): Promise<Snapshot>`. It reads each target once. Groups get `ingress` plus `eniCount`/`attachedInstances`. A target that is missing or untagged makes it throw `SnapshotError` with the ID.
- `computeChanges(steps: ResolvedStep[], s: Snapshot): { changes: StepChange[]; errors: string[] }`. `before`/`after` are short Korean strings, for example `태그 owner: (없음) → jiwoo` and `인바운드 tcp 8080 ← 203.0.113.0/24 추가`. Steps are evaluated in order, so a second step sees the result of the first.

Noops:
- `ec2.stop` when the instance is already `stopped`
- `ec2.start` when it is already `running`
- `tag.set` to the same value
- `tag.remove` of an absent key
- an `add` for a rule that already exists (same protocol, ports and source)
- a `remove` for a rule that is absent; this is **not** a noop and goes into `errors` as `그런 규칙이 없어요`

For `remove`, set `step.ruleId` from the snapshot.

Inverses:
- stop ↔ start
- `tag.set` of a new key → `tag.remove`
- `tag.set` over an old value → `tag.set` back to the old value
- `tag.remove` → `tag.set` with the old value
- `sg.ingress.remove` → `sg.ingress.add` of the snapshot rule, including its description
- `sg.ingress.add` → none until execution

Also export `afterCheckFor(step: ResolvedStep, ruleIdFromResult?: string): AfterCheck`:
- stop → states `['stopping', 'stopped']`
- start → `['pending', 'running']`

- [ ] Test `noopsAreMarkedNotErrors`.
- [ ] Test `inversesAreComputedFromSnapshotValues`.
- [ ] Test `secondStepSeesFirstStepsResult`: set `owner=a`, then set `owner=b` → the second step's before is `a`.
- [ ] Test `removeOfMissingRuleIsError`.
- [ ] Test `snapshotThrowsWhenTargetLostItsTag`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 7: Policy

**Files:** Create `src/lib/action-plan/policy.ts` and test `__tests__/policy.test.ts`.

**Interfaces:** Produces `evaluatePolicy(changes: StepChange[], s: Snapshot, cfg: Pick<ActionPlanConfig, 'maxBlastRadius'>): PolicyResult`. It applies spec §3.5 rules 1–7 to the non-noop changes and collects every denial as a Korean sentence naming the resource.

- [ ] Test `deniesEachRule`, with one case per rule:
  1. missing tag
  2. `Environment=Production` (case-insensitive key and value)
  3. key `awsops:control`, for both set and remove
  4. `0.0.0.0/0` on 22, while 443 is allowed and `::/0` on 80 is allowed
  5. a port span over 1000
  6. `eniCount` 6 with max 5
  7. start on `stopping`, stop on `pending`, any action on `shutting-down`
- [ ] Test `collectsAllDenialsAndIgnoresNoops`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 8: Session policy, drift check and executor

**Files:** Create `src/lib/action-plan/session-policy.ts` and `src/lib/action-plan/execute.ts`. Tests `__tests__/session-policy.test.ts` and `__tests__/execute.test.ts`.

**Interfaces:**
- `buildSessionPolicy(steps: ResolvedStep[], account: string, region: string): object`. It returns IAM JSON with one statement per action. The ARNs are `arn:aws:ec2:{region}:{account}:instance/{id}` or `…:security-group/{id}`, plus `…:security-group-rule/*` for Authorize/Revoke ingress if the AWS service authorization reference requires it (check and cite in a comment).
  - Mapping: `ec2.start` → `ec2:StartInstances`, `ec2.stop` → `ec2:StopInstances`, `tag.set` → `ec2:CreateTags`, `tag.remove` → `ec2:DeleteTags`, `sg.ingress.add` → `ec2:AuthorizeSecurityGroupIngress`, `sg.ingress.remove` → `ec2:RevokeSecurityGroupIngress`.
  - The result must stay under 2048 chars packed (the session-policy limit); throw if not.
- `findDrift(changes: StepChange[], planSnap: Snapshot, fresh: Snapshot): string[]`. It returns one Korean reason per non-noop step whose touched field differs: instance state, the specific tag key's value, or the presence of the specific rule.
- `executeChanges(changes: StepChange[], writer: Ec2Writer): Promise<StepResult[]>`. Noops are skipped (no result). Steps run in order. A failure makes that step `failed` with the error name and every later step `not-run`. A done step gets `requestId`, `inverse` (for add: `sg.ingress.remove` with the returned `ruleId`) and `after = afterCheckFor(...)`.
- `dryRunAll(changes, writer): Promise<{ ok: boolean; error?: string }>`.

- [ ] Test `sessionPolicyListsExactlyThePlansActionsAndArns`: no `*` in Resource except the documented `security-group-rule/*`, and no action outside the 6.
- [ ] Test `driftDetectsTagValueStateAndRuleChanges`.
- [ ] Test `stopsAtFirstFailureAndKeepsInverseOfDoneSteps`.
- [ ] Test `dryRunReportsUnauthorizedByName`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 9: Real AWS reader and writer

**Files:** Create `src/lib/action-plan/aws.ts` and test `__tests__/aws.test.ts`. The tests inject a fake `send`; no network.

**Interfaces:**
- `createEc2Reader(send?): Ec2Reader`, using DescribeInstances, DescribeSecurityGroups, DescribeSecurityGroupRules (filter `group-id`, ingress only, i.e. `IsEgress=false`) and DescribeNetworkInterfaces (filter `group-id`).
  - Only `tcp`/`udp` rules with a single CIDR or a referenced group map to `SnapshotRule`. Other rules are kept with protocol as-is so that existence checks still work; make `SnapshotRule.protocol` widen to `string` locally via a cast and note it.
  - Names go through `safeName`.
- `createWriterFactory(): WriterFactory`. It does AssumeRole on `AWSopsActionExecutorRole` with the session name and SourceIdentity set to the label, `DurationSeconds: 900`, and `Policy: JSON.stringify(sessionPolicy)`. The account comes from STS GetCallerIdentity (cached).
- The writer's `run` maps each action to its command with `DryRun`:
  - `DryRunOperation` → resolve `{}`
  - Authorize → return `SecurityGroupRules[0].SecurityGroupRuleId` as `ruleId`
  - Revoke → use `SecurityGroupRuleIds: [ruleId]`
  - `requestId` comes from `$metadata.requestId`
- `sessionLabel` is reused from `slack-control/ec2.ts`.
- Every call is aborted after 15 s.

- [ ] Test `writerTreatsDryRunOperationAsSuccess`.
- [ ] Test `authorizeReturnsRuleIdAndRevokeUsesIt`.
- [ ] Test `assumeRolePassesSessionPolicySourceIdentityAnd900s`.
- [ ] Test `readerKeepsOnlyTaggedNonTerminatedInstances`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 10: Hash-chained audit log and execution store

**Files:** Create `src/lib/action-plan/audit.ts` and `src/lib/action-plan/executions.ts`. Tests `__tests__/audit.test.ts` and `__tests__/executions.test.ts`, using a tmp dir via `ACTION_PLAN_DATA_DIR`.

**Interfaces:**
- `appendActionAudit(entry: Record<string, unknown>, at?: Date): void`. It never throws. It reads the last line's hash, or `"0"` if none. `hash = sha256(prevHash + canonicalJson(entryWithAtAndPrevHash))`, where `canonicalJson` sorts keys recursively. It writes `{...entry, at, prevHash, hash}`. Appends are serialized in-process.
- `verifyAuditChain(file?: string): { ok: true; lines: number } | { ok: false; brokenAt: number }`. Line numbers are 1-based.
- `auditEntryFor(req: ActionRequest): Record<string, unknown>`. It holds the fields of spec §3.10, with the prompt capped at 1000 chars, and never includes credentials.
- `saveExecution(rec: ExecutionRecord): void` and `loadExecution(id: string): ExecutionRecord | null`, stored as `executions/<id>.json`. Writes are atomic (tmp + rename). The id is validated as UUID before it is used in a path.

- [ ] Test `chainVerifiesAndDetectsEditedDeletedOrReorderedLines`.
- [ ] Test `auditNeverThrowsOnUnwritableDir`.
- [ ] Test `executionRoundTripsAndRejectsPathTraversalIds`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 11: Undo planning

**Files:** Create `src/lib/action-plan/undo.ts` and test `__tests__/undo.test.ts`.

**Interfaces:**
- `undoSteps(rec: ExecutionRecord): ResolvedStep[]`. It returns the inverses of done steps in **reverse** order.
- `checkUndo(rec: ExecutionRecord, fresh: Snapshot): { steps: ResolvedStep[]; skipped: string[] }`. A done step whose `after` check fails against `fresh` is skipped with a reason: "그 사이 다른 변경이 있어서 되돌리지 않아요: …". Inverses are re-paired with their checks by `index`.
- `isUndoAvailable(rec: ExecutionRecord, undoHours: number, now?: Date): boolean`.

- [ ] Test `undoReversesOrderAndUsesInverses`.
- [ ] Test `undoSkipsStepsWhoseStateChangedSince`, with one case each for tag, state and rule.
- [ ] Test `undoExpiresAfterUndoHours`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 12: Slack cards

**Files:** Create `src/lib/action-plan/cards.ts` and test `__tests__/cards.test.ts`.

**Interfaces:**
- `AP_PREFIX = 'awsops_ap_'` and `AP = { confirm, cancel, approve, reject, undo }`, each with the `awsops_ap_` prefix.
- `actionCard(req: ActionRequest, cfg: ActionPlanConfig): { text: string; blocks: unknown[] }`. The button value is the request id. The undo button value is the execution id; it is shown only for `executed`/`failed` cards that have ≥1 done step with an inverse.

Content follows spec §3.6:
- quote, steps before → after, the "이미 되어 있음" list, blast radius, policy, permission, "되돌릴 수 있어요(24시간 안)"
- step 1 and 2 buttons as in `slack-control/cards.ts`, with the final approve behind a confirm dialog
- the result section per step: ✅ done / ⚠️ failed (error name) / ⏸ not-run
- the drift-skipped list for undo requests

Requests denied by policy or permission are rendered without buttons.

- [ ] Test `cardShowsDiffBlastAndButtonsPerStatus`.
- [ ] Test `deniedCardHasNoButtons`.
- [ ] Test `namesAndSummaryAreSanitized`: a name of ``*evil*`<@U1>`` renders without `*`, `` ` ``, `<` or `>`.
- [ ] Test `undoButtonOnlyWhenSomethingCanBeUndone`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 13: Orchestrator

**Files:** Create `src/lib/action-plan/handle.ts` and test `__tests__/handle.test.ts`.

**Interfaces:**
- `ActionDeps`:

  ```ts
  { slack: ControlSlackApi; store: ApprovalStore<ActionRequest>; config: () => ActionPlanConfig | null;
    enabled: () => boolean; planner: (message: string, aliasNames: string[]) => Promise<unknown>;
    reader: Ec2Reader; writers: WriterFactory; account: () => Promise<string>;
    audit: (req: ActionRequest) => void; executions: { save(r: ExecutionRecord): void; load(id: string): ExecutionRecord | null };
    teamId?: string; now?: () => Date }
  ```
- `maybeHandleActionMention(event, deps): Promise<boolean>`.
- `handleActionClick(payload: ControlClick, deps): Promise<void>`.

Mention flow (spec §3.1–§3.7):
1. If `!detectActionIntent`, return false.
2. If `!enabled()`, reply "AI 실행 기능이 꺼져 있어요" and return true. If `config()` is null, reply with `CONTROL_DISABLED_TEXT` and return true.
3. Run the planner, then validate. `not-action` returns false so the request falls through to the next handler. `clarify` replies with the question plus "처음부터 한 문장으로 다시 써 주세요".
4. List the tagged candidates and resolve. On not-found or ambiguous, reply with the candidates.
5. Take the snapshot and compute the changes. On errors, reply. If every step is a noop, reply "바꿀 게 없어요".
6. Run the policy check and the dry-run. The dry-run uses the writer from `writers(sessionLabel(requester), buildSessionPolicy(nonNoopSteps, account, 'ap-northeast-2'))`. It is skipped when policy already denied.
7. Create the request, post the card, store the card ts and write the audit entry.

Clicks:
- confirm, cancel and reject behave as in `slack-control/handle.ts`.
- approve:
  1. `beginApproval`.
  2. Fresh snapshot, then `findDrift`. Drift → `failed`, with the reasons.
  3. Otherwise get a writer for `sessionLabel(approver)`, run `executeChanges`, then `finish('executed' or 'failed')`, set `req.results`, and `saveExecution`.
  4. Redraw and audit.
- undo:
  1. `loadExecution` and check `isUndoAvailable`.
  2. Fresh snapshot of the inverse targets, then `checkUndo`.
  3. If nothing is left, send an ephemeral notice. Otherwise build a new request with `undoOf` and `skippedForDrift`, with the clicker as requester, running steps 5–7 of the mention flow. Undo steps skip `detect`, `planner` and `resolve`.

- [ ] Test `disabledRepliesWithoutCallingPlanner`.
- [ ] Test `notActionFallsThrough`.
- [ ] Test `happyPathPlansPreviewsApprovesAndExecutes`: the fake reader and writer record calls; the writer is built with the approver label and with a session policy whose ARNs are exactly the targets.
- [ ] Test `policyDeniedCardHasNoButtonsAndNoDryRun`.
- [ ] Test `driftBetweenPreviewAndApprovalBlocksExecution`.
- [ ] Test `requesterCannotFinalApprove`.
- [ ] Test `undoCreatesNewRequestThroughSamePipeline`.
- [ ] Test `plannerFailureRepliesAndDoesNotFallThrough`.
- [ ] Implement, confirm the tests pass, and commit.

### Task 14: Wiring, IAM script, ADR and docs

**Files:**
- Modify:
  - `src/lib/slack-chatops/handle.ts`: add the `tryActionPlan` dep and call it after `tryControl`, before `tryChangeQuestion`
  - `src/lib/slack-chatops/bot.ts`: build `ActionDeps` with the real reader/writers/planner/audit/executions and route `awsops_ap_*` interactive payloads to `handleActionClick` without dedupe, as with control
  - `src/lib/slack-control/handle.ts`: `maybeHandleControlMention` returns false when `isActionPlanEnabled() && detectActionIntent(text)`; pass this as an optional `skip?: (text) => boolean` dep and set it in bot.ts
- Create:
  - `scripts/17-setup-action-executor.sh`, modeled on script 16:
    - role `AWSopsActionExecutorRole`
    - trust `awsops-ec2-role` with SourceIdentity `slack-*`
    - args `i-…`/`sg-…` validated by regex
    - allow the 6 actions on the listed ARNs with `aws:ResourceTag/awsops:control=allow`, plus `security-group-rule/*` if Task 8 found it required
    - an explicit Deny on Create/DeleteTags where `ForAnyValue:StringLike aws:TagKeys = awsops:*`
    - an assume policy on the EC2 role
    - no IDs removes the permissions
  - `docs/decisions/011-ai-planned-deterministic-execution.md`, covering spec §3.14
  - `src/lib/action-plan/CLAUDE.md`, in Korean followed by English, the same format as `slack-control/CLAUDE.md`
- Modify docs:
  - root `CLAUDE.md`: ADR count 11, key-files bullet, step 17 line in both languages
  - `src/lib/slack-control/CLAUDE.md`: shared store and skip rule
  - `src/lib/slack-chatops/CLAUDE.md`: routing order
  - `docs/runbooks/slack-chatops.md`: an "AI 실행" section on how to turn it on

Tests:
- [ ] Test `actionPlanRunsAfterControlBeforeChange` in `src/lib/slack-chatops/__tests__/handle.test.ts`, in the style of `costQuestionSkipsAi`: the order is `['control', 'action', ...]`.
- [ ] Test `controlSkipsWhenSkipReturnsTrue` in `src/lib/slack-control/__tests__/handle.test.ts`.
- [ ] Run `bash -n scripts/17-setup-action-executor.sh`.

Finish:
- [ ] Run the full `npx vitest run`, `npx tsc --noEmit` and `npx next build`. Commit.
