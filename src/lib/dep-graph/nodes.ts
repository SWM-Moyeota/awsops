// Turns query rows into graph nodes and a lookup index.
// 쿼리 행을 노드로 바꾸고 조회용 색인을 만든다. 행이 이상해도 던지지 않는다.
import type { GraphNode, NodeType, QueryName, Row, Rows } from './types';

const MAX_TAGS = 50;
const MAX_TAG_VALUE = 256;

/** null / non-array -> [], JSON string -> parsed array. */
export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/** Non-empty string or undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function eniArn(partition: string, region: string, accountId: string, id: string): string {
  return `arn:${partition}:ec2:${region}:${accountId}:network-interface/${id}`;
}

// Normalizes undefined to null so attrs serialize to JSON; other values pass through.
// undefined는 null로 바꿔 JSON에 남기고, 나머지 값은 그대로 둔다.
const val = (v: unknown): unknown => (v === undefined ? null : v);

function parseObject(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function cleanTags(v: unknown): Record<string, string> | undefined {
  const o = parseObject(v);
  if (!o) return undefined;
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(o)) {
    if (Object.keys(out).length >= MAX_TAGS) break;
    if (raw === null || raw === undefined) continue;
    out[k] = String(raw).slice(0, MAX_TAG_VALUE);
  }
  return out;
}

interface Spec {
  type: NodeType;
  arn: (r: Row) => string | undefined;
  id: (r: Row) => string | undefined;
  natural?: (r: Row) => string | undefined;
  attrs: (r: Row) => Record<string, unknown>;
  tags?: boolean;
}

const lb = (lbType: string): Spec => ({
  type: 'lb', arn: r => str(r.arn), id: r => str(r.name),
  attrs: r => ({ lbType, scheme: val(r.scheme), dnsName: val(r.dns_name) }),
});

const SPECS: Partial<Record<QueryName, Spec>> = {
  vpc: { type: 'vpc', arn: r => str(r.arn), id: r => str(r.vpc_id), attrs: r => ({ cidr: val(r.cidr_block), isDefault: val(r.is_default) }) },
  subnet: { type: 'subnet', arn: r => str(r.subnet_arn), id: r => str(r.subnet_id), attrs: r => ({ cidr: val(r.cidr_block), az: val(r.availability_zone) }) },
  eni: {
    type: 'eni',
    arn: r => {
      const id = str(r.network_interface_id), acc = str(r.account_id), reg = str(r.region);
      return id && acc && reg ? eniArn(str(r.partition) ?? 'aws', reg, acc, id) : undefined;
    },
    id: r => str(r.network_interface_id),
    natural: r => str(r.description),
    attrs: r => ({ interfaceType: val(r.interface_type), status: val(r.status), privateIp: val(r.private_ip_address) }),
  },
  instance: { type: 'instance', arn: r => str(r.arn), id: r => str(r.instance_id), attrs: r => ({ state: val(r.instance_state), instanceType: val(r.instance_type), privateIp: val(r.private_ip_address) }) },
  sg: { type: 'sg', arn: r => str(r.arn), id: r => str(r.group_id), natural: r => str(r.group_name), attrs: r => ({ vpcId: val(r.vpc_id) }) },
  alb: lb('application'),
  nlb: lb('network'),
  clb: lb('classic'),
  tg: { type: 'tg', arn: r => str(r.target_group_arn), id: r => str(r.target_group_name), attrs: r => ({ targetType: val(r.target_type), port: val(r.port), protocol: val(r.protocol) }) },
  rds: { type: 'rds', arn: r => str(r.arn), id: r => str(r.db_instance_identifier), attrs: r => ({ engine: val(r.engine), class: val(r.class), status: val(r.status) }) },
  lambda: { type: 'lambda', arn: r => str(r.arn), id: r => str(r.name), attrs: r => ({ runtime: val(r.runtime), state: val(r.state) }), tags: false },
  role: { type: 'role', arn: r => str(r.arn), id: r => str(r.name), attrs: r => ({ path: val(r.path) }) },
  nat: { type: 'nat', arn: r => str(r.arn), id: r => str(r.nat_gateway_id), attrs: r => ({ state: val(r.state) }) },
  eip: { type: 'eip', arn: r => str(r.arn), id: r => str(r.allocation_id), natural: r => str(r.public_ip), attrs: r => ({ publicIp: val(r.public_ip) }) },
  ebs: { type: 'ebs', arn: r => str(r.arn), id: r => str(r.volume_id), attrs: r => ({ size: val(r.size), volumeType: val(r.volume_type), state: val(r.state) }) },
  s3: { type: 's3', arn: r => str(r.arn), id: r => str(r.name), attrs: () => ({}) },
  cloudfront: {
    type: 'cloudfront', arn: r => str(r.arn), id: r => str(r.id),
    natural: r => str(asArray(r.aliases)[0]) ?? str(r.domain_name),
    attrs: r => ({ domainName: val(r.domain_name), enabled: val(r.enabled) }),
  },
};

// Order is fixed so output is deterministic. sgRule/policy have no spec, so no nodes.
const ORDER: QueryName[] = ['vpc','subnet','eni','instance','sg','alb','nlb','clb','tg','rds','lambda','role','nat','eip','ebs','s3','cloudfront'];

export function buildNodes(rows: Rows): GraphNode[] {
  const out: GraphNode[] = [];
  for (const q of ORDER) {
    const spec = SPECS[q];
    const list = rows[q];
    if (!spec || !Array.isArray(list)) continue;
    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const arn = spec.arn(r);
      const id = spec.id(r);
      if (!arn || !id) continue;
      const tags = spec.tags === false ? undefined : cleanTags(r.tags);
      const name = str(tags?.Name) ?? spec.natural?.(r) ?? id;
      const attrs = spec.attrs(r);
      if (tags) attrs.tags = tags;
      out.push({ arn, type: spec.type, id, name, accountId: str(r.account_id) ?? '', region: str(r.region) ?? '', attrs });
    }
  }
  return out;
}

export interface NodeIndex {
  byArn(arn: string): GraphNode | undefined;
  /** With `type`: exact lookup. Without: the node only if exactly one matches, else undefined (ambiguous). */
  byId(accountId: string, id: string, type?: NodeType): GraphNode | undefined;
  nodes: GraphNode[];
}

export function buildIndex(nodes: GraphNode[]): NodeIndex {
  // Last write wins on duplicate ARNs. / 같은 ARN이 중복이면 마지막 노드가 남는다.
  const arns = new Map<string, GraphNode>();
  const typed = new Map<string, GraphNode>();
  const untyped = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    arns.set(n.arn, n);
    typed.set(`${n.accountId}\0${n.type}\0${n.id}`, n);
    const k = `${n.accountId}\0${n.id}`;
    const list = untyped.get(k);
    if (list) list.push(n); else untyped.set(k, [n]);
  }
  return {
    byArn: a => arns.get(a),
    byId: (acc, id, type) => {
      if (type) return typed.get(`${acc}\0${type}\0${id}`);
      const list = untyped.get(`${acc}\0${id}`);
      return list && list.length === 1 ? list[0] : undefined;
    },
    nodes,
  };
}
