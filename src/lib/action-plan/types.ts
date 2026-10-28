// Safe AI actions — shared contract types. The LLM only proposes a PlannerOutput; everything after that
// (resolve, snapshot, policy, preview, approval, scoped execution, audit, undo) is deterministic code.
// 안전한 AI 실행 공용 타입. LLM은 계획만 제안하고, 그 뒤는 모두 결정적인 코드가 처리한다.
import type { ApprovalRecord, ControlConfig } from '@/lib/slack-control/types';

export type ActionKind = 'ec2.start' | 'ec2.stop' | 'tag.set' | 'tag.remove' | 'sg.ingress.add' | 'sg.ingress.remove';
export type ResourceType = 'instance' | 'security-group';

/** source: an IPv4/IPv6 CIDR or a security group id (sg-…). */
export interface IngressRule {
  protocol: 'tcp' | 'udp';
  fromPort: number;
  toPort: number;
  source: string;
  description?: string;
}

/** One planner step. `ref` is the user's own words for the target, copied verbatim — code resolves it. */
export interface PlannedStep {
  action: ActionKind;
  ref: string;
  key?: string;
  value?: string;
  rule?: IngressRule;
}

/** Validated planner output; alias sources are already expanded to CIDRs. */
export type PlannerOutput =
  | { kind: 'plan'; steps: PlannedStep[]; summary: string }
  | { kind: 'clarify'; question: string }
  | { kind: 'not-action' };

export interface Resource {
  type: ResourceType;
  id: string;
  name: string;
  groupName?: string;
  tags: Record<string, string>;
  /** instance only */
  state?: string;
  /** instance only */
  securityGroupIds?: string[];
}

export interface TargetRef {
  type: ResourceType;
  id: string;
  name: string;
}

export interface ResolvedStep {
  action: ActionKind;
  target: TargetRef;
  key?: string;
  value?: string;
  rule?: IngressRule;
  /** sg.ingress.remove: the exact rule to revoke (from the snapshot or an execution result). */
  ruleId?: string;
}

export interface SnapshotRule extends IngressRule {
  ruleId: string;
}

export interface ResourceSnapshot {
  type: ResourceType;
  id: string;
  name: string;
  tags: Record<string, string>;
  /** instance */
  state?: string;
  /** security group */
  ingress?: SnapshotRule[];
  /** security group */
  eniCount?: number;
  /** security group */
  attachedInstances?: Array<{ id: string; name: string }>;
}

/** By resource id. */
export type Snapshot = Record<string, ResourceSnapshot>;

/** What must be true right after a step ran — used by undo's overwrite guard. */
export type AfterCheck =
  | { kind: 'instance-state'; id: string; states: string[] }
  | { kind: 'tag'; id: string; key: string; value: string | null }
  | { kind: 'rule-present'; sgId: string; ruleId: string }
  | { kind: 'rule-absent'; sgId: string; rule: IngressRule };

export interface StepChange {
  index: number;
  step: ResolvedStep;
  before: string;
  after: string;
  /** Already in the wanted state — dropped from execution, shown as "이미 되어 있음". */
  noop: boolean;
  /** tag.set / tag.remove: the tag value before this step (null = the tag did not exist). Shown on the card. */
  previous?: string | null;
  /** Known before execution (tag.*, ec2.*, sg.ingress.remove); sg.ingress.add gets it from the result. */
  inverse?: ResolvedStep;
}

export interface StepResult {
  index: number;
  status: 'done' | 'failed' | 'not-run';
  requestId?: string;
  /** Error name only. */
  error?: string;
  inverse?: ResolvedStep;
  after?: AfterCheck;
}

export interface PolicyResult {
  ok: boolean;
  denials: string[];
}

export interface ActionRequest extends ApprovalRecord {
  prompt: string;
  summary: string;
  plannerRaw: unknown;
  /** Includes noop entries (shown as "이미 되어 있음"). */
  changes: StepChange[];
  /** Plan-time snapshot. */
  snapshot: Snapshot;
  policy: PolicyResult;
  permission: { ok: boolean; error?: string };
  /** Execution id this request undoes. */
  undoOf?: string;
  skippedForDrift?: string[];
  results?: StepResult[];
}

export interface ExecutionRecord {
  id: string;
  executedAt: string;
  requesterId: string;
  approverId: string;
  channel: string;
  threadTs: string;
  results: StepResult[];
  undoOf?: string;
}

export interface ActionPlanConfig {
  approval: ControlConfig;
  maxSteps: number;
  maxResources: number;
  maxBlastRadius: number;
  undoHours: number;
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
export interface Ec2Writer {
  run(step: ResolvedStep, dryRun: boolean): Promise<{ requestId?: string; ruleId?: string }>;
}

export type WriterFactory = (sessionLabel: string, sessionPolicy: object) => Promise<Ec2Writer>;
