// tf-export shared types (Console-to-Terraform export) / tf-export 공용 타입 (콘솔→Terraform 내보내기)
import type { NodeType } from '@/lib/dep-graph/types';

// Terraform resource types we can export / 내보낼 수 있는 Terraform 리소스 타입
export type TfType = 'aws_vpc'|'aws_subnet'|'aws_security_group'|'aws_instance'|'aws_lb'|'aws_lb_listener'|'aws_lb_target_group'|'aws_db_instance'|'aws_lambda_function'|'aws_iam_role'|'aws_nat_gateway'|'aws_eip'|'aws_ebs_volume'|'aws_s3_bucket'|'aws_cloudfront_distribution';
// Pipeline stage of a job / 작업의 파이프라인 단계
export type Stage = 'prepare'|'generate'|'rules'|'ai-fix'|'diff'|'refactor'|'verify'|'package'|'done'|'failed';
// How the user picked the starting resources / 사용자가 시작 리소스를 고르는 방식
export type ExportSeed = { kind: 'tag'; key: string; value: string } | { kind: 'prefix'; prefix: string } | { kind: 'vpc'; arn: string } | { kind: 'arns'; arns: string[] };
// One resource to export / 내보낼 리소스 한 건
export interface ExportItem { address: string; tfType: TfType; importId: string; nodeArn: string; nodeType: NodeType | 'listener'; name: string; id: string }
// Why a resource was left out / 제외된 이유
export type ExcludeReason = 'attached-to-instance'|'unsupported'|'over-limit'|'other-region'|'shared'|'managed'|'service-role';
export interface Excluded { nodeArn: string; name: string; nodeType: string; reason: ExcludeReason }
// Per-item verdict of the diff-0 gate / diff-0 관문의 항목별 결과
export type ItemOutcome = 'pass' | 'pass-ignore' | 'failed';
export interface ItemResult { address: string; tfType: TfType; name: string; outcome: ItemOutcome; passedAt?: 'rules'|'ai'|'final'; reason?: string; ignored?: string[]; changedPaths?: string[] }
// Job totals shown in the report / 리포트에 표시할 작업 통계
export interface JobStats { total: number; passRules: number; passAi: number; passFinal: number; pure: number; ignore: number; failed: number; byType: Partial<Record<TfType, { total: number; pass: number }>>; aiCalls: number; inputTokens: number; outputTokens: number }
// Persisted job record / 저장되는 작업 기록
export interface JobRecord { id: string; accountId: string; region: string; seed: ExportSeed; requestedBy: string | null; startedAt: string; finishedAt?: string; stage: Stage; error?: string; items: ExportItem[]; excluded: Excluded[]; results: ItemResult[]; stats?: JobStats; files?: string[]; bundleLevel?: 'refactored'|'named'|'raw' }
