# 장애 원인 분석 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On an anomaly (or on request), rank the previous 60 minutes of CloudTrail write events by time × dependency-graph distance × change kind, have Bedrock explain the top suspects with verified event-ID citations, and show it on `/root-cause` and in Slack.

**Architecture:** Pure TS pipeline in `src/lib/root-cause/` (events → refs → merged graph history → BFS distance → score). Thin adapters for CloudTrail `LookupEvents`, CloudWatch `GetMetricData`/`DescribeAlarms` and Bedrock `invokeText`, all injectable. A 5-minute production loop detects signals, groups them into incidents (JSON store), and runs analyses through one serial queue. The dep-graph build gains a 12-file snapshot history.

**Tech Stack:** Next.js 14 App Router, TypeScript, vitest, `@aws-sdk/client-cloudtrail`/`client-cloudwatch` (already deps), Recharts, Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-29-root-cause-design.md` (Korean; binding authority — read the sections a task names).

## Global Constraints
- Read-only toward AWS: only `LookupEvents`, `GetMetricData`, `DescribeAlarms`, Bedrock `InvokeModel`. No other AWS API.
- Every CloudTrail call: `await accountCredentials(accountId, 'awsops-root-cause')` then `await cloudTrailSlot(accountId, region)` (from `src/lib/cloudtrail-access.ts`), new client per call, `LookupAttributes: [{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }]`, `MaxResults: 50`, max 10 pages per region.
- Logs: error **names** only (`e instanceof Error ? e.name : 'Error'`); never log event bodies, IPs, credentials. Prefix `[root-cause]`.
- No `sourceIPAddress`, raw `userAgent`, access key IDs, or secret-like params (key matches `/password|secret|token|credential|privatekey/i` → value `"[숨김]"`) in bundles or stored params.
- Comments: bilingual one-liners (English then Korean) like `src/lib/dep-graph/*`. Components `export default`. `fetch('/api/...')` only.
- Loops/timers run only when `process.env.NODE_ENV === 'production'`, `globalThis` singletons, timers `.unref()`.
- i18n: every new key in `ko.json`, `en.json`, `zh.json` under `rootCause.*` (+ `sidebar.rootCause`).
- Numbers from the spec are exact: window `[start−60m, start+5m]`; time `exp(−Δ/20)`, after-start 0.3; graph weights 1.0/0.85/0.65/0.45/0.3, unconnected 0.08, not-in-graph 0.12, no-target 0.5; BFS ≤4, no pass-through `vpc`/`subnet`/degree>15; top 8 in bundle, params 600 chars, bundle 24,000 chars; `maxTokens: 1200`; incidents keep 200, suspects ≤50; group within 60 min / 2 hops; resolve after 30 min quiet; manual rate limit 30 s; manual `at` within 7 days; graph history keep 12.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. Event whose resource was removed from the graph after the change (SG swapped off an ENI) — distance must come from the pre-change snapshot via the merged graph (Task 3 + eval scenarios).
2. Same id in two accounts (e.g. default SG names, lambda names) — ref resolution must stay inside the incident's account (Task 3 test).
3. One broken SG firing `alb-5xx`, `tg-unhealthy`, `ec2-status` together — one incident, one analysis, one Slack post (Task 7 test).
4. AI answer citing an eventId not in the bundle, or non-JSON text — causes dropped / status `unverified`/`failed`, ranking still shown (Task 5 test).
5. CloudTrail returning >500 events, or one region failing — `truncated: true` / partial result with the other region's events, never a thrown analysis (Task 7 test).

---

### Task 1: Types and evaluation scenarios (written before any scoring code)

**Files:**
- Create: `src/lib/root-cause/types.ts`, `src/lib/root-cause/eval/scenarios.ts`, `src/lib/root-cause/__tests__/scenarios.test.ts`

**Interfaces — Produces (`types.ts`, verbatim):**
```ts
import type { GraphData, NodeType } from '@/lib/dep-graph/types';
import type { Actor, ToolId } from '@/lib/change-timeline/types';
export type SignalKind = 'alb-5xx' | 'tg-unhealthy' | 'ec2-status' | 'alarm';
export interface Signal { kind: SignalKind; accountId: string; region: string; resourceArn: string | null; alarmArn?: string; alarmName?: string; startedAt: string; detail: string; recent?: number; baseline?: number }
export interface ResourceRef { type: NodeType | null; id?: string; arn?: string }
export interface WriteEvent { eventId: string; eventName: string; eventSource: string; time: string; accountId: string; region: string; actor: Actor; tool: ToolId; refs: ResourceRef[]; params: string }
export interface GraphSnapshot { builtAt: string; data: GraphData }
export interface MergedGraph { data: GraphData; from: string | null; to: string | null; count: number }
export type Distance = number | 'unconnected' | 'not-in-graph' | 'no-target';
export interface Proximity { distance: Distance; path: string[]; matchedArn: string | null }
export interface Suspect { event: WriteEvent; proximity: Proximity; weights: { time: number; graph: number; kind: number }; score: number; rank: number }
export interface AiCause { eventId: string; reason: string; confidence: 'high' | 'medium' | 'low' }
export interface AiResult { status: 'ok' | 'unverified' | 'failed' | 'skipped'; summary?: string; causes?: AiCause[]; checks?: string[]; droppedCitations: number }
export interface Analysis { analyzedAt: string; windowFrom: string; windowTo: string; graph: { from: string | null; to: string | null; count: number }; eventsSeen: number; truncated: boolean; failedRegions: string[]; suspects: Suspect[]; ai: AiResult }
export interface Incident { id: string; key: string; accountId: string; region: string; resourceArn: string | null; resourceName: string | null; signals: Signal[]; startedAt: string; firstSeenAt: string; lastSeenAt: string; status: 'open' | 'resolved'; source: 'auto' | 'manual'; analysis?: Analysis; notifiedAt?: string }
export interface Scenario { id: string; title: string; category: string; knownLimit?: boolean; accountId: string; region: string; targetArn: string | null; startedAt: string; graphs: GraphSnapshot[]; events: Record<string, unknown>[]; answer: string }
```

- [ ] **Step 1: Write `eval/scenarios.ts` exporting `SCENARIOS: Scenario[]`** — at least 24, written from an operator's point of view **without** computing scores (the scoring code does not exist yet; do not read spec §2 "점수"). `events` are parsed CloudTrail JSON objects in the real shape (`eventID`, `eventTime`, `eventName`, `eventSource`, `awsRegion`, `readOnly:false`, `userIdentity`, `userAgent`, `requestParameters`, `responseElements`, optional `errorCode`, optional `resources:[{ARN,type}]`). Graphs are small realistic `GraphData` (ALB → TG → instances → ENI → SG → subnet → VPC, lambda → role, rds → sg, etc.) using real ARN formats and edge directions from `src/lib/dep-graph/types.ts` (`src` uses `dst`). Required mix (≥2 each): SG inbound revoke (`RevokeSecurityGroupIngress`), TG deregister (`DeregisterTargets`), instance stop (`StopInstances`), listener/rule change (`ModifyListener`/`ModifyRule`), Lambda config (`UpdateFunctionConfiguration`), IAM detach (`DetachRolePolicy`, region `us-east-1`), RDS modify (`ModifyDBInstance`), SG swapped on an ENI (`ModifyNetworkInterfaceAttribute`, two graph snapshots: before has the edge, after does not), noise-heavy (30+ `UpdateInstanceInformation`/`CreateLogStream` around the answer). Every scenario carries ≥3 distractors chosen from: an unrelated change closer in time, a change in the same VPC on an unrelated resource, a tag change on the target, a failed call (`errorCode`) on the target, noise events. Add ≥2 `knownLimit: true` scenarios whose real cause is outside the 15 node types (e.g. `ReplaceRoute`, `ReplaceNetworkAclEntry`). Times: answer 2–40 min before `startedAt`.
- [ ] **Step 2: Write `__tests__/scenarios.test.ts`**: ≥24 scenarios; ids unique; each `answer` equals exactly one event's `eventID`; the answer event has no `errorCode`; every edge's `src`/`dst` exists in that snapshot's nodes; every graph node `accountId === scenario.accountId` except deliberate cross-account distractors; ≥2 `knownLimit`; each required category appears ≥2 times.
- [ ] **Step 3:** `npx vitest run src/lib/root-cause` → PASS. `npx tsc --noEmit` → clean.
- [ ] **Step 4: Commit** `feat(root-cause): shared types and evaluation scenarios`.

### Task 2: Write-event parsing

**Files:** Create `src/lib/root-cause/events.ts`, `src/lib/root-cause/__tests__/events.test.ts`

**Interfaces:**
- Consumes: `classifyActor(userIdentity)`, `detectTool(userAgent, invokedBy)` from `src/lib/change-timeline/parse.ts`.
- Produces: `NOISE_EVENTS: ReadonlySet<string>` (spec §2 "변경 이벤트 가져오기" list, verbatim); `toWriteEvent(raw: unknown, accountId: string): WriteEvent | null`; `extractRefs(raw: Record<string, unknown>): ResourceRef[]`; `sanitizeParams(req: unknown): string`.

- [ ] **Step 1: Tests** —
  - `toWriteEvent` returns null for: noise names, `errorCode` present, `readOnly: true`, missing `eventID`/`eventTime`, non-object.
  - Maps `eventID→eventId`, `eventTime→time` (ISO), `awsRegion→region`, actor/tool via the reused functions; `params` never contains the `sourceIPAddress` value or the userAgent string.
  - `extractRefs` follows the spec key table at any depth and inside arrays: `RevokeSecurityGroupIngress {groupId}` → `{type:'sg',id}`; `StopInstances instancesSet.items[].instanceId` → instance refs; `ModifyNetworkInterfaceAttribute {networkInterfaceId, groupSet.items[].groupId}` → eni + sg refs; `securityGroups: ['sg-1','web']` keeps only `sg-` values; `ModifyListener {listenerArn: 'arn:aws:elasticloadbalancing:ap-northeast-2:111:listener/app/mo/abc/def'}` → `{type:'lb', arn:'arn:aws:elasticloadbalancing:ap-northeast-2:111:loadbalancer/app/mo/abc'}`; `targetGroupArn` → tg arn; `functionName` as name and as ARN (`arn:...:function:f` → id `f`, arn kept); `roleName`, `roleArn`; `bucketName`; cloudfront `id`/`distributionId` only when `eventSource === 'cloudfront.amazonaws.com'`; `resources[].ARN` → `{type:null, arn}`. Duplicates removed.
  - `sanitizeParams`: `{masterUserPassword:'x', nested:{SessionToken:'y'}}` → values `"[숨김]"`; output ≤ 600 chars (long input ends with `…`); `null`/missing → `''`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS, tsc clean.
- [ ] **Step 5: Commit** `feat(root-cause): parse CloudTrail write events into suspects`.

### Task 3: Graph history (dep-graph) and graph distance

**Files:**
- Modify: `src/lib/dep-graph/build.ts`, `src/lib/dep-graph/__tests__/build.test.ts`, `src/lib/dep-graph/CLAUDE.md`
- Create: `src/lib/root-cause/graph.ts`, `src/lib/root-cause/__tests__/graph.test.ts`

**Interfaces — Produces:**
- `build.ts`: `export const HISTORY_DIR = path.join(process.cwd(), 'data/graph/history')`; `export const HISTORY_KEEP = 12`; `rebuildGraph(deps)` gains `historyDir?: string` and, after a successful snapshot write, writes `<historyDir>/<builtAt with ':' and '.' replaced by '-'>.json` (same `{version:1, stats, data}`, tmp+rename) then deletes all but the newest 12 `*.json` (best-effort, error name logged). `export async function listHistory(dir: string = HISTORY_DIR): Promise<GraphSnapshot[]>` — ascending by `stats.builtAt`, skips unreadable/invalid files, `[]` if dir missing. (`GraphSnapshot` import type from `@/lib/root-cause/types`.)
- `graph.ts`:
  - `mergeGraphs(snaps: GraphSnapshot[], windowFrom: Date, startedAt: Date, current: GraphData | null): MergedGraph` — selected = snapshots with `windowFrom ≤ builtAt ≤ startedAt` plus the latest one with `builtAt < windowFrom`; union nodes by `arn` (later snapshot wins attrs), edges by `src|dst|type`; none selected → `current` with `from/to null, count 0`; `current` null too → empty graph.
  - `resolveRefs(refs: ResourceRef[], accountId: string, data: GraphData): GraphNode[]` — by `arn` first, else `(accountId, id, type)` exact, else `(accountId, id)` when unique; only nodes with `accountId === accountId` (IAM roles: arn account segment).
  - `proximity(targetArn: string | null, candidates: GraphNode[], refCount: number, data: GraphData): Proximity` — `no-target` when `targetArn` null; `not-in-graph` when `candidates` empty (regardless of refCount); undirected BFS from target, max depth 4, never expanding *through* a node of type `vpc`/`subnet` or with degree > 15 (target itself always expands; endpoints allowed); nearest candidate wins; `path` = `"<name>(<type>)"` from target to candidate; unreachable → `unconnected`, `path: []`.
  - `findNode(arn: string, current: GraphData | null, history: GraphSnapshot[]): GraphNode | null` — current first, then newest history.
- [ ] **Step 1: Tests (build)** — history file written with sanitized name; 13 builds → 12 files remain (newest kept); `listHistory` ascending, skips a corrupt file, `[]` for missing dir; failed snapshot write does not throw.
- [ ] **Step 2: Tests (graph)** — merge picks window snapshots + one before; union keeps an edge only present in the older snapshot; fallback to current; resolve ignores same id in another account; `ALB → TG → i → eni → sg` distance from ALB to sg is 4 with path of 5 entries; SG reachable only through a subnet → `unconnected`; hub with 16 edges is not passed through but is reachable as an endpoint; `no-target`; `not-in-graph`.
- [ ] **Step 3:** FAIL → implement → PASS; existing dep-graph tests still pass; tsc clean.
- [ ] **Step 4: Commit** `feat(root-cause): graph history snapshots and merged-graph distance`.

### Task 4: Scoring, ranking and the evaluation gate

**Files:** Create `src/lib/root-cause/score.ts`, `src/lib/root-cause/rank.ts`, `src/lib/root-cause/__tests__/score.test.ts`, `src/lib/root-cause/__tests__/eval.test.ts`

**Interfaces — Produces:**
- `score.ts`: `timeWeight(eventTime: Date, startedAt: Date): number`; `graphWeight(d: Distance): number`; `kindWeight(eventName: string): number` (tag list checked first, then prefix tables, spec §2 "점수" verbatim).
- `rank.ts`: `rankSuspects(input: { accountId: string; targetArn: string | null; startedAt: Date; rawEvents: unknown[]; graph: GraphData }): { suspects: Suspect[]; eventsSeen: number }` — `toWriteEvent` each (count non-null as `eventsSeen`), drop events outside `[start−60m, start+5m]`, `resolveRefs` → `proximity` → weights → `score = time×graph×kind` rounded to 4 decimals; sort score desc, then |Δt| asc, then eventId; `rank` 1-based; keep top 50.
- `eval.test.ts` exports nothing; it runs every `SCENARIOS` entry through `mergeGraphs(s.graphs, start−60m, start, null)` + `rankSuspects`, prints a table (`id | rank of answer | top1 event`), computes over non-`knownLimit` scenarios: `top1 = hits@1 / n`, `top3 = hits@3 / n`, and asserts `top1 >= 0.75` and `top3 >= 0.9`. `knownLimit` results are printed but not asserted.
- [ ] **Step 1: Unit tests** — `timeWeight` at Δ 0/20/60 → 1/≈0.3679/≈0.0498; +3 min → 0.3; graph weights table; `kindWeight('CreateTags') = 0.1`, `('RevokeSecurityGroupIngress') = 1`, `('ModifyRule') = 0.8`, `('CreateSecurityGroup') = 0.5`, `('BatchSomething') = 0.6`; ranking tiebreaks; out-of-window event excluded; 60 events → 50 suspects.
- [ ] **Step 2:** FAIL → implement → unit PASS.
- [ ] **Step 3: Run the eval honestly** `npx vitest run src/lib/root-cause/__tests__/eval.test.ts`. Do **not** edit `scenarios.ts` to make it pass. If below the gate: you may make **one** scoring change consistent with the spec's intent; record before/after numbers in the report. If still below, set the asserted thresholds to the measured values (floored to 2 decimals) and report it as a concern.
- [ ] **Step 4: Commit** `feat(root-cause): deterministic suspect scoring with evaluation gate` (put the measured top1/top3 in the commit body).

### Task 5: Evidence bundle and cited AI explanation

**Files:** Create `src/lib/root-cause/bundle.ts`, `src/lib/root-cause/explain.ts`, `src/lib/root-cause/__tests__/explain.test.ts`

**Interfaces:**
- Consumes: `invokeText(req: LlmRequest): Promise<LlmResult>` (`src/lib/ai/bedrock.ts`), `getBedrockModelId()`, `getBedrockModelLabel()` (`src/lib/app-config.ts`), `recordAndSave(...)` (`src/lib/ai/stats.ts`, route `'root-cause'`, `userId` from caller or `'system'`).
- Produces:
  - `buildBundle(ctx: { signals: Signal[]; resourceName: string | null; startedAt: string; graph: { from: string | null; to: string | null } }, suspects: Suspect[], opts?: { top?: number; maxChars?: number }): { text: string; eventIds: string[] }` — Korean plain text; top 8; per suspect: eventId, "시작 N분 전/후", eventName, actor name + tool, refs, path joined with ` → `, the three weights and score, params; total ≤ 24,000 chars (first shorten params bottom-up to 120 chars, then drop suspects from the bottom); `eventIds` = suspects actually included.
  - `ROOT_CAUSE_SYSTEM_PROMPT` (Korean): answer only from the bundle, cite eventIds exactly, return only the JSON object from spec §2, say so when evidence is weak, never suggest commands that change AWS.
  - `parseAiAnswer(text: string, eventIds: string[]): AiResult` — slice first `{` … last `}`; invalid JSON / no summary → `{status:'failed', droppedCitations:0}`; drop causes with unknown eventId (count them) or bad confidence (→ `'low'`); 0 valid causes → `status:'unverified'` (keep `droppedCitations`, omit summary/causes); else `'ok'`; `checks` strings only, max 5.
  - `explain(bundle: { text: string; eventIds: string[] }, deps?: { invoke?: typeof invokeText; record?: (r: { inputTokens: number; outputTokens: number; ms: number; ok: boolean }) => void }): Promise<AiResult>` — empty `eventIds` → `{status:'skipped', droppedCitations:0}` without calling; invoke errors → `'failed'` (error name logged).
- [ ] **Step 1: Tests** — bundle excludes IP/userAgent text present in raw params; cap respected with 50 long suspects; `eventIds` match included; parse: fenced ```json block works; unknown id dropped and counted; all unknown → `unverified`; prose only → `failed`; explain skips when no suspects; invoke throwing → `failed`; `maxTokens` 1200 and model id passed.
- [ ] **Step 2:** FAIL → implement → PASS → commit `feat(root-cause): evidence bundle and citation-verified AI explanation`.

### Task 6: Signal detection (CloudWatch)

**Files:** Create `src/lib/root-cause/signals.ts`, `src/lib/root-cause/__tests__/signals.test.ts`

**Interfaces — Produces:**
- `type Series = Array<{ t: string; v: number }>` (1-minute points, any order; missing minutes = 0).
- Pure: `detect5xx(series: Series, now: Date): { startedAt: string; recent: number; baseline: number } | null` (recent = sum of last 5 minutes; baseline = mean 5-minute sum over the 60 minutes before those; anomaly if `recent >= 10 && recent > 3 * Math.max(1, baseline)`; `startedAt` = first minute in the last 5 whose value > 0); `detectRise(series: Series, now: Date): { startedAt: string; recent: number } | null` (max of last 5 ≥ 1 and max of prior 30 = 0; first minute ≥1).
- `watchTargets(data: GraphData, accountId: string): { lbs: GraphNode[]; tgs: GraphNode[]; instances: GraphNode[] }` — `lb` with `attrs.lbType === 'application'`, `tg` with an incoming `forwards_to` from such an lb, `instance` with `attrs.state === 'running'`.
- Dimension helpers: `lbDimension(arn)` → `app/<name>/<id>`, `tgDimension(arn)` → `targetgroup/<name>/<id>`.
- `fetchSignals(accountId: string, region: string, data: GraphData, now: Date, deps?: { getMetricData?: (q: MetricQuery[], from: Date, to: Date) => Promise<Record<string, Series>>; describeAlarms?: () => Promise<AlarmInfo[]> }): Promise<Signal[]>` — one query per metric (`HTTPCode_ELB_5XX_Count` + `HTTPCode_Target_5XX_Count` summed per LB, `UnHealthyHostCount` Maximum per TG with LoadBalancer+TargetGroup dims, `StatusCheckFailed` Maximum per instance), window `now−70m..now`, period 60; batches of ≤500 queries; alarms in `ALARM` with `StateUpdatedTimestamp` within 15 min → `alarm` signal whose `resourceArn` is resolved from dimensions `InstanceId`/`LoadBalancer`/`TargetGroup`/`DBInstanceIdentifier`/`FunctionName` against `data` (else null + `alarmArn`, `alarmName`). Default deps use `CloudWatchClient` with `accountCredentials(accountId, 'awsops-root-cause')`; any fetch error → that part returns `[]` and logs the error name. `detail` strings in Korean, e.g. `5분 5xx 312건, 평소 2건`, `비정상 대상 2개`, `상태 검사 실패`, `알람 <name>`.
- [ ] **Step 1: Tests** — 5xx: flat 0 → null; 3/min baseline then 20/min → anomaly with correct startedAt; 9 total → null (floor); TG rise; rise suppressed when prior 30 had 1; watchTargets filters NLB and stopped instances; dimension helpers; fetchSignals with fake deps maps series ids back to resources, sums ELB+Target 5xx, turns an alarm with `TargetGroup` dim into a TG signal, getMetricData throwing still returns alarm signals.
- [ ] **Step 2:** FAIL → implement → PASS → commit `feat(root-cause): CloudWatch signal detection for ALBs, target groups, instances, alarms`.

### Task 7: Incidents, store, analysis queue, loop

**Files:** Create `src/lib/root-cause/incidents.ts`, `store.ts`, `analyze.ts`, `loop.ts`, `__tests__/incidents.test.ts`, `__tests__/store.test.ts`, `__tests__/analyze.test.ts`, `__tests__/loop.test.ts`. Modify `src/instrumentation.ts`, `src/lib/app-config.ts` (`rootCause?: { autoDetect?: boolean; slackAlerts?: boolean }`).

**Interfaces — Produces:**
- `incidents.ts` (pure): `incidentKey(s: Signal): string` (`${accountId}|${resourceArn ?? 'alarm:' + alarmArn}|${kind}`); `applySignals(list: Incident[], signals: Signal[], graphFor: (accountId: string) => GraphData | null, now: Date): { list: Incident[]; created: Incident[] }` — same key & open & lastSeen ≤60 min → bump `lastSeenAt`; else same account open incident (≤60 min) whose resource is within 2 hops by the Task 3 BFS rules → push signal into its `signals`, bump; else create (`id` = `rc-` + 10 random base36 chars, `source:'auto'`, `resourceName` from graph). Then open incidents with `lastSeenAt` older than 30 min → `resolved`. Newest first, cap 200.
- `store.ts`: `rootCauseDir()` (`ROOT_CAUSE_DATA_DIR` env override, default `data/root-cause`), `readIncidents(): Promise<Incident[]>` (missing → `[]`, corrupt → moved to `.corrupt-<ts>`, `[]`), `writeIncidents(list)` (tmp+rename), `updateIncidents(fn: (list: Incident[]) => Incident[]): Promise<Incident[]>` serialized on one promise chain.
- `analyze.ts`:
  - `lookupWriteEvents(accountId: string, region: string, from: Date, to: Date, deps?: { lookup?: LookupFn }): Promise<{ events: unknown[]; truncated: boolean; failed: boolean }>` — ≤10 pages; parse each `CloudTrailEvent` JSON string; errors → `failed: true` with the events so far.
  - `analyzeIncident(inc: Incident, deps?: AnalyzeDeps): Promise<Analysis>` — window from `inc.startedAt`; regions `[inc.region, 'us-east-1']` deduped; `listHistory()` + current store data → `mergeGraphs`; `rankSuspects`; `buildBundle` + `explain`; `failedRegions` collected; never throws for a region/AI failure.
  - `enqueueAnalysis<T>(fn: () => Promise<T>): Promise<T>` — process-wide serial chain on `globalThis.__awsopsRootCause`.
  - `manualAnalyze(req: { accountId: string; resourceArn: string | null; at?: string; userId?: string }, deps?): Promise<Incident>` — throws `Error` named `RateLimited` if a manual run started <30 s ago, `NotFound` if `resourceArn` is not in current graph nor history (`findNode`), `BadTime` if `at` is in the future (>2 min) or older than 7 days; creates a `source:'manual'` incident (signal kind `'alarm'` is not used — manual incidents have `signals: []`), runs via the queue, saves, returns it.
- `loop.ts`: `ensureRootCauseStarted(): void` (production only; first tick after 90 s, then every 300,000 ms); `tick(deps?): Promise<void>` — skip when `getConfig().rootCause?.autoDetect === false` or no current graph; per configured account (`getConfig().accounts`, host fallback) `fetchSignals` → `updateIncidents(applySignals)` → each `created` incident: `enqueueAnalysis(analyzeIncident)`, save analysis, then `notifyIncident` hook (Task 9 sets it via `setIncidentNotifier(fn)`); errors logged by name, never thrown.
- `instrumentation.ts`: add `ensureRootCauseStarted()` in its own try/catch after dep-graph.
- [ ] **Step 1: Tests** — key for alarm without resource; three related signals (LB, its TG, its instance) in one tick → 1 incident with 3 signals; unrelated LB → 2 incidents; dedupe within 60 min, new after 61; resolve after 30 min; cap 200. Store: missing → [], corrupt preserved, concurrent `updateIncidents` both applied. Analyze (all deps faked): one region failing → other region's suspects present and `failedRegions`; 10 full pages → `truncated`; AI failing → analysis saved with `ai.status 'failed'`; queue runs two analyses sequentially (second starts after first resolves); manual: RateLimited, NotFound, BadTime, deleted resource found in history → ok. Loop (fake timers, `NODE_ENV` stubbed): first tick at 90 s, then every 300 s, nothing outside production; `autoDetect:false` → no fetch.
- [ ] **Step 2:** FAIL → implement → PASS; full `npx vitest run`, tsc → commit `feat(root-cause): incidents, serial analysis queue and detection loop`.

### Task 8: API route

**Files:** Create `src/app/api/root-cause/route.ts`, `src/app/api/root-cause/__tests__/route.test.ts`; Modify `src/app/CLAUDE.md`.

**Interfaces:** `export const dynamic = 'force-dynamic'; export const runtime = 'nodejs'`. Handlers delegate to `handleRootCauseGet(params: URLSearchParams, deps?)` / `handleRootCausePost(body: unknown, userId: string | null, deps?)` in `src/lib/root-cause/api.ts` returning `{ status: number; body: unknown }`.
- GET `op=list[&accountId=12 digits|__all__]` → `{ incidents: IncidentSummary[], autoDetect: boolean }` (summary = incident without `analysis.suspects` beyond rank 1, max 50); `op=get&id=rc-…` → `{ incident }` or 404 `{error:'not-found'}`; bad op/params → 400 with Korean message.
- POST `{op:'analyze', accountId, resourceArn?: string|null, at?: string}` → 200 `{incident}`; `RateLimited` → 429, `NotFound` → 404, `BadTime`/bad body → 400. User id from `getUserFromRequest` (existing `src/lib/auth-utils.ts`).
- All responses `Cache-Control: no-store`; 500 → `{error: e.name}`.
- [ ] **Step 1: Tests** for each status path with faked deps. **Step 2:** implement → PASS → update `src/app/CLAUDE.md` (API list, both languages) → commit `feat(root-cause): /api/root-cause list, get and manual analyze`.

### Task 9: Slack — incident alert and "왜 고장났어" question

**Files:** Create `src/lib/root-cause/slack.ts`, `__tests__/slack.test.ts`; Modify `src/lib/slack-chatops/handle.ts` (+ its test), `src/lib/slack-chatops/bot.ts`, `src/lib/root-cause/loop.ts` (register notifier at start).

**Interfaces — Produces:**
- `formatIncidentAlert(inc: Incident, appUrl?: string): string` — spec §2 Slack example shape: `🔎 장애 감지: <name>(<type>) <signal detail> (<HH:mm KST>부터)`, signal count if >1 (`외 신호 N개`), `의심 1위: <HH:mm> <actor>님이 <resource> <eventName> (<tool>)` or `직전 60분에 관련 변경이 없어요`, AI summary line only when `ai.status === 'ok'`, link `<appUrl>/root-cause?id=<id>` when appUrl set.
- `notifyIncident(inc: Incident, deps?: { viaBot?: typeof postAlertViaBot; webhook?: () => Promise<string | null>; post?: typeof postSlack }): Promise<boolean>` — skip when `rootCause.slackAlerts === false`; bot with `{ button: false }` first; `{ok:false}` without error → webhook fallback; returns delivered.
- `detectRcaQuestion(text: string): { query: string } | null` — needs a cause word (`왜 고장|원인|뭐가 바뀌|무슨 변경|why.*(down|broken|fail)|root cause`) **and** a resource token (`sg-…`, `i-…`, `eni-…`, `arn:aws:…`, or a word ≥3 chars that is not a stop word); strips the bot mention.
- `maybeHandleRcaQuestion(event: MentionEvent, deps: { reply: (text: string) => Promise<void>; analyze?: typeof manualAnalyze; search?: (q: string) => Promise<GraphNode[]> }): Promise<boolean>` — no detection → false; resource lookup via current graph (`getCurrentStore()?.search(q,{limit:1})`, arn exact first); not found → false (falls through to AI); found → reply `분석 중이에요…`, run `manualAnalyze`, reply `formatIncidentAlert`; `RateLimited` → reply `방금 분석했어요. 30초 뒤에 다시 물어봐 주세요.`; other error → reply with a fallback and return true.
- `handle.ts`: `HandleDeps.tryRcaQuestion?: (event: MentionEvent) => Promise<boolean>` called **before** `tryChangeQuestion`. `bot.ts` wires it like `tryChangeQuestion`.
- [ ] **Step 1: Tests** — alert text with/without appUrl, with unverified AI (no AI line), no suspects; notify: bot ok, bot unconfigured → webhook, `slackAlerts:false` → no call, button false passed; detect positives/negatives (`누가 sg-1 만들었어?` → null); handler flows above; handle.ts order test.
- [ ] **Step 2:** FAIL → implement → PASS → commit `feat(root-cause): Slack incident alerts and cause questions`.

### Task 10: `/root-cause` page

**Files:** Create `src/app/root-cause/page.tsx`, `src/components/root-cause/{RootCauseView,IncidentList,IncidentDetail,SuspectTable,SuspectTimeline,AnalyzeForm}.tsx`, `src/components/root-cause/api.ts`, `src/components/root-cause/format.ts`, `src/components/root-cause/CLAUDE.md`, `src/components/root-cause/__tests__/format.test.ts`. Modify `src/components/layout/Sidebar.tsx` (monitoring section, after `sidebar.changes`, icon `SearchCheck` from lucide-react — fall back to `Search` if not exported), i18n `ko/en/zh.json`, `src/components/CLAUDE.md`.

**Behavior:** spec §2 "화면". Page wrapper mirrors `src/app/changes/page.tsx`. `api.ts`: `listIncidents(accountId)`, `getIncident(id)`, `analyze(body)` using `fetch('/api/root-cause...')` with AbortController. URL `?id=` selects an incident. AnalyzeForm search uses `/api/graph?op=search&q=&accountId=` (debounced 250 ms, keyboard selectable like `src/components/dep-graph/SearchBox.tsx`), time input (default now, local), button disabled while running, 429 → toast text `rootCause.rateLimited`. Detail: AI block only for `status === 'ok'` with cited chips scrolling to the suspect row; `unverified`/`failed` → muted note `rootCause.aiHidden`. SuspectTable: rank, `formatOffset(eventTime, startedAt)` (`12분 전` / `2분 후`), event, actor (tool), resource, path, score with three bars. SuspectTimeline: Recharts scatter, x = minutes from start (−60..+5), y = score, vertical reference line at 0. Banner when `autoDetect` false. Graph basis line `rootCause.graphBasis` with from~to and count. Respect `useAccount()`.
- `format.ts` pure helpers: `formatOffset(eventIso, startIso, t)`, `signalLabel(kind, t)`, `distanceLabel(d, t)` — tested, plus an i18n parity test: every `rootCause.*` key exists in all three files.
- [ ] **Step 1:** format + parity tests → FAIL → implement → PASS. **Step 2:** `npx tsc --noEmit`, `npx next build` lists `/root-cause` and `ƒ /api/root-cause`. **Step 3:** commit `feat(root-cause): /root-cause page with suspects, timeline and manual analysis`.

### Task 11: ADR-013 and docs

**Files:** Create `docs/decisions/013-root-cause-scored-suspects.md`, `src/lib/root-cause/CLAUDE.md`. Modify root `CLAUDE.md` (pages 46, routes 75, API 29, ADR 13, key-files bullets for `root-cause/` and `root-cause/route.ts`, both languages; fix the stale CloudTrail pacing "600ms" → "1초에 1회 / 1 request/s"), `src/lib/CLAUDE.md`, `src/lib/dep-graph/CLAUDE.md` (history already from Task 3 — verify).
- ADR-013 (Korean, same layout as ADR-012): context; decision (deterministic score ranks, LLM only explains, citations verified, merged graph history); alternatives (LLM ranks the raw events; plain prompting with all events; time-only ranking; graph-only); consequences (cost ≈ $2/month GetMetricData, Bedrock per incident, known limits — 15 types, no logs yet, CloudTrail delivery delay); evaluation numbers from Task 4 (top1/top3, knownLimit results, any tuning made); follow-ups (Drain-style log templates, real drill with approval).
- [ ] **Step 1:** write docs; `npx vitest run` + tsc → commit `docs(root-cause): ADR-013 and CLAUDE.md sync`.
