// Pick exportable resources from the dependency graph / 의존성 그래프에서 내보낼 리소스 고르기
import { previewProject } from '@/lib/dep-graph/project';
import type { GraphData, GraphNode, NodeType } from '@/lib/dep-graph/types';
import { runQuery } from '@/lib/steampipe';
import type { ExportItem, ExportSeed, Excluded, TfType } from './types';

// Graph kind to Terraform type (null = not exportable) / 그래프 종류 → Terraform 종류 (null은 내보내지 않음)
export const TF_TYPE: Record<NodeType, TfType | null> = {
  vpc: 'aws_vpc', subnet: 'aws_subnet', eni: null, instance: 'aws_instance', sg: 'aws_security_group',
  lb: 'aws_lb', tg: 'aws_lb_target_group', rds: 'aws_db_instance', lambda: 'aws_lambda_function',
  role: 'aws_iam_role', nat: 'aws_nat_gateway', eip: 'aws_eip', ebs: 'aws_ebs_volume',
  s3: 'aws_s3_bucket', cloudfront: 'aws_cloudfront_distribution',
};

export const MAX_ITEMS = 60;
// Stable export order (dependencies first) / 안정적인 내보내기 순서 (의존 대상 먼저)
const ORDER: TfType[] = ['aws_vpc', 'aws_subnet', 'aws_nat_gateway', 'aws_eip', 'aws_security_group', 'aws_iam_role', 'aws_instance', 'aws_ebs_volume', 'aws_lambda_function', 'aws_db_instance', 'aws_s3_bucket', 'aws_lb_target_group', 'aws_lb', 'aws_lb_listener', 'aws_cloudfront_distribution'];
// Global kinds ignore the job region / 전역 종류는 작업 리전을 따지지 않음
const GLOBAL: ReadonlySet<NodeType> = new Set<NodeType>(['role', 'cloudfront']);

export interface ListenerRow { arn: string; lbArn: string; port: number; protocol: string }

// Terraform import id of a node / 노드의 Terraform import id
export function importIdFor(node: GraphNode): string {
  return node.type === 'lb' || node.type === 'tg' ? node.arn : node.id;
}

// Default listener lookup via Steampipe (SELECT only) / 기본 리스너 조회 (Steampipe SELECT)
async function defaultListeners(accountId: string, lbArns: string[]): Promise<ListenerRow[]> {
  if (!lbArns.length) return [];
  const list = lbArns.map(a => `'${a.replace(/'/g, "''")}'`).join(', ');
  const { rows, error } = await runQuery<{ arn: string; load_balancer_arn: string; port: number; protocol: string }>(
    `select arn, load_balancer_arn, port, protocol from aws_ec2_load_balancer_listener where load_balancer_arn in (${list})`,
    { accountId },
  );
  if (error) throw new Error('ListenerQueryFailed');
  return rows.map(r => ({ arn: r.arn, lbArn: r.load_balancer_arn, port: Number(r.port), protocol: r.protocol }));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function selectResources(input: {
  accountId: string; seed: ExportSeed; data: GraphData; region: string;
  listeners?: (lbArns: string[]) => Promise<ListenerRow[]>;
}): Promise<{ items: ExportItem[]; excluded: Excluded[] }> {
  const { accountId, seed, data, region } = input;
  const excluded: Excluded[] = [];
  const ex = (nd: GraphNode, reason: Excluded['reason']) => excluded.push({ nodeArn: nd.arn, name: nd.name, nodeType: nd.type, reason });

  // Seed to members / 시드 → 후보
  let members: GraphNode[];
  if (seed.kind === 'arns') {
    const byArn = new Map(data.nodes.map(nd => [nd.arn, nd] as const));
    members = Array.from(new Set(seed.arns)).map(a => byArn.get(a)).filter((nd): nd is GraphNode => !!nd && nd.accountId === accountId);
  } else {
    const prev = previewProject(data, seed, { accountId });
    members = prev.members;
    for (const nd of prev.shared) ex(nd, 'shared');
    for (const nd of prev.managed) ex(nd, 'managed');
  }

  // EBS volumes used by an instance / 인스턴스에 붙은 EBS
  const byArn = new Map(data.nodes.map(nd => [nd.arn, nd] as const));
  const attached = new Set<string>();
  for (const ed of data.edges) if (ed.type === 'uses_volume' && byArn.get(ed.src)?.type === 'instance') attached.add(ed.dst);

  const kept: Array<{ nd: GraphNode; tf: TfType }> = [];
  for (const nd of members) {
    const tf = TF_TYPE[nd.type];
    if (!tf || (nd.type === 'lb' && nd.attrs?.lbType !== 'application' && nd.attrs?.lbType !== 'network')) { ex(nd, 'unsupported'); continue; }
    if (nd.type === 'role' && String(nd.attrs?.path ?? '').startsWith('/aws-service-role/')) { ex(nd, 'service-role'); continue; }
    if (nd.type === 'ebs' && attached.has(nd.arn)) { ex(nd, 'attached-to-instance'); continue; }
    if (!GLOBAL.has(nd.type) && nd.region !== region) { ex(nd, 'other-region'); continue; }
    kept.push({ nd, tf });
  }

  // Listeners of included ALB/NLB / 포함된 ALB/NLB의 리스너
  type Cand = { tf: TfType; nodeArn: string; nodeType: ExportItem['nodeType']; name: string; id: string; importId: string };
  const cands: Cand[] = kept.map(({ nd, tf }) => ({ tf, nodeArn: nd.arn, nodeType: nd.type, name: nd.name, id: nd.id, importId: importIdFor(nd) }));
  const lbs = kept.filter(k => k.nd.type === 'lb');
  if (lbs.length) {
    const lbArns = lbs.map(k => k.nd.arn);
    const rows = await (input.listeners ? input.listeners(lbArns) : defaultListeners(accountId, lbArns));
    const lbName = new Map(lbs.map(k => [k.nd.arn, k.nd.name] as const));
    for (const r of rows) {
      if (!lbName.has(r.lbArn)) continue;
      cands.push({ tf: 'aws_lb_listener', nodeArn: r.arn, nodeType: 'listener', name: `${lbName.get(r.lbArn)}:${r.port}`, id: r.arn, importId: r.arn });
    }
  }

  // Stable order, cap, then addresses / 정렬 → 상한 → 주소 부여
  cands.sort((a, b) => ORDER.indexOf(a.tf) - ORDER.indexOf(b.tf) || cmp(a.name, b.name) || cmp(a.nodeArn, b.nodeArn));
  const items: ExportItem[] = [];
  for (const c of cands) {
    if (items.length >= MAX_ITEMS) { excluded.push({ nodeArn: c.nodeArn, name: c.name, nodeType: c.nodeType, reason: 'over-limit' }); continue; }
    items.push({ address: `${c.tf}.r${items.length + 1}`, tfType: c.tf, importId: c.importId, nodeArn: c.nodeArn, nodeType: c.nodeType, name: c.name, id: c.id });
  }
  return { items, excluded };
}
