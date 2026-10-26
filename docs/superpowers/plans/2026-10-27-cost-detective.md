# Cost Detective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain why the estimated monthly cost changed between two points in time. Show it as a ranked list of resource-level causes, each with who and when, on the Cost Radar page and in Slack.

**Architecture:**
- Cost Radar stores one daily per-resource price snapshot.
- An explain engine diffs a past snapshot against the live estimate and attributes each difference using change-timeline records.
- The change timeline gains the kinds stop/start/modify.
- There are two outputs: a UI panel and a Slack integration.

**Tech Stack:** Next.js 14, TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-cost-detective-design.md`. Implementers read §3 (defaults) and §4 (constraints).

## Global Constraints

- **Dates:** every date is a KST calendar day (`YYYY-MM-DD`), computed like `kstDay` in `src/lib/cost-radar/history.ts`.
- **Snapshots:**
  - Stored as `data/cost-radar/snapshots/YYYY-MM-DD.json` and kept for 40 days.
  - They use the existing `costRadarDir()`, so the `COST_RADAR_DATA_DIR` override applies in tests.
  - Written atomically, the same way as `store.ts`.
- **No new CloudTrail or Steampipe calls in the explain path.** It reads snapshots, change-timeline records and the cached radar estimate only.
- **The "Unexplained" amount must be shown:** `unexplained = delta − Σ cause.impact`, rounded to cents. Never hide it.
- **Never invent an actor.** When no matching change record exists, `actor` is undefined, and the UI says "누가 했는지 기록 없음".
- **The ChangeKind extension changes nothing that already exists:**
  - the `/changes` summary numbers (creates and deletes)
  - the creator badges (`findCreators`)
  - Slack "누가 만들었어" answers
- **Money:** amounts are USD per month. Display with `$` and 2 decimals, signed when it is a change: `+$38.00`, `−$12.40`.
- **App rules:**
  - every fetch goes to `/api/*`
  - components use default export
  - i18n keys go in all of `src/lib/i18n/translations/{ko,en,zh}.json`
  - API errors return the error name only, with `Cache-Control: no-store`
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Verify with** `npx vitest run`, `npx tsc --noEmit` and `npx next build`.

## Review Focus

1. **The first days after deploy have no snapshot yet.** The explain engine must return `mode: 'timeline-only'` with an honest notice, not an empty or zero answer. Test: Task 3 `noSnapshotFallsBackToTimelineMode`.
2. **A resource stopped and started inside the window.** Its price is unchanged, so it must not appear as a cause. Test: Task 3 `unchangedPriceIsNotACause`.
3. **"All" accounts while one account is missing from the base snapshot** (for example, it was added later). That account counts as base 0, and the gap is flagged in `notes`. Test: Task 3 `accountMissingInBaseIsNoted`.
4. **Records with the new kinds stop/start/modify reach Slack's who-answer.** The answer must still use only create/delete records and must not crash. Test: Task 5 `whoAnswerIgnoresStateKinds`.
5. **The daily summary on a day with no cost change, or with the explain engine failing.** The line is omitted, and the summary still sends. Test: Task 5 `summaryOmitsCostLineWhenSmallOrFailing`.

---

### Task 0 (controller): contract types

1. Add to `src/lib/cost-radar/types.ts`:

```ts
export interface SnapshotResource { id: string; name: string; category: CategoryId; monthly: number; detail: string }
/** One KST day: accountId → priced resources (monthly > 0 only). */
export type DailySnapshot = { day: string; accounts: Record<string, SnapshotResource[]> };
export type ExplainDays = 1 | 7 | 30;
export type CauseKind = 'added' | 'removed' | 'changed';
export interface ExplainCause {
  kind: CauseKind; accountId: string; resourceId: string; name: string; category: CategoryId;
  monthlyBefore: number | null; monthlyAfter: number | null; impact: number | null;   // null = price unknown (timeline mode deletions)
  action?: 'create' | 'delete' | 'stop' | 'start' | 'modify';                         // matched change-timeline kind
  actor?: { kind: 'person' | 'auto' | 'awsops' | 'root'; name: string };
  time?: string;                                                                         // ISO of the matched record
  detailBefore?: string; detailAfter?: string;
}
export interface ExplainResponse {
  mode: 'snapshot' | 'timeline-only'; days: ExplainDays; fromDay: string; accountId: string;
  baseMonthly: number | null; currentMonthly: number; delta: number | null;
  causes: ExplainCause[]; unexplained: number | null; notes: string[];
}
```

2. Change `ChangeKind` in `src/lib/change-timeline/types.ts` to `'create' | 'delete' | 'stop' | 'start' | 'modify'`.
3. Commit both.

### Task 1: Daily per-resource snapshots

**Files:** Create `src/lib/cost-radar/snapshots.ts` and `__tests__/snapshots.test.ts`. Modify `src/lib/cost-radar/history.ts` (`recordDailyIfMissing`).

**Produces:**
- `toSnapshotResources(e: Estimate): SnapshotResource[]`: priced resources with `monthly > 0`, mapped to the snapshot fields.
- `writeSnapshotAccount(day: string, accountId: string, resources: SnapshotResource[]): Promise<void>`: merges into that day's file and keeps the other accounts. Writes are serialized and atomic.
- `readSnapshot(day: string): Promise<DailySnapshot | null>`
- `listSnapshotDays(): Promise<string[]>`: sorted ascending.
- `pruneSnapshots(now: Date): Promise<void>`: removes files older than 40 KST days.

**Behaviour:**
- `recordDailyIfMissing` builds the estimate per account as it does now. Right after `recordEstimate` for an account, it also calls `writeSnapshotAccount` with that same estimate, but only when the estimate has no warnings. Partial snapshots are skipped, the same rule as partial history.
- It calls `pruneSnapshots` once per run.
- It still never throws.

- [ ] Step 1: Write the failing tests:
  - `toSnapshotResourcesKeepsPricedOnly`
  - `writeMergesAccountsInOneDay`
  - `readMissingDayIsNull`
  - `listDaysSorted`
  - `prunesOlderThan40Days`
  - `dailyRecordWritesSnapshotForCompleteEstimatesOnly`, using the existing `DailyDeps` injection with a fake `collectInventory`
- [ ] Step 2: Run them. Expected: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `npx vitest run src/lib/cost-radar` and `npx tsc --noEmit`. Expected: green.
- [ ] Step 5: Commit `feat(cost-radar): daily per-resource cost snapshots`.

### Task 2: Change timeline: stop / start / modify kinds

**Files:**
- Modify in `src/lib/change-timeline/`: `catalog.ts`, `parse.ts` and its tests.
- Modify `src/app/api/changes/route.ts` (the `KINDS` set).
- Modify in `src/components/changes/`: `format.ts` and its tests, `ChangeRow.tsx` (KindTag), `ChangeFilters.tsx` (chips).
- Modify the i18n files.
- Do NOT touch `src/lib/change-timeline/slack.ts`. Task 5 owns it.

**Behaviour:**
- **Catalog** adds:
  - EC2 `StopInstances`/`StartInstances` (`ec2.amazonaws.com`): stop/start, resource `ec2-instance`
  - `ModifyInstanceAttribute`: modify, ec2-instance
  - RDS `StopDBInstance`/`StartDBInstance`: stop/start, rds-instance
  - `ModifyDBInstance`: modify, rds-instance
  - EBS `ModifyVolume`: modify, ebs-volume
  - All of these are in region ap-northeast-2.
- **Parse:**
  - `ModifyInstanceAttribute` yields a record only when `requestParameters.instanceType` is present. Other attribute changes return `[]`.
  - Stop/Start take ids from `requestParameters.instancesSet.items[].instanceId`, one record each.
- **The summary counts in `query.ts` stay create/delete only.** Don't change query.ts beyond what compiles.
- **format.ts sentence verbs:**
  - stop: "…를 껐어요"
  - start: "…를 켰어요"
  - modify: "…의 설정을 바꿨어요"
  - The person and auto forms work as they do today.
- **KindTag:**
  - stop: grey-blue tag "끄기"
  - start: green "켜기"
  - modify: blue `#4593fc` "변경"
  - The row icon background follows the same colours.
- **Filter chips:** 전체 / 생성 / 삭제 / 켜기·끄기 / 변경. The 켜기·끄기 chip maps to kind stop OR start. Extend the API to accept `kind=state`, meaning stop|start, by mapping it in the route to a kinds list. If `ChangesQuery` needs `kinds?: ChangeKind[]`, add it as an optional field. Add the i18n keys.

- [ ] Step 1: Write the failing tests:
  - `stopStartYieldOneRecordPerInstance`
  - `modifyInstanceAttributeOnlyForInstanceType`
  - `rdsStopStartModify`
  - `modifyVolume`
  - format `stateVerbs` covering 껐어요/켰어요/설정을 바꿨어요, and the auto form
  - route `kindStateMapsToStopStart`
  - query `summaryStillCountsCreateDeleteOnly`
- [ ] Step 2: Run them. Expected: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `npx vitest run src/lib/change-timeline src/components/changes src/app/api/changes`, then `npx tsc --noEmit`. Expected: green.
- [ ] Step 5: Commit `feat(changes): track stop, start and modify`.

### Task 3: Explain engine + API

**Files:** Create `src/lib/cost-radar/explain.ts`, `src/lib/cost-radar/__tests__/explain.test.ts`, `src/app/api/cost-radar/explain/route.ts` and `src/app/api/cost-radar/explain/__tests__/route.test.ts`.

**Consumes:**
- Task 0 types
- Task 1 `readSnapshot` and `listSnapshotDays` (inject them via deps; don't import concrete IO in tests)
- change-timeline `readRecords(from, to)`
- the live estimate: `getRadarResponse(accountId, deps)` from `src/lib/cost-radar/radar.ts`, which returns `{estimate}`

**Produces:**
- `explainChange(q: { accountId: string; days: ExplainDays; now?: Date }, deps?: ExplainDeps): Promise<ExplainResponse>`
- `ExplainDeps = { readSnapshot; listSnapshotDays; readRecords; liveEstimate: (accountId: string) => Promise<Estimate> }`. Defaults are wired to the real modules.

**Algorithm:**
1. `fromDay = kstDay(now − days)`.
2. Pick the base snapshot:
   - Use the snapshot for `fromDay`.
   - If that day is missing, use the nearest snapshot day ≥ `fromDay` that is before today, and add a note "기준일을 {day}로 맞췄어요".
   - If there is none, switch to timeline-only mode.
3. **Snapshot mode:**
   - Index base and live resources by `accountId:id`. Live resources are `estimate.resources` with `monthly > 0`.
   - Accounts: `__all__` means every account present in the live estimate. Any account missing from the base is noted with "기준일에 없던 계정: {id}" and counted as base 0.
   - Classify each resource:
     - added: live only, impact = after
     - removed: base only, impact = −before
     - changed: both, with `|after − before| ≥ 0.01`, impact = after − before
   - `delta = currentMonthly − baseMonthly`. `baseMonthly` is the sum of the base resources for the selected accounts.
   - `unexplained = round2(delta − Σimpact)`.
4. **Timeline-only mode:**
   - Read records from the start of `fromDay` (KST) to now.
   - A create record whose resource is live becomes "added", with impact = its live monthly.
   - A delete record becomes "removed", with impact null.
   - Stop/start/modify records on live resources become "changed", with impact null.
   - `baseMonthly`, `delta` and `unexplained` are null.
   - Add the note "아직 비교할 과거 스냅샷이 없어서 기록 기반으로 추정했어요".
5. **Attribution**, in both modes:
   - For each cause, find the newest non-failed record within the window that matches the account and the resource id (or, for s3-bucket, the resource name), with a matching kind:
     - added: create
     - removed: delete
     - changed: stop, start or modify
   - Set `action`, `actor` and `time` from it.
6. Sort causes by `|impact|` descending. Null impacts go last. Cap the list at 50 and note it when capped.

**API:** `GET /api/cost-radar/explain?accountId=<12-digit|__all__>&days=1|7|30` returns `ExplainResponse`. It returns 400 for bad input and 500 with the error name only. Responses are `no-store`.

- [ ] Step 1: Write the failing tests:
  - `addedRemovedChangedWithImpactsAndUnexplained`
  - `unchangedPriceIsNotACause`
  - `noSnapshotFallsBackToTimelineMode`
  - `nearestBaseDayIsUsedAndNoted`
  - `accountMissingInBaseIsNoted`
  - `attributionPicksNewestMatchingKind`
  - `noRecordMeansNoActor`
  - `s3MatchesByName`
  - `sortedByAbsImpactNullsLast`
  - `capsAt50`
  - route 400/200/500
- [ ] Step 2: Run them. Expected: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `npx vitest run src/lib/cost-radar src/app/api/cost-radar` and `npx tsc --noEmit`. Expected: green.
- [ ] Step 5: Commit `feat(cost-radar): explain engine and API`.

### Task 4: "돈 탐정" panel on the Cost Radar page

**Files:**
- Create in `src/components/cost-radar/`: `CostExplainPanel.tsx`, `explain-format.ts` and `__tests__/explain-format.test.ts`.
- Modify `src/components/cost-radar/CostRadarView.tsx` to render the panel below the existing two columns.
- Modify the i18n files.

**Consumes:** `ExplainResponse` (Task 0) from `GET /api/cost-radar/explain`.

**Produces, as pure functions in explain-format.ts:**
- `headline(r: ExplainResponse): string`:
  - "어제보다 / 지난 7일 동안 / 지난 30일 동안 월 예상 비용이 $45.00 늘었어요"
  - "…줄었어요"
  - "…거의 변화가 없어요" when `|delta| < 1`
  - timeline mode: "지난 7일 동안 생기거나 바뀐 리소스예요"
- `causeSentence(c: ExplainCause): string`:
  - "jiwoo님이 RDS moyeota-test-db를 만들었어요"
  - "k8s-practice를 껐어요"
  - with no actor: "{name}이(가) 새로 생겼어요" / "…사라졌어요" / "…금액이 바뀌었어요" plus " · 누가 했는지 기록 없음"
  - Reuse `resourceTypeLabel`-style Korean labels. Map the cost-radar category to a label (ec2 → EC2 서버, rds → RDS, storage → EBS, …).
- `money(n: number | null, signed: boolean): string`: `+$38.00` / `−$12.40` / `금액 알 수 없음`.

**UI:**
- Follow Cost Radar's existing v2 style, using the same tokens and fonts as `SavingsCard.tsx` and `RecommendationPanel.tsx`.
- Period chips: 어제 / 7일 / 30일, default 7일.
- The headline sentence is large.
- Each cause row shows: the signed amount with the colour by sign (an increase uses the existing warning/pink accent, a decrease uses lime) · the sentence · the date (M월 D일).
- An "설명되지 않은 변화 $3.00" line when it isn't null and `|x| ≥ 0.01`.
- Notes are shown as muted lines.
- The panel follows the account picker (`useAccountContext()`).
- Loading, error and empty states. Empty means "이 기간에 비용을 바꾼 리소스가 없어요".

- [ ] Step 1: Write the failing tests:
  - `headlineUpDownFlatTimeline`
  - `causeSentenceWithAndWithoutActor`
  - `causeSentenceStateVerbs`
  - `moneySignsAndUnknown`
- [ ] Step 2: Run them. Expected: FAIL.
- [ ] Step 3: Implement the panel and integrate it.
- [ ] Step 4: Run the tests, `npx tsc --noEmit` and `npx next build`. Expected: green.
- [ ] Step 5: Commit `feat(cost-radar): cost detective panel`.

### Task 5: Slack: morning cost line + "비용 왜 늘었어?"

**Files:**
- Create `src/lib/cost-radar/slack.ts` and `__tests__/slack.test.ts`.
- Modify `src/lib/change-timeline/slack.ts`.
- Modify `src/lib/slack-chatops/handle.ts` (add `tryCostQuestion?` after `tryChangeQuestion`) and `bot.ts` (wiring).

**Consumes:** `explainChange` (Task 3; inject it, don't import it in tests) and the `explain-format` text helpers (Task 4). If those aren't merged yet, write minimal local mrkdwn formatting and note it for dedupe.

**Produces:**
- `detectCostQuestion(text: string): boolean`. It is true when the text contains (비용|돈|요금|금액) together with (왜|늘|줄|변화|올랐|내렸). Mentions are stripped first.
- `answerCostQuestion(r: ExplainResponse): string`: Slack mrkdwn with the headline, the top 3 causes and the unexplained amount, with every name escaped (`&`, `<`, `>`).
- `costSummaryLine(r: ExplainResponse | null): string | null`. It returns null when `r` is null, the mode is timeline-only, or `|delta| < 1`. Otherwise: `💸 어제보다 월 예상 비용 +$45.00 — 가장 큰 원인: jiwoo님 RDS moyeota-test-db (+$38.00)`.
- `maybeHandleCostQuestion(event, deps: { reply; explain }): Promise<boolean>`

**change-timeline/slack.ts changes:**
- (a) The who-answer groups only create/delete records. Ignore stop/start/modify so they can't crash the `g.create ?? g.del!` logic. Keep today's output for create/delete exactly.
- (b) `maybeSendDailySummary` takes an optional `costLine?: () => Promise<string | null>`, which the bot wires to `explainChange({accountId: '__all__', days: 1})` → `costSummaryLine`. The cost line is appended when it isn't null. If the provider throws or times out after 20 s, the line is omitted, the summary still sends, and only the error name is logged.
- (c) Daily per-person counts stay create/delete only.

- [ ] Step 1: Write the failing tests:
  - `detectsCostQuestions`, with positives and negatives (e.g. "비용 레이더 링크 줘" gives false)
  - `answerHasHeadlineTop3AndUnexplained`
  - `costSummaryLineThresholdAndTimelineMode`
  - `whoAnswerIgnoresStateKinds`
  - `summaryOmitsCostLineWhenSmallOrFailing`
  - `summaryAppendsCostLine`
  - `costQuestionSkipsAi`, in the chatops handle test
- [ ] Step 2: Run them. Expected: FAIL.
- [ ] Step 3: Implement and wire it in.
- [ ] Step 4: Run `npx vitest run src/lib/cost-radar src/lib/change-timeline src/lib/slack-chatops` and `npx tsc --noEmit`. Expected: green.
- [ ] Step 5: Commit `feat(cost-radar): Slack cost question and morning cost line`.

### Task 6 (controller): integrate, docs, deploy

- [ ] Cherry-pick the tasks. Resolve the i18n union. Dedupe any local helpers.
- [ ] Run the full `vitest`, `tsc` and `next build`.
- [ ] Docs:
  - `src/lib/cost-radar/CLAUDE.md`: snapshots, explain
  - `src/lib/change-timeline/CLAUDE.md`: the new kinds
  - `src/components/cost-radar/CLAUDE.md` and `src/components/CLAUDE.md`
  - `src/app/CLAUDE.md`: the new API, which brings the API count to 27
  - root `CLAUDE.md` stats
- [ ] Run the final whole-branch review, then merge, deploy and verify:
  - On the server, `/api/cost-radar/explain?days=7` returns timeline-only mode with real create records.
  - The next day, the snapshot file exists.
  - Slack test.
