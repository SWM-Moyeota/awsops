// Cost Radar collection — one Steampipe query per table, failures recorded, never throws.
// At most 4 queries per account run at once (the pool has 10 slots; batchQuery keeps 2 free).
// 비용 레이더 수집 — 테이블당 쿼리 1건, 실패는 errors에 기록하고 절대 throw하지 않음.
// 계정당 동시 쿼리는 최대 4개 (풀 10개 중 다른 요청 몫을 남김).
import { runQuery as defaultRunQuery } from '@/lib/steampipe';
import type { CategoryId } from './types';
import type { RawInventory, Row } from './types';

export type { RawInventory } from './types';

type ErrKey = CategoryId | 'target-groups';
type QueryResult = { rows?: unknown[]; error?: string };
export type RunQueryFn = (sql: string, opts?: { accountId?: string }) => Promise<QueryResult>;

/** Max concurrent Steampipe queries per account. / 계정당 최대 동시 쿼리 수. */
export const MAX_CONCURRENT_QUERIES = 4;
const COMMON = 'tags, account_id, region';

// [inventory field, error key, SQL] — no `$` in SQL (repo rule) / SQL에 `$` 금지
const QUERIES: [keyof Omit<RawInventory, 'accountId' | 'errors'>, ErrKey, string][] = [
  ['instances', 'ec2', `SELECT instance_id, instance_type, instance_state, state_transition_time, platform_details, placement_tenancy, public_ip_address, ${COMMON} FROM aws_ec2_instance`],
  ['volumes', 'storage', `SELECT volume_id, volume_type, size, iops, throughput, state, attachments, ${COMMON} FROM aws_ebs_volume`],
  ['snapshots', 'storage', `SELECT snapshot_id, volume_id, volume_size, start_time, owner_id, ${COMMON} FROM aws_ebs_snapshot WHERE owner_id = account_id`],
  ['eips', 'public-ip', `SELECT allocation_id, association_id, instance_id, public_ip, ${COMMON} FROM aws_vpc_eip`],
  ['nats', 'nat', `SELECT nat_gateway_id, state, ${COMMON} FROM aws_vpc_nat_gateway WHERE state = 'available'`],
  ['albs', 'loadbalancer', `SELECT arn, name, state_code, scheme, availability_zones, ${COMMON} FROM aws_ec2_application_load_balancer`],
  ['nlbs', 'loadbalancer', `SELECT arn, name, state_code, scheme, availability_zones, ${COMMON} FROM aws_ec2_network_load_balancer`],
  ['endpoints', 'vpc-endpoint', `SELECT vpc_endpoint_id, vpc_endpoint_type, service_name, state, subnet_ids, ${COMMON} FROM aws_vpc_endpoint WHERE vpc_endpoint_type = 'Interface'`],
  ['rds', 'rds', `SELECT db_instance_identifier, class, engine, status, multi_az, allocated_storage, storage_type, iops, ${COMMON} FROM aws_rds_db_instance`],
  ['elasticache', 'elasticache', `SELECT cache_cluster_id, cache_node_type, num_cache_nodes, engine, ${COMMON} FROM aws_elasticache_cluster`],
  ['targetGroups', 'target-groups', `SELECT target_group_arn, target_group_name, load_balancer_arns, target_health_descriptions, ${COMMON} FROM aws_ec2_target_group`],
];

/** Run tasks with at most `limit` in flight, results in input order. / 최대 limit개씩 동시 실행, 입력 순서 유지. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** accountId = 12-digit id; `runQuery` is injectable for tests. / 12자리 계정 ID, runQuery는 테스트용 주입 가능. */
export async function collectInventory(
  accountId: string,
  deps: { runQuery?: RunQueryFn } = {},
): Promise<RawInventory> {
  const run: RunQueryFn = deps.runQuery ?? ((sql, opts) => defaultRunQuery<Row>(sql, opts));
  const inv: RawInventory = {
    accountId, instances: [], volumes: [], snapshots: [], eips: [], nats: [], albs: [], nlbs: [],
    endpoints: [], rds: [], elasticache: [], targetGroups: [], errors: {},
  };
  const results = await mapLimited(QUERIES, MAX_CONCURRENT_QUERIES, async ([field, key, sql]) => {
    try {
      const r = await run(sql, { accountId });
      return { field, key, rows: (r?.rows ?? []) as Row[], error: r?.error };
    } catch (e) {
      return { field, key, rows: [] as Row[], error: e instanceof Error ? e.message : String(e) };
    }
  });
  for (const { field, key, rows, error } of results) {
    if (error) inv.errors[key] = inv.errors[key] ? `${inv.errors[key]}; ${error}` : error;
    else inv[field] = rows;
  }
  return inv;
}
