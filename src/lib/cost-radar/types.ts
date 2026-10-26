// Cost Radar shared types — used by pricing, inventory, estimate, recommendations, API and page.
// 비용 레이더 공용 타입 — 가격 계산, 인벤토리, 추정, 추천, API, 화면에서 공유.

export type CategoryId = 'ec2' | 'loadbalancer' | 'nat' | 'vpc-endpoint' | 'public-ip' | 'storage' | 'rds' | 'elasticache';
export type UnpricedReason = 'unknown-type' | 'non-linux' | 'dedicated' | 'other-region';

export interface PricedResource {
  id: string;
  name: string;
  accountId: string;
  region: string;
  category: CategoryId;
  detail: string;
  /** Monthly estimate in USD (730 h); null when unpriced. / 월 추정액(USD), 가격 미확인이면 null. */
  monthly: number | null;
  unpricedReason?: UnpricedReason;
  tags: Record<string, string>;
}

export interface CategoryTotal { id: CategoryId; monthly: number; percent: number; count: number; }

export interface Estimate {
  accountId: string;
  monthly: number;
  hourly: number;
  categories: CategoryTotal[];
  resources: PricedResource[];
  unpriced: PricedResource[];
  warnings: { category: CategoryId; message: string }[];
  /**
   * Priced categories whose query failed, per account (accounts with no failure are left out). Target groups have
   * no price and are never listed. / 계정별 조회 실패한 가격 카테고리 (타겟 그룹은 가격이 없어 제외).
   */
  accountErrors?: Record<string, CategoryId[]>;
  priceAsOf: string;
}

export type RuleId = 'unused-eip' | 'unattached-ebs' | 'long-stopped-ec2' | 'old-snapshot' | 'empty-lb' | 'empty-tg' | 'office-hours' | 'gp2-to-gp3';

export interface Recommendation {
  id: string;
  rule: RuleId;
  resourceId: string;
  accountId: string;
  region: string;
  params: Record<string, string | number>;
  monthlySaving: number;
  /** Whether the saving is included in the headline total (de-duplicated by resource id). / 합계 포함 여부. */
  countedInTotal: boolean;
  /** maybe-scaled-to-zero: ECS/EKS/ASG-managed empty TG/LB; managed-instance: ASG/EKS/ECS-owned EC2 (office hours). */
  note?: 'maybe-scaled-to-zero' | 'managed-instance';
  cliCommand: string;
  consoleUrl: string;
  tags: Record<string, string>;
}

export interface Savings { monthly: number; yearEndCurrent: number; yearEndAfter: number; }
export interface Trend { previousMonthly: number; changePercent: number; }

export interface RadarResponse {
  estimate: Estimate;
  recommendations: Recommendation[];
  savings: Savings;
  trend: Trend | null;
  accounts: { accountId: string; alias: string }[];
}

export interface CreatorInfo {
  resourceId: string;
  user: string | null;
  eventTime: string | null;
  status: 'found' | 'unknown';
}

/** One Steampipe row. / Steampipe 결과 한 행. */
export type Row = Record<string, unknown>;

/** Raw Steampipe rows of one account, before pricing. / 한 계정의 가격 계산 전 원본 행. */
export interface RawInventory {
  accountId: string;
  instances: Row[];
  volumes: Row[];
  snapshots: Row[];
  eips: Row[];
  nats: Row[];
  albs: Row[];
  nlbs: Row[];
  endpoints: Row[];
  rds: Row[];
  elasticache: Row[];
  targetGroups: Row[];
  /** Per-category query failure messages. / 카테고리별 조회 실패 메시지. */
  errors: Partial<Record<CategoryId | 'target-groups', string>>;
}

// ── Cost Detective (explain why the monthly estimate changed) / 돈 탐정 ──
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
/**
 * Part of the scope left out of both sides of the diff: a category/account the live estimate could not read this
 * time, or an account missing from the base snapshot. / 비교 양쪽에서 뺀 범위 (이번 조회 실패, 기준일에 없던 계정).
 */
export interface ExplainExclusion { accountId?: string; category?: CategoryId; reason: 'query-failed' | 'not-in-base' }
export interface ExplainResponse {
  mode: 'snapshot' | 'timeline-only'; days: ExplainDays; fromDay: string; accountId: string;
  /** In snapshot mode, base and current cover the compared scope only (exclusions left out of both). */
  baseMonthly: number | null; currentMonthly: number; delta: number | null;
  causes: ExplainCause[]; unexplained: number | null; notes: string[];
  /** Snapshot day actually compared (later than fromDay when adjusted); snapshot mode only. / 실제 비교한 기준일. */
  baseDay?: string;
  /** Present (non-empty) only when part of the scope was left out — partial data. / 일부를 뺐을 때만 있음. */
  excluded?: ExplainExclusion[];
}
