// Read diagram rows; core sources must work, the rest are skipped and named in the legend / 다이어그램 행 읽기: 핵심 소스는 필수, 나머지는 건너뛰고 범례에 이름을 적음
import { queries as relQ } from '@/lib/queries/relationships';
import type { DiagramRows, Row } from './types';

export type QueryFn = (sql: string) => Promise<{ rows: Row[]; error?: string }>;

const CORE = { vpcSubnets: relQ.vpcSubnets, ec2: relQ.diagramEc2, elb: relQ.elbRelations, nat: relQ.natRelations, igw: relQ.igwRelations, routeTables: relQ.routeTables, targetGroups: relQ.targetGroups } as const;
const OPTIONAL = {
  rds: relQ.diagramRds, elasticache: relQ.elasticache, lambda: relQ.lambdaVpc, msk: relQ.msk, opensearch: relQ.opensearch, endpoints: relQ.vpcEndpoints, tgw: relQ.tgwRelations,
  s3: relQ.s3Buckets, dynamodb: relQ.dynamodbTables, cloudfront: relQ.diagramCloudfront, route53: relQ.route53Zones,
} as const;

// Throws DiagramQueryFailed when a core source fails / 핵심 소스가 실패하면 DiagramQueryFailed
export async function collectRows(query: QueryFn, includeServices: boolean): Promise<{ rows: DiagramRows; skipped: string[] }> {
  const rows: Record<string, Row[]> = {};
  const skipped: string[] = [];
  for (const [key, sql] of Object.entries(CORE)) {
    const r = await query(sql);
    if (r.error) { const e = new Error(`core query failed: ${key}`); e.name = 'DiagramQueryFailed'; throw e; }
    rows[key] = r.rows;
  }
  // CloudFront stays on: it can sit in front of this VPC / CloudFront는 항상 읽음: 이 VPC 앞단일 수 있음
  const accountOnly = new Set(['s3', 'dynamodb', 'route53']);
  for (const [key, sql] of Object.entries(OPTIONAL)) {
    if (!includeServices && accountOnly.has(key)) continue;
    try {
      const r = await query(sql);
      if (r.error) skipped.push(key); else rows[key] = r.rows;
    } catch { skipped.push(key); }
  }
  return { rows: rows as unknown as DiagramRows, skipped };
}
