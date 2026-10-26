// Cost Detective — explain why the monthly estimate changed between a past KST day and now.
// 돈 탐정 — 과거 KST 날짜 대비 지금 월 예상 비용이 왜 바뀌었는지 리소스 단위 원인과 귀속(누가·언제)을 만든다.
// Reads snapshots, change-timeline records and the cached radar estimate only (no CloudTrail / Steampipe calls).
// 스냅샷·변경 기록·캐시된 레이더 추정치만 읽는다 (CloudTrail·Steampipe 추가 호출 없음).
import { kstDay } from './snapshots';
import { ALL_SCOPE } from './estimate';
import type {
  CategoryId, DailySnapshot, Estimate, ExplainCause, ExplainDays, ExplainResponse, PricedResource, SnapshotResource,
} from './types';
import type { ChangeKind, ChangeRecord, ResourceType } from '@/lib/change-timeline/types';

export interface ExplainDeps {
  readSnapshot: (day: string) => Promise<DailySnapshot | null>;
  listSnapshotDays: () => Promise<string[]>;
  readRecords: (from: Date, to: Date) => Promise<ChangeRecord[]>;
  liveEstimate: (accountId: string) => Promise<Estimate>;
}

export interface ExplainQuery { accountId: string; days: ExplainDays; now?: Date }

export const MAX_CAUSES = 50;
const DAY_MS = 86_400_000;

export const NOTE_TIMELINE_ONLY = '아직 비교할 과거 스냅샷이 없어서 기록 기반으로 추정했어요';
export const noteBaseDay = (day: string) => `기준일을 ${day}로 맞췄어요`;
export const noteMissingAccount = (id: string) => `기준일에 없던 계정: ${id}`;
export const noteCapped = (total: number, hiddenSum: number) =>
  `원인이 ${total}개라 금액 영향이 큰 ${MAX_CAUSES}개만 보여줘요 · 나머지 ${total - MAX_CAUSES}개 합계 ${signedUsd(hiddenSum)}`;

/** Signed money, the global format: +$38.00 / −$12.40 / $0.00. / 부호 있는 금액 표기. */
export function signedUsd(n: number): string {
  const v = Math.round(n * 100) / 100;
  const sign = v > 0 ? '+' : v < 0 ? '\u2212' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Which change-timeline kinds can explain each cause kind. A stopped EC2 leaves the estimate (removed) and a
 * started one enters it (added), so stop/start also explain removed/added.
 * 원인 종류별로 맞는 변경 기록 종류. 정지된 EC2는 추정에서 빠지고(removed) 시작되면 들어온다(added).
 */
const MATCHING_KINDS: Record<ExplainCause['kind'], ChangeKind[]> = {
  added: ['create', 'start'],
  removed: ['delete', 'stop'],
  changed: ['stop', 'start', 'modify'],
};

/** Cost category of a resource gone from the estimate in timeline mode; types without a fixed cost are skipped. / 비용 없는 종류는 제외. */
const TYPE_CATEGORY: Partial<Record<ResourceType, CategoryId>> = {
  'ec2-instance': 'ec2',
  'ebs-volume': 'storage',
  'ebs-snapshot': 'storage',
  'elastic-ip': 'public-ip',
  'nat-gateway': 'nat',
  'load-balancer': 'loadbalancer',
  'rds-instance': 'rds',
  'rds-cluster': 'rds',
  'elasticache-cluster': 'elasticache',
  'elasticache-replication-group': 'elasticache',
  'elasticache-serverless': 'elasticache',
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const key = (accountId: string, id: string) => `${accountId}:${id}`;

/** Start of a KST calendar day as an instant. / KST 날짜의 시작 시각. */
const kstDayStart = (day: string) => new Date(`${day}T00:00:00+09:00`);

async function defaults(): Promise<ExplainDeps> {
  return (await import('./explain-deps')).defaultExplainDeps();
}

/** Live priced resources (monthly > 0). / 가격이 있는(월 > 0) 실시간 리소스. */
function livePriced(e: Estimate): PricedResource[] {
  return e.resources.filter((r): r is PricedResource & { monthly: number } => typeof r.monthly === 'number' && r.monthly > 0);
}

/**
 * Accounts in scope. "All" = live accounts ∪ base-snapshot accounts, so an account whose resources were all
 * deleted still shows its removals. / 전체면 실시간 계정 ∪ 기준 스냅샷 계정 (전부 삭제된 계정의 사라짐도 보인다).
 */
function scopeAccounts(accountId: string, e: Estimate, base: DailySnapshot | null): string[] {
  if (accountId !== ALL_SCOPE) return [accountId];
  const ids = new Set<string>();
  for (const r of e.resources) ids.add(r.accountId);
  for (const r of e.unpriced) ids.add(r.accountId);
  if (base) for (const id of Object.keys(base.accounts)) ids.add(id);
  return Array.from(ids).sort();
}

/** Base snapshot: the fromDay one, else the nearest day ≥ fromDay before today. / 기준 스냅샷 선택. */
async function pickBase(fromDay: string, today: string, deps: ExplainDeps): Promise<{ snap: DailySnapshot; adjusted: boolean } | null> {
  const exact = await deps.readSnapshot(fromDay);
  if (exact) return { snap: exact, adjusted: false };
  const days = [...(await deps.listSnapshotDays())].sort();
  for (const day of days) {
    if (day <= fromDay || day >= today) continue;
    const snap = await deps.readSnapshot(day);
    if (snap) return { snap, adjusted: true };
  }
  return null;
}

function snapshotCauses(
  base: DailySnapshot, live: PricedResource[], accounts: string[], notes: string[],
): { causes: ExplainCause[]; baseMonthly: number } {
  const baseIdx = new Map<string, { accountId: string; r: SnapshotResource }>();
  for (const id of accounts) {
    const rs = base.accounts[id];
    if (!Array.isArray(rs)) {
      notes.push(noteMissingAccount(id));
      continue;
    }
    for (const r of rs) if (r.monthly > 0) baseIdx.set(key(id, r.id), { accountId: id, r });
  }
  const inScope = new Set(accounts);
  const liveIdx = new Map<string, PricedResource>();
  for (const r of live) if (inScope.has(r.accountId)) liveIdx.set(key(r.accountId, r.id), r);

  const causes: ExplainCause[] = [];
  for (const [k, after] of Array.from(liveIdx.entries())) {
    const b = baseIdx.get(k);
    const a = after.monthly as number;
    const common = { accountId: after.accountId, resourceId: after.id, name: after.name, category: after.category };
    if (!b) {
      causes.push({ kind: 'added', ...common, monthlyBefore: null, monthlyAfter: a, impact: round2(a), detailAfter: after.detail });
      continue;
    }
    const diff = round2(a - b.r.monthly);
    if (Math.abs(diff) < 0.01) continue;
    causes.push({
      kind: 'changed', ...common, monthlyBefore: b.r.monthly, monthlyAfter: a, impact: diff,
      detailBefore: b.r.detail, detailAfter: after.detail,
    });
  }
  let baseMonthly = 0;
  for (const [k, { accountId, r }] of Array.from(baseIdx.entries())) {
    baseMonthly += r.monthly;
    if (liveIdx.has(k)) continue;
    causes.push({
      kind: 'removed', accountId, resourceId: r.id, name: r.name, category: r.category,
      monthlyBefore: r.monthly, monthlyAfter: null, impact: round2(-r.monthly), detailBefore: r.detail,
    });
  }
  return { causes, baseMonthly: round2(baseMonthly) };
}

const IPV4_SUFFIX = '-ipv4';

/**
 * Does a change record refer to this estimate resource? Same account, then: S3 by bucket name; RDS ids
 * case-insensitively (records keep the request casing, Steampipe ids are lowercase, as in change-timeline query.ts);
 * a derived `${id}-ipv4` public-IP resource also matches its parent's record.
 * 변경 기록과 리소스 매칭: S3는 이름, RDS는 대소문자 무시, 파생 `-ipv4` 리소스는 부모 기록과도 매칭.
 */
export function recordMatches(rec: ChangeRecord, r: { accountId: string; resourceId: string; name: string }): boolean {
  if (rec.accountId !== r.accountId) return false;
  if (rec.resourceType === 's3-bucket') return rec.resourceName === r.name;
  const ids = [r.resourceId];
  if (r.resourceId.endsWith(IPV4_SUFFIX) && r.resourceId.length > IPV4_SUFFIX.length) {
    ids.push(r.resourceId.slice(0, -IPV4_SUFFIX.length));
  }
  if (/^rds-/.test(rec.resourceType)) {
    const want = rec.resourceId.toLowerCase();
    return ids.some((id) => id.toLowerCase() === want);
  }
  return ids.includes(rec.resourceId);
}

function timelineCauses(records: ChangeRecord[], live: PricedResource[]): ExplainCause[] {
  // Every live resource a record refers to (an instance and its derived -ipv4). / 기록이 가리키는 실시간 리소스 전부.
  const findLive = (rec: ChangeRecord) =>
    live.filter((r) => recordMatches(rec, { accountId: r.accountId, resourceId: r.id, name: r.name }));

  const added = new Map<string, ExplainCause>();
  const removed = new Map<string, ExplainCause>();
  const changed = new Map<string, ExplainCause>();
  for (const rec of records) {
    const ls = findLive(rec);
    if ((rec.kind === 'delete' || rec.kind === 'stop') && ls.length === 0) {
      // Gone from the estimate (deleted, or a stopped instance): price unknown. / 사라짐(삭제·정지), 금액 알 수 없음.
      const category = TYPE_CATEGORY[rec.resourceType];
      const k = key(rec.accountId, rec.resourceId);
      if (!category || removed.has(k)) continue;
      removed.set(k, {
        kind: 'removed', accountId: rec.accountId, resourceId: rec.resourceId, name: rec.resourceName || rec.resourceId,
        category, monthlyBefore: null, monthlyAfter: null, impact: null,
      });
      continue;
    }
    for (const l of ls) {
      const k = key(l.accountId, l.id);
      const a = l.monthly as number;
      if (rec.kind === 'create') {
        if (added.has(k)) continue;
        added.set(k, {
          kind: 'added', accountId: l.accountId, resourceId: l.id, name: l.name, category: l.category,
          monthlyBefore: null, monthlyAfter: a, impact: round2(a), detailAfter: l.detail,
        });
      } else if (rec.kind === 'stop' || rec.kind === 'start' || rec.kind === 'modify') {
        if (changed.has(k)) continue;
        changed.set(k, {
          kind: 'changed', accountId: l.accountId, resourceId: l.id, name: l.name, category: l.category,
          monthlyBefore: null, monthlyAfter: a, impact: null, detailAfter: l.detail,
        });
      }
    }
  }
  // A resource created in the window is "added" even if it was also stopped/started later. / 생성이 우선.
  const out = [...Array.from(added.values()), ...Array.from(removed.values())];
  for (const [k, c] of Array.from(changed.entries())) if (!added.has(k)) out.push(c);
  return out;
}

/** Newest non-failed matching record sets action/actor/time; no record means no actor. / 기록이 없으면 사람을 비운다. */
function attribute(causes: ExplainCause[], records: ChangeRecord[]): void {
  for (const c of causes) {
    const kinds = MATCHING_KINDS[c.kind];
    let best: ChangeRecord | null = null;
    for (const rec of records) {
      if (!kinds.includes(rec.kind) || !recordMatches(rec, c)) continue;
      if (!best || Date.parse(rec.time) > Date.parse(best.time)) best = rec;
    }
    if (!best) continue;
    c.action = best.kind;
    c.actor = { kind: best.actor.kind, name: best.actor.name };
    c.time = best.time;
  }
}

function byImpact(a: ExplainCause, b: ExplainCause): number {
  if (a.impact === null && b.impact === null) return a.name.localeCompare(b.name);
  if (a.impact === null) return 1;
  if (b.impact === null) return -1;
  return Math.abs(b.impact) - Math.abs(a.impact) || a.name.localeCompare(b.name);
}

/**
 * Explain the change of the monthly estimate over the last `days` KST days.
 * Snapshot mode diffs a past per-resource snapshot with the live estimate; with no snapshot yet it falls back
 * to timeline-only mode (change records only, base/delta/unexplained null).
 * 지난 N일(KST) 월 예상 비용 변화 설명. 스냅샷이 있으면 리소스 단위 비교, 없으면 변경 기록 기반 추정.
 */
export async function explainChange(q: ExplainQuery, deps?: Partial<ExplainDeps>): Promise<ExplainResponse> {
  const d: ExplainDeps = deps && deps.readSnapshot && deps.listSnapshotDays && deps.readRecords && deps.liveEstimate
    ? (deps as ExplainDeps)
    : { ...(await defaults()), ...(deps ?? {}) };
  const now = q.now ?? new Date();
  const fromDay = kstDay(new Date(now.getTime() - q.days * DAY_MS));
  const today = kstDay(now);
  const [estimate, base] = await Promise.all([d.liveEstimate(q.accountId), pickBase(fromDay, today, d)]);
  // Attribution window starts at the base day actually compared (a later one when adjusted). / 실제 기준일부터.
  const windowStart = kstDayStart(base ? base.snap.day : fromDay);
  const rawRecords = await d.readRecords(windowStart, now);
  const accounts = scopeAccounts(q.accountId, estimate, base ? base.snap : null);
  const inScope = new Set(accounts);
  const lo = windowStart.getTime();
  const hi = now.getTime();
  const records = rawRecords.filter((r) => {
    const t = Date.parse(r.time);
    return !r.failed && t >= lo && t <= hi && (q.accountId === ALL_SCOPE || inScope.has(r.accountId));
  });
  const live = livePriced(estimate);
  const currentMonthly = round2(estimate.monthly);
  const notes: string[] = [];

  let causes: ExplainCause[];
  let baseMonthly: number | null = null;
  let delta: number | null = null;
  let unexplained: number | null = null;
  if (base) {
    if (base.adjusted) notes.push(noteBaseDay(base.snap.day));
    const r = snapshotCauses(base.snap, live, accounts, notes);
    causes = r.causes;
    baseMonthly = r.baseMonthly;
    delta = round2(currentMonthly - baseMonthly);
    const explained = causes.reduce((s, c) => s + (c.impact ?? 0), 0);
    unexplained = round2(delta - explained);
  } else {
    notes.push(NOTE_TIMELINE_ONLY);
    causes = timelineCauses(records, live);
  }

  attribute(causes, records);
  causes.sort(byImpact);
  if (causes.length > MAX_CAUSES) {
    const hiddenSum = causes.slice(MAX_CAUSES).reduce((s, c) => s + (c.impact ?? 0), 0);
    notes.push(noteCapped(causes.length, hiddenSum));
    causes = causes.slice(0, MAX_CAUSES);
  }
  return {
    mode: base ? 'snapshot' : 'timeline-only',
    days: q.days, fromDay, accountId: q.accountId,
    baseMonthly, currentMonthly, delta, causes, unexplained, notes,
  };
}
