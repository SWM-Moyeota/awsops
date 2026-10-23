// Cost Radar estimate — pure: raw inventory rows -> priced resources and category totals.
// 비용 레이더 추정 — 순수 함수: 원본 인벤토리 행 -> 가격 계산된 리소스와 카테고리 합계.
import {
  HOURS_PER_MONTH, priceAsOf, priceEc2, priceEbs, priceSnapshot, pricePublicIp,
  priceNat, priceLb, priceVpcEndpoint, priceRds, priceElastiCache, type PriceResult,
} from './pricing';
import type { CategoryId, CategoryTotal, Estimate, PricedResource, RawInventory, Row } from './types';

export const ALL_SCOPE = '__all__';

/** Numeric coercion: strings/null/NaN become 0 (never NaN). / 숫자 변환: 문자열/null/NaN은 0. */
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
/** Optional numeric: missing -> null (baseline). / 값 없으면 null (기본값 적용). */
const optNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

function toTags(v: unknown): Record<string, string> {
  let o = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return {}; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o as Record<string, unknown>)) out[k] = str(val);
  return out;
}

function make(
  r: Row, id: string, category: CategoryId, detail: string, price: PriceResult,
): PricedResource {
  const tags = toTags(r.tags);
  const res: PricedResource = {
    id, name: tags.Name || id, accountId: str(r.account_id), region: str(r.region),
    category, detail, monthly: price.monthly, tags,
  };
  if (price.monthly === null) res.unpricedReason = price.reason;
  return res;
}

function priceInventory(inv: RawInventory): PricedResource[] {
  const out: PricedResource[] = [];
  for (const r of inv.instances) {
    if (str(r.instance_state) !== 'running') continue; // stopped = 0 / 중지 = 0원
    const price = priceEc2({ instanceType: str(r.instance_type), platformDetails: str(r.platform_details), tenancy: str(r.placement_tenancy), region: str(r.region) });
    out.push(make(r, str(r.instance_id), 'ec2', str(r.instance_type), price));
  }
  for (const r of inv.volumes) {
    const sizeGb = num(r.size);
    const price = priceEbs({ volumeType: str(r.volume_type), sizeGb, iops: optNum(r.iops), throughput: optNum(r.throughput), region: str(r.region) });
    out.push(make(r, str(r.volume_id), 'storage', `${str(r.volume_type)} ${sizeGb} GB`, price));
  }
  for (const r of inv.snapshots) {
    const sizeGb = num(r.volume_size);
    out.push(make(r, str(r.snapshot_id), 'storage', `snapshot ${sizeGb} GB`, priceSnapshot({ sizeGb, region: str(r.region) })));
  }
  for (const r of inv.eips) {
    const id = str(r.allocation_id) || str(r.public_ip);
    out.push(make(r, id, 'public-ip', str(r.public_ip), pricePublicIp({ region: str(r.region) })));
  }
  for (const r of inv.nats) {
    out.push(make(r, str(r.nat_gateway_id), 'nat', 'NAT Gateway', priceNat({ region: str(r.region) })));
  }
  for (const [rows, type] of [[inv.albs, 'application'], [inv.nlbs, 'network']] as const) {
    for (const r of rows) {
      const id = str(r.arn);
      const res = make(r, id, 'loadbalancer', type === 'application' ? 'ALB' : 'NLB', priceLb({ type, region: str(r.region) }));
      res.name = toTags(r.tags).Name || str(r.name) || id;
      out.push(res);
    }
  }
  for (const r of inv.endpoints) {
    const subnets = Array.isArray(r.subnet_ids) ? r.subnet_ids.length : 0;
    out.push(make(r, str(r.vpc_endpoint_id), 'vpc-endpoint', `${str(r.service_name)} x${subnets} AZ`, priceVpcEndpoint({ azCount: subnets, region: str(r.region) })));
  }
  for (const r of inv.rds) {
    const price = priceRds({
      engine: str(r.engine), instanceClass: str(r.class), multiAz: r.multi_az === true || r.multi_az === 'true',
      storageType: str(r.storage_type), allocatedGb: num(r.allocated_storage), iops: optNum(r.iops), region: str(r.region),
    });
    out.push(make(r, str(r.db_instance_identifier), 'rds', `${str(r.engine)} ${str(r.class)}`, price));
  }
  for (const r of inv.elasticache) {
    const price = priceElastiCache({ nodeType: str(r.cache_node_type), nodes: num(r.num_cache_nodes), region: str(r.region) });
    out.push(make(r, str(r.cache_cluster_id), 'elasticache', `${str(r.cache_node_type)} x${num(r.num_cache_nodes)}`, price));
  }
  return out;
}

/** scopeAccountId '__all__' merges all inventories. / '__all__'이면 전 계정 병합. */
export function buildEstimate(inv: RawInventory[], scopeAccountId: string): Estimate {
  const all = inv.flatMap(priceInventory);
  const resources = all.filter(r => r.monthly !== null);
  const unpriced = all.filter(r => r.monthly === null);
  const monthly = resources.reduce((s, r) => s + (r.monthly as number), 0);

  const byCat = new Map<CategoryId, CategoryTotal>();
  for (const r of resources) {
    const c = byCat.get(r.category) ?? { id: r.category, monthly: 0, percent: 0, count: 0 };
    c.monthly += r.monthly as number; c.count += 1;
    byCat.set(r.category, c);
  }
  const categories = Array.from(byCat.values()).sort((a, b) => b.monthly - a.monthly);
  for (const c of categories) c.percent = monthly > 0 ? Math.round((c.monthly / monthly) * 100) : 0;

  const warnings: Estimate['warnings'] = [];
  for (const i of inv) {
    for (const [key, message] of Object.entries(i.errors)) {
      if (key === 'target-groups' || !message) continue;
      if (!warnings.some(w => w.category === key && w.message === message)) warnings.push({ category: key as CategoryId, message });
    }
  }

  return { accountId: scopeAccountId, monthly, hourly: monthly / HOURS_PER_MONTH, categories, resources, unpriced, warnings, priceAsOf: priceAsOf() };
}
