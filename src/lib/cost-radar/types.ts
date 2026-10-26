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
export interface ExplainResponse {
  mode: 'snapshot' | 'timeline-only'; days: ExplainDays; fromDay: string; accountId: string;
  baseMonthly: number | null; currentMonthly: number; delta: number | null;
  causes: ExplainCause[]; unexplained: number | null; notes: string[];
}
