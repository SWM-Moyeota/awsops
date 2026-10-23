# Cost Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/cost-radar` page that estimates the monthly cost of what is running right now (Seoul on-demand prices, bundled), highlights the expensive parts visually, and lists cleanup recommendations with creator, CLI command and console link — guidance only, no actions.

**Architecture:** Pure TypeScript core in `src/lib/cost-radar/` (price table + pricing functions → estimate from Steampipe rows → recommendation rules → savings/trend), thin I/O around it (Steampipe collection, CloudTrail creator lookup, daily history file), two API routes, and one client page styled after the approved v2 mockup. A local Python script builds the compact price JSON from AWS's public bulk price list.

**Tech Stack:** Next.js 14 App Router, TypeScript, vitest, `@aws-sdk/client-cloudtrail` + `@aws-sdk/client-sts` (3.1030.0), Recharts or CSS conic-gradient, `next/font/google` (Archivo Black, Caveat), Python 3 stdlib.

**Spec:** `docs/superpowers/specs/2026-10-24-cost-radar-design.md` · mockup `docs/superpowers/specs/assets/2026-10-24-cost-radar-mockup-v2.html`

## Global Constraints

- Guidance only: no button anywhere that stops, deletes or modifies an AWS resource.
- Always visible on the page: "실제 청구액이 아닌 추정입니다. 데이터 전송·요청량 등 사용량 기반 비용은 포함되지 않습니다. 가격표 기준일 YYYY-MM-DD." (i18n'd in ko/en/zh).
- Prices: bundled `src/lib/cost-radar/prices.ap-northeast-2.json` only; no Pricing API at runtime (SCP denies it). EC2 = Linux, Shared tenancy, on-demand. Non-Linux, Dedicated, other regions, unknown types → unpriced, excluded from totals, listed.
- `HOURS_PER_MONTH = 730`. Office-hours saving factor `1 - 50/168`. gp2→gp3 saving `20%`. Long-stopped EC2 `>= 7 days`. Old snapshot `>= 90 days`. Snapshot price = upper bound (volume size).
- Year-end comparison: remaining months = remaining days until Dec 31 (KST) ÷ 30.4.
- Savings dedupe key = resource ID, keep the larger saving; EBS attached to a long-stopped EC2 is counted only under that EC2's recommendation; ECS/EKS/ASG-managed empty target groups are shown with note `maybe-scaled-to-zero` and never counted.
- Creator lookup: CloudTrail `LookupEvents` via AWS SDK (`AttributeKey=ResourceName`), host account with the server role, target accounts via `AWSopsReadOnlyRole` + `config.crossAccountExternalId`; ≤ 1 request/second per account; persistent cache `data/cost-radar/creators.json` (found = forever, unknown = retry after 24 h).
- History: `data/cost-radar/history.json`, one entry per account per KST day, keep 90 days; "All" trend = sum of accounts; trend shown only if an entry from 7 days earlier exists. Written once per day from the health monitor loop.
- Both `data/cost-radar/*.json` paths gitignored. All DB access through `src/lib/steampipe.ts` `runQuery(sql, { accountId })`; never the Steampipe CLI. fetch URLs `/api/*`; components default-export; i18n keys in all of `src/lib/i18n/translations/{ko,en,zh}.json` (insert textually — do not re-serialize the files, they contain blank-line section breaks).
- Visual (page only): background `#0b0b0d`, cards `#17171a`, accents lime `#D6F25C`, pink `#F26DB0`, purple `#B583F7`, orange `#F7A23B`, sky `#8EC5FF`, gray `#9CA3AF`; Archivo Black for numbers/headings, Caveat for accents, card radius 22–26px. Fonts loaded only on this page via `next/font/google`.
- Account labels come from `config.json` `alias`. First page load ≤ 10 s; API responses cached 5 min keyed by account.
- Never run `cdk deploy`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. An account with no billable resources (Moyeota today: 1 VPC, 0 EC2) → `$0`, no `NaN%`, empty-state copy, no recommendations crash. → Task 2 `emptyAccountHasZeroTotalsAndNoNaN`, Task 6 renders it.
2. One Steampipe table fails in a target account (SCP / not enabled) → partial estimate with a per-category warning, not a 500. → Task 2 `tableErrorYieldsPartialEstimateWithWarning`.
3. CloudTrail throttling or AssumeRole failure during creator lookup → those IDs become `unknown` (retried after 24 h); the page still renders. → Task 4 `throttledLookupBecomesUnknownAndIsRetriedLater`.
4. An instance type the bundled table doesn't know (new family) → unpriced `unknown-type`, excluded from totals, listed. → Task 1 `unknownInstanceTypeIsUnpriced`.
5. `state_transition_time` empty or in an unexpected format → that instance is skipped by the long-stopped rule, no throw. → Task 3 `unparseableTransitionTimeIsSkipped`.

---

### Task 1: Types, price table and pricing functions

**Files:**
- Create: `src/lib/cost-radar/types.ts`, `src/lib/cost-radar/pricing.ts`, `src/lib/cost-radar/prices.ap-northeast-2.json`, `scripts/tools/build-price-table.py`, `src/lib/cost-radar/CLAUDE.md`
- Test: `src/lib/cost-radar/__tests__/pricing.test.ts`
- Modify: `.gitignore` (add `data/cost-radar/`)

**Interfaces — Produces (types.ts, used by every later task):**
```ts
export type CategoryId = 'ec2' | 'loadbalancer' | 'nat' | 'vpc-endpoint' | 'public-ip' | 'storage' | 'rds' | 'elasticache';
export type UnpricedReason = 'unknown-type' | 'non-linux' | 'dedicated' | 'other-region';
export interface PricedResource { id: string; name: string; accountId: string; region: string; category: CategoryId; detail: string; monthly: number | null; unpricedReason?: UnpricedReason; tags: Record<string, string>; }
export interface CategoryTotal { id: CategoryId; monthly: number; percent: number; count: number; }
export interface Estimate { accountId: string; monthly: number; hourly: number; categories: CategoryTotal[]; resources: PricedResource[]; unpriced: PricedResource[]; warnings: { category: CategoryId; message: string }[]; priceAsOf: string; }
export type RuleId = 'unused-eip' | 'unattached-ebs' | 'long-stopped-ec2' | 'old-snapshot' | 'empty-lb' | 'empty-tg' | 'office-hours' | 'gp2-to-gp3';
export interface Recommendation { id: string; rule: RuleId; resourceId: string; accountId: string; region: string; params: Record<string, string | number>; monthlySaving: number; countedInTotal: boolean; note?: 'maybe-scaled-to-zero'; cliCommand: string; consoleUrl: string; tags: Record<string, string>; }
export interface Savings { monthly: number; yearEndCurrent: number; yearEndAfter: number; }
export interface Trend { previousMonthly: number; changePercent: number; }
export interface RadarResponse { estimate: Estimate; recommendations: Recommendation[]; savings: Savings; trend: Trend | null; accounts: { accountId: string; alias: string }[]; }
export interface CreatorInfo { resourceId: string; user: string | null; eventTime: string | null; status: 'found' | 'unknown'; }
```
**Produces (pricing.ts):** `HOURS_PER_MONTH = 730`; `priceAsOf(): string`; and pure functions each returning `{ monthly: number } | { monthly: null; reason: UnpricedReason }`:
`priceEc2({ instanceType, platformDetails, tenancy, region })`, `priceEbs({ volumeType, sizeGb, iops, throughput, region })`, `priceSnapshot({ sizeGb, region })`, `pricePublicIp({ region })`, `priceNat({ region })`, `priceLb({ type: 'application' | 'network', region })`, `priceVpcEndpoint({ azCount, region })`, `priceRds({ engine, instanceClass, multiAz, storageType, allocatedGb, iops, region })`, `priceElastiCache({ nodeType, nodes, region })`.

- [ ] **Step 1: Write `scripts/tools/build-price-table.py`** — stdlib only; reads `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<Offer>/current/region_index.json`, downloads the ap-northeast-2 CSV for `AmazonEC2`, `AmazonVPC`, `AWSELB`, `AmazonRDS`, `AmazonElastiCache`, streams it (EC2 CSV ≈ 200 MB — never load fully into memory), keeps only OnDemand USD rows needed by the functions above, and writes the JSON with `asOf` = the offer's publication date. Run it locally; commit the JSON (expect ≤ 300 KB).
- [ ] **Step 2: Sanity-check the JSON** — `python3 -c` print of `ec2["t4g.xlarge"]`, `natHour`, `lbHour.application`, `vpcEndpointHour`, `publicIpv4Hour`, `ebs.gbMonth.gp3`; compare with the AWS public pricing pages (Seoul) and record the comparison in the report. Each must match the public page exactly.
- [ ] **Step 3: Write failing tests** in `pricing.test.ts`:
  - `ec2LinuxSharedIsHourlyTimes730`: `priceEc2({instanceType:'t4g.xlarge', platformDetails:'Linux/UNIX', tenancy:'default', region:'ap-northeast-2'}).monthly` equals `table.ec2['t4g.xlarge'] * 730` (to 2 decimals).
  - `unknownInstanceTypeIsUnpriced`: type `'zz9.huge'` → `{ monthly: null, reason: 'unknown-type' }`.
  - `windowsIsUnpriced` (`'Windows'` → `non-linux`), `dedicatedIsUnpriced` (`tenancy:'dedicated'` → `dedicated`), `otherRegionIsUnpriced` (`'us-east-1'` → `other-region`, for every price function).
  - `gp3ExtraIopsAndThroughputAreAdded`: 100 GB, 4000 IOPS, 250 MB/s → size×gp3 + 1000×iopsRate + 125×throughputRate.
  - `snapshotUsesVolumeSize`, `vpcEndpointMultipliesAz` (azCount 2 → 2×hour×730), `rdsMultiAzDoubles`.
- [ ] **Step 4:** `npx vitest run src/lib/cost-radar/__tests__/pricing.test.ts` → FAIL (module missing).
- [ ] **Step 5:** Implement `types.ts` and `pricing.ts` (JSON imported statically).
- [ ] **Step 6:** Tests PASS; `npx tsc --noEmit -p .` clean.
- [ ] **Step 7:** Write `src/lib/cost-radar/CLAUDE.md` (bilingual), add `data/cost-radar/` to `.gitignore`, commit `feat(cost-radar): price table and pricing functions`.

### Task 2: Collection and estimate

**Files:**
- Create: `src/lib/cost-radar/collect.ts`, `src/lib/cost-radar/estimate.ts`
- Test: `src/lib/cost-radar/__tests__/estimate.test.ts`

**Interfaces:**
- Consumes: Task 1 types and pricing functions.
- Produces:
  ```ts
  // collect.ts — raw rows per table; never throws
  export interface RawInventory { accountId: string; instances: Row[]; volumes: Row[]; snapshots: Row[]; eips: Row[]; nats: Row[]; albs: Row[]; nlbs: Row[]; endpoints: Row[]; rds: Row[]; elasticache: Row[]; targetGroups: Row[]; errors: Partial<Record<CategoryId | 'target-groups', string>>; }
  export async function collectInventory(accountId: string): Promise<RawInventory>; // accountId = 12-digit id; runQuery(sql, { accountId })
  // estimate.ts — pure
  export function buildEstimate(inv: RawInventory[], scopeAccountId: string): Estimate; // scope '__all__' merges
  ```
- Verified Steampipe columns (use exactly): `aws_ec2_instance(instance_id, instance_type, instance_state, state_transition_time, platform_details, placement_tenancy, tags, account_id, region)`, `aws_ebs_volume(volume_id, volume_type, size, iops, throughput, state, attachments, tags, account_id, region)`, `aws_ebs_snapshot(snapshot_id, volume_id, volume_size, start_time, owner_id, tags, account_id, region)` (only snapshots where `owner_id = account_id`), `aws_vpc_eip(allocation_id, association_id, instance_id, public_ip, tags, account_id, region)`, `aws_vpc_nat_gateway(nat_gateway_id, state, tags, account_id, region)` (state `available`), `aws_ec2_application_load_balancer` / `aws_ec2_network_load_balancer(arn, name, state_code, tags, account_id, region)`, `aws_vpc_endpoint(vpc_endpoint_id, vpc_endpoint_type, service_name, state, subnet_ids, tags, account_id, region)` (Interface only; azCount = subnet count), `aws_rds_db_instance(db_instance_identifier, class, engine, multi_az, allocated_storage, storage_type, iops, tags, account_id, region)`, `aws_elasticache_cluster(cache_cluster_id, cache_node_type, num_cache_nodes, engine, tags, account_id, region)`, `aws_ec2_target_group(target_group_arn, target_group_name, load_balancer_arns, target_health_descriptions, tags, account_id, region)`.
- Category mapping: running EC2 → `ec2`; ALB/NLB → `loadbalancer`; NAT → `nat`; Interface endpoints → `vpc-endpoint`; EIP → `public-ip`; EBS volumes + snapshots → `storage`; RDS → `rds`; ElastiCache → `elasticache`. Stopped EC2 cost 0 (its volumes are in storage). `name` = tag `Name` else ID. `hourly = monthly / 730`. Categories sorted by monthly desc; `percent` rounded to integer, 0 when total is 0.

- [ ] **Step 1: Write failing tests** (fixtures as plain row objects, mock nothing but rows):
  - `runningEc2AndNatAndAlbAreSummedPerCategory`.
  - `stoppedEc2CostsZeroButItsVolumesCount`.
  - `emptyAccountHasZeroTotalsAndNoNaN`: all arrays empty → `monthly 0`, every `percent` 0, `categories` empty.
  - `tableErrorYieldsPartialEstimateWithWarning`: `errors.elasticache = 'AccessDenied'` → other categories priced, `warnings` contains `{ category: 'elasticache' }`.
  - `allScopeMergesAccountsAndKeepsAccountIds`: two inventories → resources from both, `estimate.accountId === '__all__'`.
  - `unpricedResourcesAreListedNotSummed`: one Windows instance → in `unpriced`, not in `monthly`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `collect.ts` (one `runQuery` per table, failures recorded in `errors`, all in parallel) and `buildEstimate`. **Step 4:** Run → PASS, `tsc` clean.
- [ ] **Step 5:** Commit `feat(cost-radar): inventory collection and estimate`.

### Task 3: Recommendation rules (and shared idle SQL)

**Files:**
- Create: `src/lib/cost-radar/recommend.ts`, `src/lib/queries/idle-resources.ts`
- Modify: `src/lib/collectors/idle-scan.ts` (import shared SQL; replace its hard-coded $ estimates with Task 1 pricing functions; keep its output format and prompts), `src/lib/queries/CLAUDE.md`, `src/lib/CLAUDE.md`
- Test: `src/lib/cost-radar/__tests__/recommend.test.ts`

**Interfaces:**
- Consumes: Task 1 types/pricing, Task 2 `RawInventory`.
- Produces:
  ```ts
  export function recommend(inv: RawInventory[], now: Date): Recommendation[];
  export function summarizeSavings(recs: Recommendation[], monthlyTotal: number, now: Date): Savings;
  export function parseStateTransitionTime(s: string | null | undefined): Date | null; // "User initiated (2026-10-23 12:58:30 GMT)"
  ```
- Rules (exact): spec §5.2 table. `params` carry what the UI needs (e.g. `{ publicIp, since }`, `{ days }`, `{ sizeGb }`). `cliCommand` examples: `aws ec2 release-address --allocation-id <id> --region <r>`, `aws ec2 delete-volume --volume-id <id> --region <r>`, `aws ec2 terminate-instances --instance-ids <id> --region <r>`, `aws ec2 delete-snapshot --snapshot-id <id> --region <r>`, `aws elbv2 delete-load-balancer --load-balancer-arn <arn> --region <r>`, `aws elbv2 delete-target-group --target-group-arn <arn> --region <r>`, `aws ec2 modify-volume --volume-id <id> --volume-type gp3 --region <r>`; office-hours command is a link/guide, not a stop command. `consoleUrl` = region-scoped console deep link for the resource. Empty TG = `target_health_descriptions` empty array; managed = tag key starting `aws:ecs:`, `elbv2.k8s.aws/`, or `aws:autoscaling:` → `note: 'maybe-scaled-to-zero'`, `countedInTotal: false`. Empty LB = every TG whose `load_balancer_arns` contains it is empty (or it has none).

- [ ] **Step 1: Write failing tests:**
  - one test per rule firing on a minimal fixture and NOT firing on its negative (e.g. `associatedEipNotRecommended`).
  - `longStoppedUsesTransitionDate`: stopped 2026-10-01, now 2026-10-24 → fires with `params.days === 23`; stopped 3 days ago → none.
  - `unparseableTransitionTimeIsSkipped`: `''`, `null`, `'weird'` → no recommendation, no throw.
  - `ebsOnLongStoppedInstanceCountedOnlyUnderInstance`: gp2 volume attached to a long-stopped instance → instance rec `countedInTotal true`, gp2 rec present with `countedInTotal false`.
  - `dedupeKeepsLargerSavingPerResource`.
  - `managedEmptyTargetGroupHasNoteAndIsNotCounted`.
  - `officeHoursSavingFactor`: monthly 100 → saving `100 * (1 - 50/168)` (2 decimals).
  - `yearEndUsesFractionalMonths`: now 2026-10-24 KST, total 268, savings 112 → remaining = days to 2026-12-31 ÷ 30.4; check both figures.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; move idle SQL into `idle-resources.ts` and make `idle-scan.ts` import it. **Step 4:** Run all vitest → PASS; `tsc` clean; `npx next lint --file src/lib/collectors/idle-scan.ts`.
- [ ] **Step 5:** Update the two CLAUDE.md files; commit `feat(cost-radar): cleanup recommendation rules; share idle SQL with idle-scan`.

### Task 4: Creator lookup and daily history

**Files:**
- Create: `src/lib/cost-radar/creators.ts`, `src/lib/cost-radar/history.ts`
- Modify: `src/lib/health/monitor.ts` (after `processResults` in the loop: `await recordDailyIfMissing()` wrapped so it can never throw or block the heartbeat), `package.json` (`@aws-sdk/client-cloudtrail@3.1030.0`)
- Test: `src/lib/cost-radar/__tests__/creators.test.ts`, `src/lib/cost-radar/__tests__/history.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 2 `collectInventory`, `buildEstimate`; `getConfig()` (`accounts`, `crossAccountExternalId`).
- Produces:
  ```ts
  // creators.ts
  export async function lookupCreators(items: { resourceId: string; accountId: string; region: string }[]): Promise<CreatorInfo[]>;
  // history.ts
  export function recordEstimate(hist: HistoryFile, e: Estimate, now: Date): HistoryFile; // pure; one entry per account per KST day, prune > 90 days
  export function trendFor(hist: HistoryFile, accountIds: string[], now: Date): Trend | null; // compares today's sum vs the entry 7 days earlier
  export async function recordDailyIfMissing(now?: Date): Promise<void>; // reads/writes data/cost-radar/history.json atomically
  export type HistoryFile = { entries: { accountId: string; day: string; monthly: number; categories: Record<string, number> }[] };
  ```
- Creator lookup: host account → `CloudTrailClient` with default creds; other accounts → STS `AssumeRole` (`AWSopsReadOnlyRole`, External ID from config, 15-min session, cached per account until 1 min before expiry) then CloudTrail client with those creds. Sequential per account with ≥ 1000 ms between calls; accounts in parallel. Picks the earliest event among `RunInstances | CreateVolume | CreateSnapshot | AllocateAddress | CreateLoadBalancer | CreateTargetGroup`; `user` = `Username` (or `userIdentity.arn` tail). Errors (throttling, AccessDenied, AssumeRole failure) → `status:'unknown'`. Cache file `data/cost-radar/creators.json` (atomic write): `found` forever, `unknown` retried after 24 h.

- [ ] **Step 1: Write failing tests** (`vi.mock` the SDK clients; inject `now`):
  - `foundCreatorIsCachedForever`, `unknownIsRetriedAfter24h`.
  - `throttledLookupBecomesUnknownAndIsRetriedLater`: `ThrottlingException` → `unknown`, and a second call within 24 h makes no SDK call.
  - `targetAccountAssumesRoleWithExternalId`, `callsArePacedOnePerSecondPerAccount` (fake timers: 3 IDs same account ⇒ ≥ 2000 ms elapsed).
  - `recordIsIdempotentPerDay`, `historyPrunedAfter90Days`, `trendNullWithout7DayOldEntry`, `trendSumsAccountsForAll`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; wire `recordDailyIfMissing` into the monitor loop (do not await Slack/heartbeat on it; time-box 60 s). **Step 4:** All vitest PASS (the existing 54 too), `tsc` clean.
- [ ] **Step 5:** Commit `feat(cost-radar): CloudTrail creator lookup and daily history`.

### Task 5: API routes

**Files:**
- Create: `src/app/api/cost-radar/route.ts`, `src/app/api/cost-radar/creators/route.ts`
- Modify: `src/app/CLAUDE.md` (API table + count, both languages)
- Test: `src/lib/cost-radar/__tests__/api.test.ts` (test an exported `buildRadarResponse(accountId, deps)` helper with injected deps)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `GET /api/cost-radar?accountId=<12-digit|__all__>` → `RadarResponse` (Task 1 type). Invalid id → 400. `__all__` = every account in `config.accounts`. Cached 5 min per accountId (node-cache, same TTL as Steampipe cache).
  - `GET /api/cost-radar/creators?ids=<accountId:region:resourceId,...>` (max 50) → `CreatorInfo[]`.
  - Both call `ensureHealthMonitorStarted()` like `/api/steampipe`.
- [ ] **Step 1: Write failing tests:** `allScopeUsesEveryConfiguredAccount`, `invalidAccountIdRejected`, `responseIsCachedFiveMinutes`, `creatorsEndpointCapsAt50`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS, `tsc`, `next lint` on the two routes.
- [ ] **Step 5:** Commit `feat(cost-radar): API routes`.

### Task 6: Page, home card, sidebar, i18n

**Files:**
- Create: `src/app/cost-radar/page.tsx`, `src/components/cost-radar/CostDonut.tsx`, `src/components/cost-radar/SavingsCard.tsx`, `src/components/cost-radar/RecommendationPanel.tsx`, `src/components/dashboard/CostRadarSummaryCard.tsx`, `src/components/cost-radar/CLAUDE.md`
- Modify: `src/components/layout/Sidebar.tsx` (monitoring group, under `/cost`: `{ labelKey: 'sidebar.costRadar', href: '/cost-radar', icon: Radar }`), `src/app/page.tsx` (add summary card), `src/lib/i18n/translations/{ko,en,zh}.json`, `src/components/CLAUDE.md`

**Interfaces:**
- Consumes: `RadarResponse`, `CreatorInfo` (Task 1), the two endpoints (Task 5), `useAccountContext().currentAccountId`.
- Layout and copy: follow the mockup file exactly in structure — header "지금 돈이 어디로 새고 있나?" (Caveat accent on the second half), left card (donut with total `$X.XX` big + trend pill only when `trend` non-null + category rows with colored circle icon, name, sub-line, amount, percent, ›; clicking a row expands its resources), right column ("아낄 수 있는 돈 월 $X", pill cards in lime/white/purple/pink rotation with icon, title, one-line reason, big `-$X`, and the year-end line), fixed disclaimer with `priceAsOf`, unpriced list collapsed at the bottom, warnings banner when `estimate.warnings` non-empty.
- `RecommendationPanel` (opens on card click): reason, creator (fetched lazily via `/api/cost-radar/creators`, shows "확인 중…" then name/time or "알 수 없음 (90일 이전)"), tags, "삭제 전 만든 사람에게 확인하세요", CLI command in a copy box with a Copy button (clipboard only), console link (opens new tab). **No action buttons.**
- Empty state (`monthly === 0`): "이 계정에는 켜 두기만 해도 과금되는 리소스가 없어요" and no right column cards.
- i18n keys (all three files, inserted textually): `sidebar.costRadar`, `costRadar.title`, `costRadar.titleAccent`, `costRadar.monthly`, `costRadar.hourly`, `costRadar.trend` (`{percent}`), `costRadar.savingsTitle` (`{amount}`), `costRadar.yearEnd` (`{current}`,`{after}`), `costRadar.disclaimer` (`{date}`), `costRadar.empty`, `costRadar.unpriced`, `costRadar.warning`, `costRadar.creator.checking`, `costRadar.creator.unknown`, `costRadar.confirmOwner`, `costRadar.copy`, `costRadar.openConsole`, `costRadar.category.<CategoryId>` (8), `costRadar.rule.<RuleId>.title` and `.reason` (16), `costRadar.note.maybeScaledToZero`, `dashboard.costRadarLabel`, `dashboard.costRadarChange` (`{saving}`).
- [ ] **Step 1:** Implement components and page; `next/font/google` for Archivo Black and Caveat applied to the page root only.
- [ ] **Step 2:** `npx tsc --noEmit -p .`, `npx next lint`, `npx vitest run`, `npx next build` all pass.
- [ ] **Step 3:** Local smoke: `npx next start -p 3100`, open `/cost-radar` (no Steampipe locally, so the API fails) → the page shows its error state without crashing. Stop the server. Real-data verification happens in Task 7.
- [ ] **Step 4:** Update CLAUDE.md files; commit `feat(cost-radar): page, home summary card and sidebar entry`.

### Task 7: Rollout and verification (controller + user)

- [ ] Rename host alias to `Sandbox` in the server's `data/config.json`.
- [ ] Push; on EC2 `git pull && bash scripts/03-build-deploy.sh && bash scripts/09-start-all.sh`.
- [ ] Spec §7 checks 1–7 on the real server; record results (incl. a hand calculation for check 1).
