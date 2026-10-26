// Change timeline — contract types shared by ingest, store, query, API, UI and Slack.
// 변경 기록 공용 타입 (수집·저장·조회·API·화면·Slack이 함께 쓴다).
export type ChangeKind = 'create' | 'delete' | 'stop' | 'start' | 'modify';
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
