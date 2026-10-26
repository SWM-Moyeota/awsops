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
export const noteCapped = (total: number) => `원인이 ${total}개라 금액 영향이 큰 ${MAX_CAUSES}개만 보여줘요`;

/** Which change-timeline kinds can explain each cause kind. / 원인 종류별로 맞는 변경 기록 종류. */
const MATCHING_KINDS: Record<ExplainCause['kind'], ChangeKind[]> = {
  added: ['create'],
  removed: ['delete'],
  changed: ['stop', 'start', 'modify'],
};

/** Cost category of a deleted resource in timeline mode; types without a fixed cost are skipped. / 비용 없는 종류는 제외. */
const DELETE_CATEGORY: Partial<Record<ResourceType, CategoryId>> = {
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

/** Accounts in scope: every account present in the live estimate for "All". / 전체면 실시간 추정에 있는 모든 계정. */
function scopeAccounts(accountId: string, e: Estimate): string[] {
  if (accountId !== ALL_SCOPE) return [accountId];
  const ids = new Set<string>();
  for (const r of e.resources) ids.add(r.accountId);
  for (const r of e.unpriced) ids.add(r.accountId);
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

const recordMatches = (rec: ChangeRecord, c: Pick<ExplainCause, 'accountId' | 'resourceId' | 'name'>) =>
  rec.accountId === c.accountId &&
  (rec.resourceType === 's3-bucket' ? rec.resourceName === c.name : rec.resourceId === c.resourceId);

function timelineCauses(records: ChangeRecord[], live: PricedResource[]): ExplainCause[] {
  const liveIdx = new Map<string, PricedResource>();
  for (const r of live) liveIdx.set(key(r.accountId, r.id), r);
  const findLive = (rec: ChangeRecord) =>
    rec.resourceType === 's3-bucket'
      ? live.find((r) => r.accountId === rec.accountId && r.name === rec.resourceName)
      : liveIdx.get(key(rec.accountId, rec.resourceId));

  const added = new Map<string, ExplainCause>();
  const removed = new Map<string, ExplainCause>();
  const changed = new Map<string, ExplainCause>();
  for (const rec of records) {
    const l = findLive(rec);
    if (rec.kind === 'create' && l) {
      const k = key(l.accountId, l.id);
      if (added.has(k)) continue;
      const a = l.monthly as number;
      added.set(k, {
        kind: 'added', accountId: l.accountId, resourceId: l.id, name: l.name, category: l.category,
        monthlyBefore: null, monthlyAfter: a, impact: round2(a), detailAfter: l.detail,
      });
    } else if (rec.kind === 'delete' && !l) {
      const category = DELETE_CATEGORY[rec.resourceType];
      const k = key(rec.accountId, rec.resourceId);
      if (!category || removed.has(k)) continue;
      removed.set(k, {
        kind: 'removed', accountId: rec.accountId, resourceId: rec.resourceId, name: rec.resourceName || rec.resourceId,
        category, monthlyBefore: null, monthlyAfter: null, impact: null,
      });
    } else if ((rec.kind === 'stop' || rec.kind === 'start' || rec.kind === 'modify') && l) {
      const k = key(l.accountId, l.id);
      if (changed.has(k)) continue;
      changed.set(k, {
        kind: 'changed', accountId: l.accountId, resourceId: l.id, name: l.name, category: l.category,
        monthlyBefore: null, monthlyAfter: l.monthly as number, impact: null, detailAfter: l.detail,
      });
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
  const windowStart = kstDayStart(fromDay);

  const [estimate, base, rawRecords] = await Promise.all([
    d.liveEstimate(q.accountId),
    pickBase(fromDay, today, d),
    d.readRecords(windowStart, now),
  ]);
  const accounts = scopeAccounts(q.accountId, estimate);
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
    notes.push(noteCapped(causes.length));
    causes = causes.slice(0, MAX_CAUSES);
  }
  return {
    mode: base ? 'snapshot' : 'timeline-only',
    days: q.days, fromDay, accountId: q.accountId,
    baseMonthly, currentMonthly, delta, causes, unexplained, notes,
  };
}
