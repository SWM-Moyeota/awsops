# Change Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record who created and deleted which AWS resources, then show it in three places: a `/changes` page, a "만든 사람" line on the S3/EC2/RDS lists, and Slack (questions plus a 09:00 summary).

**Architecture:** An in-server loop reads CloudTrail `LookupEvents` for each account and region. The first run backfills 90 days, querying by event name. Later runs are incremental, reading write events since the last run. It keeps only the tracked create and delete events and stores them as JSON under `data/change-timeline/`. A query layer serves the page, a creators API, and the Slack bot. All CloudTrail calls, including the cost radar's creator lookups, go through one shared pacer.

**Tech Stack:** Next.js 14 App Router, TypeScript, vitest, `@aws-sdk/client-cloudtrail` and `@aws-sdk/client-sts` (both already installed), Tailwind, Pretendard (`pretendard@1.3.9`, via `next/font/local`).

**Spec:** `docs/superpowers/specs/2026-10-26-change-timeline-design.md`. The approved dark mockup is `docs/superpowers/specs/assets/2026-10-26-change-timeline-mockup.html`. Implementers read both.

## Global Constraints

- Read-only: never call a mutating AWS API.
- Tracked regions are only `ap-northeast-2` and `us-east-1`. `us-east-1` is used only for the IAM events.
- At most 2 CloudTrail calls per second per account and region, combined across the timeline and the cost radar. The shared pacer enforces this with at least 600 ms between calls per `${accountId}:${region}`.
- Non-host accounts assume `AWSopsReadOnlyRole`, passing `ExternalId = config.crossAccountExternalId`, through the shared helper.
- Data dir is `data/change-timeline/`. The env var `CHANGE_TIMELINE_DATA_DIR` overrides it, and tests use that. Add the dir to `.gitignore`.
- Never log CloudTrail payloads, IPs or credentials. Log only error names.
- App rules from `CLAUDE.md`:
  - every `fetch` goes to `/api/*`
  - components use default export
  - i18n keys go in all of `src/lib/i18n/translations/{ko,en,zh}.json`
  - pages follow the account picker via `useAccountContext()`; `__all__` means all accounts
- UI copy is Korean, Toss-style sentences, taken from the mockup: "**{name}**님이 {종류}를 만들었어요" / "… 지웠어요". Auto rows read "{name}이(가) {종류}를 만들었어요".
- Dark palette comes from the mockup's `:root[data-theme="dark"]`:
  - bg `#0a0e1a`; cards `#0f1629` and `#151d30`; line `#1a2540`
  - text `#f2f4f6`, `#b0b8c1`, `#6b7684`
  - blue `#4593fc`; green `#00d68f`; red `#ff5f6d`
  - card radius 24px; chips are pills
- Pretendard is used only inside the new UI: the page, `CreatorBadge`, and the Slack text.
- The "people" count includes only actor kinds `person` and `root`. Auto and AWSops rows are counted as creates/deletes but never as people.

## Review Focus

1. **The same event comes back from both backfill and incremental reads, or from overlapping windows.** It must be stored once. Dedupe on `id = ${eventId}:${index}`. Test in Task 3 (`appendRecordsDedupes`).
2. **One account's AssumeRole fails** (Moyeota role missing or External ID wrong). The other account keeps ingesting, and `status.failedAccounts` lists the failed one. Test in Task 4 (`oneAccountFailureDoesNotStopOthers`).
3. **A server restart in the middle of a 90-day backfill.** The next run resumes with the event names it hasn't finished, not from scratch. Test in Task 4 (`backfillResumesFromState`).
4. **The Slack 09:00 summary after a restart at 09:05, or on a day with zero changes.** At most one summary per KST day, and none on a zero-change day. Test in Task 7 (`dailySummaryOncePerDay`, `noSummaryWhenNoChanges`).
5. **A `RunInstances` event that creates 3 instances, and a `CreateBucket` whose response has no bucket name.** Write 3 records for the first. The second falls back to `requestParameters.bucketName`. Tests in Task 2 (`runInstancesYieldsOneRecordPerInstance`, `bucketNameFromRequest`).

---

## File Structure

```
src/lib/cloudtrail-access.ts            NEW  shared pacer + cross-account creds (Task 1)
src/lib/cost-radar/creators.ts          MOD  use the shared pacer/creds (Task 1)
src/lib/change-timeline/types.ts        NEW  contract types (Task 0 — written before dispatch)
src/lib/change-timeline/catalog.ts      NEW  tracked events table (Task 2)
src/lib/change-timeline/parse.ts        NEW  CloudTrail event → ChangeRecord[] (Task 2)
src/lib/change-timeline/store.ts        NEW  monthly JSON files + state (Task 3)
src/lib/change-timeline/query.ts        NEW  filters, summary, facets, creators, text search (Task 3)
src/lib/change-timeline/ingest.ts       NEW  backfill + incremental per account/region (Task 4)
src/lib/change-timeline/loop.ts         NEW  globalThis loop, started from instrumentation (Task 4)
src/lib/change-timeline/slack.ts        NEW  who-question + daily summary text (Task 7)
src/app/api/changes/route.ts            NEW  GET timeline (Task 5)
src/app/api/changes/creators/route.ts   NEW  GET creators for ids (Task 6)
src/app/changes/page.tsx                NEW  server wrapper + Pretendard (Task 5)
src/components/changes/*                NEW  view, summary, filters, row, detail panel, format.ts (Task 5); CreatorBadge, useCreators (Task 6)
src/app/{s3,ec2,rds}/page.tsx           MOD  "만든 사람" column (Task 6)
src/lib/slack-chatops/{handle,bot}.ts   MOD  tryChangeQuestion hook (Task 7)
src/instrumentation.ts                  MOD  start the loop (Task 4)
```

### Task 0 (controller, before dispatch): contract types

Write `src/lib/change-timeline/types.ts` with exactly these exports, then commit. Every task builds against these types.

```ts
export type ChangeKind = 'create' | 'delete';
export type ActorKind = 'person' | 'auto' | 'awsops' | 'root';
export type ToolId = 'console' | 'cli' | 'terraform' | 'sdk' | 'cloudformation' | 'autoscaling' | 'other';
export type TrackedRegion = 'ap-northeast-2' | 'us-east-1';
export type ResourceType =
  | 's3-bucket' | 'ec2-instance' | 'ebs-volume' | 'ebs-snapshot' | 'security-group' | 'elastic-ip'
  | 'nat-gateway' | 'vpc' | 'subnet' | 'load-balancer' | 'target-group' | 'rds-instance' | 'rds-cluster'
  | 'elasticache-cluster' | 'elasticache-replication-group' | 'elasticache-serverless' | 'lambda-function'
  | 'ecr-repository' | 'ecs-cluster' | 'ecs-service' | 'eks-cluster' | 'dynamodb-table' | 'iam-user' | 'iam-role';
export interface Actor { kind: ActorKind; name: string; sourceIdentity?: string }
export interface ChangeRecord {
  id: string; eventId: string; eventName: string; accountId: string; region: string;
  time: string; kind: ChangeKind; resourceType: ResourceType; resourceId: string; resourceName: string;
  actor: Actor; tool: ToolId; via?: string; sourceIp?: string; failed?: boolean;
}
export interface TrackedEvent { eventName: string; eventSource: string; kind: ChangeKind; resourceType: ResourceType; region: TrackedRegion }
export interface AccountRegionState {
  backfillFrom: string; backfillDone: string[]; lastTo?: string; lastRunAt?: string; lastError?: string;
}
export interface IngestState { accounts: Record<string, AccountRegionState>; lastSummaryDay?: string }
export type RangeId = '24h' | '7d' | '30d' | '90d' | 'all';
export interface ChangesQuery {
  accountId: string; range: RangeId; kind?: ChangeKind; actor?: string; resourceType?: ResourceType; q?: string; now?: Date;
}
export interface ChangesResponse {
  records: ChangeRecord[];
  summary: { creates: number; deletes: number; people: number };
  facets: { people: string[]; resourceTypes: ResourceType[] };
  status: { coverageFrom: string | null; lastIngestAt: string | null; backfilling: boolean; failedAccounts: string[] };
  truncated: boolean;
}
export interface CreatorLookup {
  key: string; status: 'found' | 'too-old' | 'none'; actor?: Actor; time?: string; tool?: ToolId; via?: string; deletedAt?: string;
}
```

Field meanings, so every task reads them the same way:
- `id`: `${eventId}:${index}`, stable across re-ingest.
- `time`: ISO UTC.
- `resourceName`: `''` when unknown.
- `via`: the service that acted for a person. For example, "CloudFormation" when `invokedBy` is set and an IAM user is present.
- `failed`: true when the event has an `errorCode`. Such records are stored but hidden by default.
- `IngestState.accounts` key: `${accountId}:${region}`.
- `lastSummaryDay`: KST `YYYY-MM-DD`.
- `ChangesResponse.records`: newest first, at most 500. `truncated` is true when more matched.
- `CreatorLookup.key`: `${accountId}:${resourceId}`.

---

### Task 1: Shared CloudTrail access (pacer + cross-account creds)

**Files:** Create `src/lib/cloudtrail-access.ts`, `src/lib/__tests__/cloudtrail-access.test.ts`. Modify `src/lib/cost-radar/creators.ts` and remove its private `credsFor`, `pace` and `lastCall`.

**Interfaces — Produces:**
- `cloudTrailSlot(accountId: string, region: string): Promise<void>`. Resolves once at least `CLOUDTRAIL_MIN_INTERVAL_MS = 600` has passed since the previous slot for the same `${accountId}:${region}`. State lives on `globalThis.__awsopsCloudTrailPacer`, so route bundles and instrumentation share it.
- `accountCredentials(accountId: string, sessionName: string): Promise<{accessKeyId; secretAccessKey; sessionToken?} | undefined>`. Returns `undefined` for the host account or an unknown account. Otherwise it assumes `arn:aws:iam::${accountId}:role/AWSopsReadOnlyRole` (DurationSeconds 900, ExternalId from config) and caches per account until 1 minute before expiry.
- `resetCloudTrailAccess(): void`, a test hook.

- [ ] Step 1: Write the failing tests.
  - `slotsSpaceCallsPerAccountRegion`: use fake timers. Two slots for the same key resolve at least 600 ms apart. Slots for different keys don't wait.
  - `hostAccountUsesDefaultChain`: `accountCredentials` returns `undefined` for the account with `isHost`.
  - `crossAccountAssumesReadOnlyRoleWithExternalId`: mock STS. Assert the RoleArn and ExternalId, and that a second call is served from the cache.
- [ ] Step 2: Run `npx vitest run src/lib/__tests__/cloudtrail-access.test.ts`. Expected: FAIL, module not found.
- [ ] Step 3: Implement. Then change `creators.ts` to `await cloudTrailSlot(accountId, region)` before each `LookupEventsCommand` page, and to use `accountCredentials(accountId, 'awsops-cost-radar')`. Keep its per-account queue and cache behaviour unchanged.
- [ ] Step 4: Run `npx vitest run src/lib/__tests__/cloudtrail-access.test.ts src/lib/cost-radar` and `npx tsc --noEmit`. Expected: PASS. All existing creators tests still pass, so update only the mocks they need.
- [ ] Step 5: Commit `feat(cloudtrail): shared pacer and cross-account credentials`.

### Task 2: Catalog + event parser

**Files:** Create `src/lib/change-timeline/catalog.ts`, `parse.ts`, `__tests__/parse.test.ts`, and `__tests__/fixtures/*.json`.

**Interfaces:**
- Consumes the types from Task 0.
- Produces:
  - `TRACKED: TrackedEvent[]`, the spec §4 table. ECS `CreateCluster` has eventSource `ecs.amazonaws.com`; EKS uses `eks.amazonaws.com`. IAM events are in region `us-east-1`; everything else is `ap-northeast-2`.
  - `findTracked(eventName: string, eventSource: string): TrackedEvent | undefined`
  - `eventNamesFor(region: TrackedRegion): string[]` (unique)
  - `toRecords(raw: unknown, accountId: string): ChangeRecord[]`, where `raw` is the parsed `CloudTrailEvent` JSON. It returns `[]` for untracked events.
  - `classifyActor(userIdentity: unknown): { actor: Actor; via?: string }`
  - `detectTool(userAgent: string | undefined, invokedBy: string | undefined): ToolId`

Actor rules (spec §4), in order:
1. `type: 'Root'` → `{kind: 'root', name: '루트 계정'}`.
2. `type: 'IAMUser'` → person `userName`. If `invokedBy` is set, `via` is the friendly service name: `cloudformation.amazonaws.com` → "CloudFormation", `autoscaling.amazonaws.com` → "Auto Scaling", anything else → the hostname's first label.
3. `AssumedRole`, issuer name matching `^AWSServiceRoleFor` or `type: 'AWSService'` → auto, with a friendly name such as "Auto Scaling".
4. Issuer matching `^cdk-.*-cfn-exec-role-` → auto "CloudFormation (CDK)".
5. Issuer in {`awsops-ec2-role`, `AWSopsLambdaNetworkRole`, `AWSopsSlackControlRole`, `AWSopsAgentCoreRole`} → `awsops` "AWSops", plus `sourceIdentity` from `userIdentity.sessionContext.sourceIdentity` when present.
6. Issuer matching `^AWSReservedSSO_` → person, named by the session name (the last ARN segment).
7. Any other role → auto `${issuer}(${session})`.

Tool rules: `invokedBy` cloudformation → `cloudformation`; autoscaling → `autoscaling`. Otherwise use the userAgent:
- contains `console.amazonaws.com`, `signin.amazonaws.com` or `AWS Internal` → `console`
- `aws-cli/` → `cli`
- `Terraform` or `terraform-provider` → `terraform`
- `Boto3`, `aws-sdk-` or `aws-sdk-js` → `sdk`
- anything else → `other`

Resource extraction, one record per created or deleted resource:
- S3: `requestParameters.bucketName`.
- RunInstances: `responseElements.instancesSet.items[].instanceId`, with the name taken from that item's `tagSet.items` Name tag, or else from `requestParameters.tagSpecificationSet.items[*].tags` Name.
- TerminateInstances: `requestParameters.instancesSet.items[].instanceId`.
- RDS: `dBInstanceIdentifier` / `dBClusterIdentifier`.
- For the other types, use the obvious id field (for example `groupId`/`groupName`, `allocationId`, `natGatewayId`, `loadBalancerArn` with the name from its last segment, `functionName`, `repositoryName`, `clusterName`/`serviceName`, `tableName`, `userName`/`roleName`). The fallback is `raw.resources[0]`.

- [ ] Step 1: Capture fixtures. Run read-only `aws cloudtrail lookup-events --region ap-northeast-2 --lookup-attributes AttributeKey=EventName,AttributeValue=<name> --max-results 2` for CreateBucket, RunInstances, TerminateInstances, CreateSecurityGroup, CreateDBInstance and DeleteBucket (whichever exist). Save the `CloudTrailEvent` JSON into fixtures, **replacing `sourceIPAddress` with `203.0.113.10` and account IDs with `111122223333`**. Hand-write any fixture that has no sample: a 3-instance RunInstances, a cdk-exec-role event, an AWSServiceRoleForAutoScaling event and a Root event.
- [ ] Step 2: Write the failing tests:
  - `runInstancesYieldsOneRecordPerInstance`: 3 records, ids `${eventId}:0..2`, names taken from tags.
  - `bucketNameFromRequest`
  - `iamUserViaCloudFormationKeepsPerson`: `{kind: 'person', name: 'sungyoon'}`, `via: 'CloudFormation'`, tool `cloudformation`.
  - `serviceLinkedRoleIsAuto`
  - `cdkExecRoleIsAuto`
  - `awsopsRoleKeepsSourceIdentity`
  - `rootIsRoot`
  - `untrackedEventYieldsNothing`: `CreateLogStream` gives `[]`.
  - `ecsVsEksClusterBySource`
  - `failedCallMarkedFailed`
  - `detectTool` cases, one per rule.
- [ ] Step 3: Run `npx vitest run src/lib/change-timeline/__tests__/parse.test.ts`. Expected: FAIL.
- [ ] Step 4: Implement `catalog.ts` and `parse.ts`. Use defensive property access throughout; never throw on odd payloads.
- [ ] Step 5: Run the test again. Expected: PASS. Then run `npx tsc --noEmit`.
- [ ] Step 6: Commit `feat(change-timeline): tracked event catalog and CloudTrail parser`.

### Task 3: Store + query

**Files:** Create `src/lib/change-timeline/store.ts`, `query.ts`, `__tests__/store.test.ts`, `__tests__/query.test.ts`.

**Interfaces:**
- Consumes the types from Task 0.
- Produces from `store.ts`:
  - `timelineDir(): string`
  - `appendRecords(records: ChangeRecord[]): Promise<number>` returns how many were new. It writes to monthly files `records-YYYY-MM.json` (UTC month of `time`), each holding `Record<id, ChangeRecord>`. Writes are atomic (temp file + rename) and serialized on one promise chain.
  - `readRecords(from: Date, to: Date): Promise<ChangeRecord[]>` reads only the months that overlap.
  - `readState(): Promise<IngestState>`, which defaults to `{accounts: {}}`.
  - `writeState(s: IngestState): Promise<void>`
- Produces from `query.ts`:
  - `rangeStart(range: RangeId, now: Date): Date`. `all` means the epoch.
  - `queryChanges(q: ChangesQuery, deps?: {read?: typeof readRecords; state?: typeof readState}): Promise<ChangesResponse>`
    - Filters: account (`__all__` means every account), kind, actor (exact name), resourceType, and `q` (case-insensitive substring of resourceName or resourceId).
    - Hides `failed` records.
    - Sorts newest first and caps at 500 with `truncated`.
    - The summary is computed over the filtered set. People are distinct names with kind person or root.
    - Facets come from the range before the actor, type and q filters.
    - `status`:
      - `coverageFrom` is the minimum `backfillFrom`.
      - `lastIngestAt` is the maximum `lastRunAt`.
      - `backfilling` is true if any account-region has not finished backfilling. It is finished once `backfillDone` holds every name from `eventNamesFor(region)`, so this depends on Task 2. Import it, and if Task 2 isn't merged yet, keep it to one line in a helper and stub it in tests.
      - `failedAccounts` lists the accountIds that have a `lastError`.
  - `findCreators(keys: string[], deps?): Promise<CreatorLookup[]>`
    - Looks up each `${accountId}:${resourceId}`. A resource matches on its id or, for S3, its name.
    - `found` uses the newest create record; `deletedAt` is the newest delete after it.
    - `too-old` applies when there is no record and coverage started after the time the caller passes.
    - Callers may pass `createdAt` per key: accept `keys` as `string[]` or `{key, createdAt?}[]`, and normalize internally.
    - Anything else is `none`.
  - `searchByText(text: string, deps?): Promise<ChangeRecord[]>` returns all records whose resourceName or resourceId equals the text, or contains it if there is no exact match. Newest first, at most 20.

- [ ] Step 1: Write the failing tests:
  - `appendRecordsDedupes`: appending the same records twice returns 0 the second time, and the file holds each id once.
  - `readsAcrossMonths`
  - `missingDirReturnsEmpty`
  - `summaryCountsPeopleNotAuto`: 4 creates and 1 delete by sungyoon, jiwoo, minsu plus 1 CloudFormation auto row give `{creates: 4, deletes: 1, people: 3}`.
  - `filtersByKindActorTypeAndText`
  - `hidesFailed`
  - `allAccountsVsOne`
  - `capsAt500WithTruncated`
  - `statusReportsBackfillingAndFailures`
  - `findCreatorsFoundTooOldNone`
  - `findCreatorsReportsLaterDelete`
  - `searchByTextExactFirst`

  All tests use `CHANGE_TIMELINE_DATA_DIR` with a tmp dir.
- [ ] Step 2: Run them. Expected: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them again, plus `npx tsc --noEmit`. Expected: PASS.
- [ ] Step 5: Commit `feat(change-timeline): JSON store and query layer`.

### Task 4: Ingest + loop

**Files:** Create `src/lib/change-timeline/ingest.ts`, `loop.ts`, `__tests__/ingest.test.ts`. Modify `src/instrumentation.ts` and add the loop start inside the existing `NEXT_RUNTIME === 'nodejs'` branch.

**Interfaces:**
- Consumes:
  - from Task 1: `cloudTrailSlot`, `accountCredentials`
  - from Task 2: `TRACKED`, `eventNamesFor`, `toRecords`
  - from Task 3: `appendRecords`, `readState`, `writeState`
  - from config: `getAccounts()`
- Produces from `ingest.ts`:
  - `type LookupPage = { events: Array<{ CloudTrailEvent?: string }>; nextToken?: string }`
  - `type LookupFn = (accountId: string, region: string, params: { eventName?: string; readOnlyFalse?: boolean; start: Date; end: Date; nextToken?: string }) => Promise<LookupPage>`
  - `defaultLookup: LookupFn`. Each call awaits `cloudTrailSlot`, then sends `LookupEventsCommand` with `MaxResults: 50`, using `accountCredentials(accountId, 'awsops-change-timeline')`.
  - `ingestOnce(opts?: { lookup?: LookupFn; now?: Date; accounts?: string[]; maxPagesPerCall?: number }): Promise<{ added: number; failed: string[] }>`
- Produces from `loop.ts`:
  - `ensureChangeTimelineStarted(): void`. It sets up a `globalThis.__awsopsChangeTimeline` singleton. The first run is 30 s after start, then every `INGEST_INTERVAL_MS = 10 * 60_000`. A run never overlaps the previous one and never throws. It runs only when `NODE_ENV === 'production'`; `/api/changes` also calls it.
  - Each tick also calls `maybeSendDailySummary()` from Task 7 through an optional hook set with `setDailySummaryHook(fn: () => Promise<void>)`, so Task 4 doesn't import Task 7.

Algorithm, per account and per region:
1. State key `${accountId}:${region}`. If the key is missing, initialize `backfillFrom = now − 90d`.
2. **Backfill**: for each name in `eventNamesFor(region)` that is not in `backfillDone`, page through `eventName` from `backfillFrom` to now. Append the records, then push the name onto `backfillDone` and persist the state after each name, so the backfill can resume.
3. **Incremental**: run once backfill is complete, or right after it. `start = (lastTo ?? backfillFrom) − 20 min overlap`, `end = now`, using `readOnlyFalse` (ReadOnly=false). Page fully up to `maxPagesPerCall` (default 40), keep only the tracked events via `toRecords`, append them, and set `lastTo = now`.
4. Set `lastRunAt = now`. On error, record `lastError` as the error name and continue with the next account. Clear `lastError` after a success.
5. Accounts come from `getAccounts()` when there are any, otherwise from the host account. Run regions `ap-northeast-2` and `us-east-1` in that order, but call us-east-1 only for its tracked names: the IAM events in backfill, and the incremental read filtered by the catalog.

- [ ] Step 1: Write the failing tests, all with a fake `LookupFn` and a tmp data dir:
  - `backfillQueriesEachTrackedNameThenIncremental`
  - `backfillResumesFromState`: after the fake throws midway, a second run starts from the first unfinished name and doesn't repeat finished ones.
  - `incrementalUsesOverlapAndDedupes`: running twice with the same events adds 0 the second time.
  - `oneAccountFailureDoesNotStopOthers`
  - `pagesFollowNextToken`
  - `stateRecordsLastRunAndClearsError`
- [ ] Step 2: Run them. Expected: FAIL.
- [ ] Step 3: Implement `ingest.ts` and `loop.ts`, and wire `instrumentation.ts`.
- [ ] Step 4: Run `npx vitest run src/lib/change-timeline` and `npx tsc --noEmit`. Expected: PASS.
- [ ] Step 5: Commit `feat(change-timeline): CloudTrail ingest loop with resumable backfill`.

### Task 5: `/changes` page + API (Toss dark)

**Files:**
- Create `src/app/api/changes/route.ts` and `src/app/changes/page.tsx`.
- Create `src/app/changes/fonts/PretendardVariable.woff2`, copied from `node_modules/pretendard/dist/web/variable/woff2/` after `npm i -D pretendard@1.3.9`.
- Create in `src/components/changes/`: `ChangeTimelineView.tsx`, `ChangeSummary.tsx`, `ChangeFilters.tsx`, `ChangeRow.tsx`, `ChangeDetailPanel.tsx`, `format.ts`, and `__tests__/format.test.ts`.
- Modify `src/components/layout/Sidebar.tsx`: add `{ labelKey: 'sidebar.changes', href: '/changes', icon: History }` right after cloudtrail.
- Modify the i18n files `ko.json`, `en.json` and `zh.json`.

**Interfaces:**
- Consumes `queryChanges`, `RangeId` and `ChangesResponse` from Task 3, and `ensureChangeTimelineStarted` from Task 4. If Task 4 isn't merged, import it lazily and guard it.
- Produces `GET /api/changes?accountId=&range=7d&kind=&actor=&type=&q=` → `ChangesResponse`.
  - 400 for an invalid accountId (not 12 digits and not `__all__`) or an invalid range or kind.
  - On 500 the body holds only the error name.
  - Responds with `Cache-Control: no-store`.
- Produces from `format.ts`. These are pure functions, and Task 6 and Task 7 reuse them.
  - `resourceTypeLabel(t: ResourceType): string`, in Korean: `S3 버킷`, `EC2 서버`, `EBS 볼륨`, `EBS 스냅샷`, `보안그룹`, `탄력적 IP`, `NAT 게이트웨이`, `VPC`, `서브넷`, `로드밸런서`, `타겟그룹`, `RDS 데이터베이스`, `RDS 클러스터`, `ElastiCache 클러스터`, `ElastiCache 복제 그룹`, `ElastiCache 서버리스`, `Lambda 함수`, `ECR 저장소`, `ECS 클러스터`, `ECS 서비스`, `EKS 클러스터`, `DynamoDB 테이블`, `IAM 사용자`, `IAM 역할`.
  - `resourceEmoji(t): string`: 🪣 s3; 🖥️ ec2; 💽 ebs; 🛡️ sg; 🗄️ rds/elasticache/dynamodb; 🌐 network; ⚡ lambda; 📦 ecr/ecs/eks; 👤 iam.
  - `toolLabel(tool: ToolId, via?: string): string`. Map console → 콘솔, cli → CLI, terraform → Terraform, sdk → SDK, cloudformation → CloudFormation, autoscaling → Auto Scaling, other → 기타. When `via` is set and the tool isn't already that service, use `${via} 통해`.
  - `sentence(r: ChangeRecord): { who: string; rest: string }`. The person form is who=`sungyoon`, rest=`님이 S3 버킷을 만들었어요`. The auto form is who=`CloudFormation (CDK)`, rest=`이 보안그룹을 만들었어요`. Pick 을/를 and 이/가 by the final consonant (받침) of the label.
  - `summarySentence(s: ChangesResponse['summary'], range: RangeId): string`, e.g. "이번 주에 4개가 생기고 1개가 사라졌어요". Range words: 24h → 오늘, 7d → 이번 주에, 30d → 이번 달에, 90d → 최근 90일 동안, all → 지금까지. With zero changes: "{range} 생기거나 사라진 리소스가 없어요".
  - `kstTime(iso: string): string` → "오후 2:02".
  - `kstDayLabel(iso: string, now: Date): string` → "오늘 · 10월 26일" / "어제 · 10월 25일" / "10월 24일".
  - `groupByKstDay(records): Array<{label: string; records: ChangeRecord[]}>`

UI (match the mockup's left card):
- Page title area with the eyebrow-less title `summarySentence` (26px, bold) and a description line.
- 3 stat cards (생성 green, 삭제 red, 작업한 사람).
- Pill chips: range (24h/7일/30일/90일/전체), 전체/생성/삭제, then people facets and type facets, horizontally scrollable.
- A search box labelled "리소스 이름으로 찾기".
- Day groups, with rows showing a round 42px icon (green-soft for create, red-soft for delete, grey for auto/awsops), the sentence with the name bold, and a sub line `[생성]/[삭제] tag · resourceName||resourceId · toolLabel · kstTime`, then `›`.
- Clicking a row opens `ChangeDetailPanel`: time in KST full date, person, tool, IP, region, account alias, resource id/name, an AWS console link for s3/ec2/rds/security-group/lambda, and other records for the same resourceId.
- Status line: "기록 모으는 중 (처음 한 번, 최근 90일)" while backfilling, "마지막 수집 {kstTime}", "일부 계정 기록을 못 가져왔어요: {alias}". Empty state: "아직 기록이 없어요".
- Follows `useAccountContext().currentAccountId`.
- Wrap everything in a container whose `className` sets the Pretendard CSS variable, with the palette as Tailwind arbitrary values or a small CSS module. Avoid inline-style sprawl.

- [ ] Step 1: Write the failing tests in `format.test.ts`:
  - `sentenceParticles`: "S3 버킷을 만들었어요", "보안그룹을 지웠어요", "Lambda 함수를 만들었어요", with "이/가" for auto.
  - `summarySentenceRanges`
  - `kstTimeAmPm`: `2026-10-26T05:02:00Z` → "오후 2:02".
  - `dayLabelTodayYesterday`
  - `toolLabelVia`
- [ ] Step 2: Run `npx vitest run src/components/changes`. Expected: FAIL.
- [ ] Step 3: Implement `format.ts`, the API route, the page and the components. Add i18n keys `sidebar.changes` (ko "변경 기록", en "Changes", zh "变更记录") plus any UI labels not covered by `format.ts`, in all 3 files.
- [ ] Step 4: Run `npx vitest run src/components/changes`, `npx tsc --noEmit` and `npx next build`. Expected: PASS and "Compiled successfully".
- [ ] Step 5: Commit `feat(changes): Toss-style /changes page and API`.

### Task 6: "만든 사람" on S3/EC2/RDS

**Files:** Create `src/app/api/changes/creators/route.ts`, `src/components/changes/CreatorBadge.tsx`, `src/components/changes/useCreators.ts`, `src/components/changes/__tests__/creator-text.test.ts`. Modify `src/app/s3/page.tsx`, `src/app/ec2/page.tsx`, `src/app/rds/page.tsx`.

**Interfaces:**
- Consumes `findCreators` and `CreatorLookup` from Task 3, and `toolLabel` from Task 5's `format.ts`. If that isn't merged yet, add a local copy and note it for dedupe at integration.
- Produces:
  - `GET /api/changes/creators?ids=acct:resourceId[|createdAtISO],...` returns `CreatorLookup[]`. The optional `|createdAt` lets `too-old` be decided. It allows at most 200 ids and returns 400 when there are more or when an id is malformed. `key` in the response is `acct:resourceId`, without the date.
  - `useCreators(keys: string[]): Record<string, CreatorLookup>`, which batches and caches per mount and fetches only when keys change.
  - `CreatorBadge({ lookup }: { lookup?: CreatorLookup })`, the mockup's B style: an initial avatar (first char, colour hashed from the name) plus "**{name}**님이 만들었어요 · {M월 D일} · {toolLabel}". `too-old` shows "90일보다 오래돼서 기록이 없어요" and `none` shows "기록 없음", both in muted text. When `deletedAt` is set, append " · {M월 D일} 삭제됨".
  - `creatorText(lookup): string`, a pure function used by the badge and tested.

How each page builds its keys:
- S3: `${account_id}:${name}|${creation_date}`.
- EC2: `${account_id}:${instance_id}|${launch_time}`.
- RDS: `${account_id}:${db_instance_identifier}|${create_time}`.

If a row lacks `account_id`, use the host account id from `/api/steampipe` context, or skip the badge. Add a DataTable column `{ key: '__creator', label: t('changes.creator') }` whose `render` is `CreatorBadge`.

- [ ] Step 1: Write the failing tests `creatorTextFound`, `creatorTextTooOld`, `creatorTextNone` and `creatorTextDeleted`.
- [ ] Step 2: Run `npx vitest run src/components/changes/__tests__/creator-text.test.ts`. Expected: FAIL.
- [ ] Step 3: Implement it, add the `changes.creator` i18n key ("만든 사람" / "Created by" / "创建者"), and integrate the 3 pages.
- [ ] Step 4: Run the tests, `npx tsc --noEmit` and `npx next build`. Expected: PASS.
- [ ] Step 5: Commit `feat(changes): creator badge on S3, EC2 and RDS lists`.

### Task 7: Slack — who-question + 09:00 summary

**Files:** Create `src/lib/change-timeline/slack.ts` and `__tests__/slack.test.ts`. Modify `src/lib/slack-chatops/handle.ts` (add an optional `tryChangeQuestion?: (event: MentionEvent) => Promise<boolean>` to `HandleDeps` and call it right after `tryControl`), `src/lib/slack-chatops/bot.ts` (wire it in), and `src/lib/change-timeline/loop.ts` (register the summary hook from the bot).

**Interfaces:**
- Consumes:
  - `searchByText` and `readRecords`/`readState`/`writeState` from Task 3
  - `sentence`, `resourceTypeLabel`, `resourceEmoji`, `toolLabel` and `kstTime` from Task 5's `format.ts`, which is a pure module, so importing it from lib is fine
  - `getBotHandle` from `slack-chatops/alert.ts` and `config.slackAlertChannelId`
- Produces:
  - `detectWhoQuestion(text: string): { kind: 'create' | 'delete' | 'any'; target: string } | null`. It matches "누가" together with "만들/생성" (create), "지웠/지운/삭제" (delete), or neither (any). Mentions are stripped first. `target` is the first token that looks like a resource name or id (`[A-Za-z0-9][A-Za-z0-9._:/-]{2,}`) that isn't a Korean word.
  - `answerWho(q, records: ChangeRecord[]): string`, in Slack mrkdwn:
    - First line: "{emoji} *{who}{rest}*", for example "🪣 *sungyoon님이 만들었어요*".
    - Then "{resourceName} · {label}" and "{M월 D일 kstTime} · {toolLabel}".
    - Last line: "아직 있어요" or "{M월 D일} {who}님이 지웠어요".
    - Several resources: list up to 5 candidates.
    - None: "최근 90일 기록에서 `{target}`을(를) 찾지 못했어요".
  - `buildDailySummary(records: ChangeRecord[], dayKst: string): string | null`. It returns null when there are 0 records. Otherwise it gives "☀️ *어제 {c}개가 생기고 {d}개가 사라졌어요*" followed by per-person counts, people only, e.g. "jiwoo 생성 2 · sungyoon 생성 1 · minsu 삭제 1".
  - `maybeSendDailySummary(opts?: { now?: Date; post?: (text: string) => Promise<boolean> }): Promise<void>`:
    - At or after 09:00 KST, if `state.lastSummaryDay` isn't yesterday's KST date, it builds yesterday's summary.
    - It posts through the bot to `slackAlertChannelId`, then writes `lastSummaryDay` even when the summary is null, so it isn't recomputed every tick.
    - It skips silently when there is no bot or no channel.
  - `maybeHandleChangeQuestion(event: MentionEvent, deps: { reply: (text: string) => Promise<void> }): Promise<boolean>`

- [ ] Step 1: Write the failing tests:
  - `detectsWhoCreatedAndDeleted`: "moyeota-media 누가 만들었어?" gives `{create, 'moyeota-media'}`. "i-0abc12345 누가 지웠어" gives delete. "지금 켜진 EC2 뭐 있어?" gives null.
  - `answerFoundStillExists`
  - `answerFoundDeleted`
  - `answerNotFound`
  - `answerMultipleCandidates`
  - `dailySummaryCountsPeopleOnly`
  - `noSummaryWhenNoChanges`
  - `dailySummaryOncePerDay`: before 09:00 nothing is sent. At 09:05 one is sent. A second call that day sends nothing. The next day at 09:00 one is sent.
  - In the chatops handle test: `changeQuestionSkipsAi`.
- [ ] Step 2: Run them. Expected: FAIL.
- [ ] Step 3: Implement and wire it in. In `bot.ts`:
  - `tryChangeQuestion` calls `maybeHandleChangeQuestion(event, { reply: text => slack.postMessage({ channel, thread_ts, text }) })`.
  - After connecting, call `setDailySummaryHook(() => maybeSendDailySummary())`.
- [ ] Step 4: Run `npx vitest run src/lib/change-timeline src/lib/slack-chatops` and `npx tsc --noEmit`. Expected: PASS.
- [ ] Step 5: Commit `feat(changes): Slack who-question and daily summary`.

### Task 8 (controller): Integration, docs, deploy

- [ ] Cherry-pick all tasks onto `feature/change-timeline`. Dedupe any local copies noted in Task 6.
- [ ] Run `npx vitest run`, `npx tsc --noEmit` and `npx next build`. All must pass.
- [ ] Add `data/change-timeline/` to `.gitignore`.
- [ ] Write the new `src/lib/change-timeline/CLAUDE.md` and `src/components/changes/` docs, and update `src/lib/CLAUDE.md`, `src/components/CLAUDE.md` and `src/app/CLAUDE.md` (pages 44, APIs 26). In the root `CLAUDE.md`, update the stats and the key-file list.
- [ ] Run a whole-branch review, merge to main, deploy (`git pull → 03-build-deploy.sh → 09-start-all.sh`), then verify:
  - `/api/changes` returns records, including `moyeota-media` by `tjdgns9954`.
  - The S3 page shows the creator.
  - The Slack question gets an answer.
