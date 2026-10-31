// Turn query rows into a VPC > AZ > subnet model; only relations the data proves are drawn / 쿼리 행을 VPC > AZ > 서브넷 모델로 바꾼다. 데이터로 확인되는 관계만 그린다
import type { AzModel, BuildOptions, DiagramModel, DiagramRows, EdgeModel, Res, Row, SubnetModel, Tier } from './types';

const leaf = (s: string) => s.split('/').filter(Boolean).pop() || s;
const shortId = (id: string) => { const i = id.indexOf('-'); return i > 0 ? `${id.slice(0, i)}-${id.slice(i + 1, i + 7)}` : id; };
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const zoneSuffix = (az: string) => az.split('-').pop() || az;

// Parse a v4 CIDR; null when malformed / IPv4 CIDR 파싱, 잘못되면 null
function parseCidr(cidr: string): { base: number; mask: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr || '');
  if (!m) return null;
  const bits = Number(m[5]);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) & mask) >>> 0, mask };
}
function inCidr(ip: string, cidr: string): boolean {
  const c = parseCidr(cidr), a = parseCidr(`${ip}/32`);
  return !!c && !!a && ((a.base & c.mask) >>> 0) === c.base;
}

// Throws VpcNotFound when the VPC is not in the rows / 행에 VPC가 없으면 VpcNotFound
export function buildModel(rows: DiagramRows, opt: BuildOptions): DiagramModel {
  const vpcRows = rows.vpcSubnets.filter(r => r.vpc_id === opt.vpc || (r.vpc_name && r.vpc_name === opt.vpc));
  if (!vpcRows.length) { const e = new Error('VPC not found'); e.name = 'VpcNotFound'; throw e; }
  const meta = vpcRows[0];
  const vpcId: string = meta.vpc_id;
  const exclude = new Set(opt.excludeSubnets ?? []);
  const inVpc = (r: Row) => r.vpc_id === vpcId;

  // Public = route table sends traffic to an internet gateway / 퍼블릭 = 라우트 테이블이 IGW로 보냄
  const tables = rows.routeTables.filter(inVpc);
  const bySubnet = new Map<string, Row>();
  let mainTable: Row | undefined;
  for (const t of tables) for (const a of arr(t.associations)) {
    if (a.SubnetId) bySubnet.set(a.SubnetId, t);
    if (a.Main) mainTable = t;
  }
  const tableOf = (sid: string) => bySubnet.get(sid) ?? mainTable;
  const tierOf = (sid: string): Tier => (arr(tableOf(sid)?.routes).some(r => String(r.GatewayId ?? '').startsWith('igw-')) ? 'public' : 'private');

  const subnets = vpcRows.filter(r => r.subnet_id && !exclude.has(r.subnet_id) && !exclude.has(r.subnet_name ?? '')).map((r): SubnetModel => ({
    id: r.subnet_id, name: leaf(r.subnet_name || r.subnet_id), cidr: r.subnet_cidr || '', az: r.availability_zone || 'unknown',
    tier: tierOf(r.subnet_id), resources: [], lbNodes: false, also: [],
  }));
  const subnetById = new Map(subnets.map(s => [s.id, s] as const));
  const privateFirst = (list: SubnetModel[]) => list.slice().sort((a, b) => Number(a.tier === 'public') - Number(b.tier === 'public') || a.id.localeCompare(b.id));
  const edges: EdgeModel[] = [];
  const attachments: Res[] = [];

  // NAT gateways / NAT 게이트웨이
  const natIds = new Set<string>();
  const nats = rows.nat.filter(r => inVpc(r) && r.state !== 'deleted');
  for (const r of nats) {
    const s = subnetById.get(r.subnet_id);
    if (!s) continue;
    natIds.add(r.nat_gateway_id);
    s.resources.push({ id: r.nat_gateway_id, kind: 'nat', name: r.name || `NAT GW ${zoneSuffix(s.az)}`, detail: r.nat_gateway_id });
  }

  // EC2: ASG and EKS instances fold into one icon per subnet / EC2: ASG·EKS 인스턴스는 서브넷별 아이콘 하나로 접음
  const instanceIcon = new Map<string, string>();
  const groups = new Map<string, { res: Res; running: number; types: Set<string> }>();
  const instances = rows.ec2.filter(r => inVpc(r) && r.instance_state !== 'terminated').sort((a, b) => String(a.instance_id).localeCompare(String(b.instance_id)));
  for (const r of instances) {
    const s = subnetById.get(r.subnet_id);
    if (!s) continue;
    const stopped = r.instance_state !== 'running';
    const grpName: string | null = r.eks_cluster || r.asg_name || null;
    if (grpName) {
      const key = `${s.id}|${grpName}`;
      let g = groups.get(key);
      if (!g) {
        g = { res: { id: `group:${key}`, kind: r.eks_cluster ? 'eks' : 'ec2', name: grpName, count: 0, group: !r.eks_cluster }, running: 0, types: new Set() };
        groups.set(key, g);
        s.resources.push(g.res);
      }
      g.res.count = (g.res.count ?? 0) + 1;
      if (!stopped) g.running++;
      if (r.instance_type) g.types.add(r.instance_type);
      g.res.detail = `${Array.from(g.types).join(', ')} · ${r.eks_cluster ? 'EKS' : 'Auto Scaling'} ${g.running}/${g.res.count}`;
      g.res.faded = g.running === 0;
      instanceIcon.set(r.instance_id, g.res.id);
    } else {
      s.resources.push({ id: r.instance_id, kind: 'ec2', name: r.name || shortId(r.instance_id), detail: [r.instance_type, stopped ? r.instance_state : null].filter(Boolean).join(' · '), faded: stopped });
      instanceIcon.set(r.instance_id, r.instance_id);
    }
  }

  // Managed resources placed by subnet list / 서브넷 목록으로 놓는 관리형 리소스
  const place = (subnetIds: unknown, res: Res): boolean => {
    const ids = Array.isArray(subnetIds) ? subnetIds.filter((x): x is string => typeof x === 'string') : [];
    const found = privateFirst(ids.map(i => subnetById.get(i)).filter((s): s is SubnetModel => !!s));
    if (!found.length) return false;
    if (found.length > 1) res.detail = [res.detail, `subnets: ${found.length}`].filter(Boolean).join(' · ');
    found[0].resources.push(res);
    for (const s of found.slice(1)) s.also.push(res);
    return true;
  };

  // RDS: the subnet group's subnet in the primary AZ; a Multi-AZ standby gets its own icon / RDS: 주 AZ의 서브넷 그룹 서브넷, Multi-AZ 대기는 아이콘 따로
  for (const r of (rows.rds ?? []).filter(inVpc)) {
    const group = arr(r.subnets).map(x => subnetById.get(x.SubnetIdentifier)).filter((s): s is SubnetModel => !!s);
    const inAz = (az: string | null | undefined) => privateFirst(group.filter(s => s.az === az))[0];
    const id = `rds:${r.db_instance_identifier}`;
    const detail = [r.engine, r.db_instance_class, r.status && r.status !== 'available' ? r.status : null].filter(Boolean).join(' · ');
    const home = inAz(r.availability_zone) ?? privateFirst(group)[0];
    if (!home) continue;
    const faded = !!r.status && r.status !== 'available';
    home.resources.push({ id, kind: 'rds', name: r.db_instance_identifier, detail: r.multi_az ? `${detail} · Multi-AZ` : detail, faded });
    const standby = r.multi_az && r.secondary_availability_zone ? inAz(r.secondary_availability_zone) : undefined;
    if (standby && standby !== home) {
      standby.resources.push({ id: `${id}:standby`, kind: 'rds', name: `${r.db_instance_identifier} standby`, detail: `${r.engine} · Multi-AZ standby`, faded });
      edges.push({ from: id, to: `${id}:standby`, dashed: true, label: 'Multi-AZ' });
    }
  }

  // ElastiCache knows only its AZ: first private subnet in that AZ, else the VPC band / ElastiCache는 AZ만 앎: 그 AZ의 첫 프라이빗 서브넷, 없으면 VPC 띠
  for (const r of (rows.elasticache ?? []).filter(inVpc)) {
    const res: Res = { id: `cache:${r.cache_cluster_id}`, kind: 'elasticache', name: r.cache_cluster_id, detail: r.engine };
    const home = privateFirst(subnets.filter(s => s.az === r.availability_zone))[0];
    if (home) home.resources.push(res); else attachments.push(res);
  }
  for (const r of (rows.lambda ?? []).filter(inVpc)) {
    const res: Res = { id: `lambda:${r.name}`, kind: 'lambda', name: r.name, detail: r.runtime };
    if (!place(r.vpc_subnet_ids, res)) attachments.push(res);
  }
  // MSK and OpenSearch rows have no vpc_id; a known subnet proves membership / MSK·OpenSearch 행에는 vpc_id가 없어 서브넷으로 판단
  for (const r of rows.msk ?? []) place(r.client_subnets, { id: `msk:${r.cluster_name}`, kind: 'msk', name: r.cluster_name, detail: r.state });
  for (const r of rows.opensearch ?? []) place(r.subnet_ids, { id: `os:${r.domain_name}`, kind: 'opensearch', name: r.domain_name, detail: r.engine_version });

  // Load balancers sit at VPC level; their subnets count as used / 로드밸런서는 VPC 수준, 연결된 서브넷은 사용 중으로 침
  const lbRows = rows.elb.filter(inVpc).sort((a, b) => String(a.elb_name).localeCompare(String(b.elb_name)));
  const lbs: Res[] = lbRows.map(r => ({ id: r.arn, kind: r.type === 'network' ? 'nlb' : 'alb', name: r.elb_name, detail: r.scheme }));
  for (const r of lbRows) for (const z of arr(r.availability_zones)) { const s = subnetById.get(z.SubnetId); if (s) s.lbNodes = true; }

  // Load balancer -> target: exact instance id, exact private IP, or EKS nodes in the IP's subnet / 인스턴스 id, 정확한 사설 IP, 또는 그 IP 서브넷의 EKS 노드
  const seenTarget = new Set<string>();
  const addTarget = (lb: string, icon: string | undefined) => {
    if (!icon || seenTarget.has(`${lb}|${icon}`)) return;
    seenTarget.add(`${lb}|${icon}`);
    edges.push({ from: lb, to: icon });
  };
  const byIp = new Map(instances.filter(i => i.private_ip_address).map(i => [i.private_ip_address as string, i.instance_id as string] as const));
  for (const tg of rows.targetGroups.filter(inVpc)) {
    for (const lb of arr(tg.load_balancer_arns) as unknown as string[]) {
      if (!lbs.some(l => l.id === lb)) continue;
      for (const t of arr(tg.target_health_descriptions)) {
        const tid = String(t.Target?.Id ?? '');
        if (tid.startsWith('i-')) { addTarget(lb, instanceIcon.get(tid)); continue; }
        const exact = byIp.get(tid);
        if (exact) { addTarget(lb, instanceIcon.get(exact)); continue; }
        const s = subnets.find(x => inCidr(tid, x.cidr));
        if (s) for (const res of s.resources) if (res.kind === 'eks') addTarget(lb, res.id);
      }
    }
  }

  // Empty subnets are hidden unless asked / 빈 서브넷은 요청이 없으면 숨김
  const used = (s: SubnetModel) => s.resources.length > 0 || s.lbNodes || s.also.length > 0;
  const shown = opt.includeEmpty ? subnets : subnets.filter(used);
  const hiddenEmpty = subnets.length - shown.length;
  const shownIds = new Set(shown.map(s => s.id));

  // Private subnet -> NAT from its real route / 프라이빗 서브넷 -> NAT는 실제 라우트로
  for (const s of shown) {
    if (!s.resources.length || s.tier === 'public') continue;
    for (const r of arr(tableOf(s.id)?.routes)) {
      if (r.NatGatewayId && natIds.has(r.NatGatewayId) && (r.DestinationCidrBlock === '0.0.0.0/0' || !r.DestinationCidrBlock)) {
        edges.push({ from: `subnet:${s.id}`, to: r.NatGatewayId, dashed: true });
        break;
      }
    }
  }

  // Internet, IGW and what they reach / 인터넷, IGW, 그리고 닿는 곳
  const igwRow = rows.igw.find(inVpc);
  const igw: Res | undefined = igwRow ? { id: igwRow.internet_gateway_id, kind: 'igw', name: 'Internet Gateway', detail: igwRow.internet_gateway_id } : undefined;
  const publicLbs = lbRows.filter(r => r.scheme === 'internet-facing');
  const publicInstances = instances.filter(r => r.public_ip_address && r.instance_state === 'running' && subnetById.get(r.subnet_id)?.tier === 'public' && shownIds.has(r.subnet_id));
  const internet: Res = { id: 'internet', kind: 'internet', name: 'Internet' };
  if (igw) {
    if (publicLbs.length || publicInstances.length) edges.push({ from: internet.id, to: igw.id });
    for (const r of publicLbs) edges.push({ from: igw.id, to: r.arn });
    const seen = new Set<string>();
    for (const r of publicInstances) {
      const icon = instanceIcon.get(r.instance_id);
      if (icon && !seen.has(icon)) { seen.add(icon); edges.push({ from: igw.id, to: icon }); }
    }
  }

  // CloudFront only when an origin is this VPC's load balancer / 원본이 이 VPC의 로드밸런서일 때만 CloudFront
  const edgeServices: Res[] = [];
  const services: Res[] = [];
  const dnsToLb = new Map(lbRows.filter(r => r.dns_name).map(r => [String(r.dns_name).toLowerCase(), r.arn as string] as const));
  let otherCf = 0;
  for (const r of rows.cloudfront ?? []) {
    const lbsHit = arr(r.origins).map(o => dnsToLb.get(String(o.DomainName ?? '').toLowerCase())).filter((x): x is string => !!x);
    if (!lbsHit.length) { otherCf++; continue; }
    const alias = arr(r.aliases?.Items)[0] as unknown as string | undefined;
    const res: Res = { id: `cf:${r.id}`, kind: 'cloudfront', name: alias || r.domain_name || r.id, detail: r.id };
    edgeServices.push(res);
    edges.push({ from: internet.id, to: res.id });
    for (const lb of Array.from(new Set(lbsHit))) edges.push({ from: res.id, to: lb });
  }
  if (opt.includeServices !== false) {
    const svc = (kind: Res['kind'], name: string, n: number) => { if (n > 0) services.push({ id: `svc:${kind}`, kind, name, detail: `×${n}`, count: n }); };
    svc('route53', 'Route 53', (rows.route53 ?? []).length);
    svc('cloudfront', 'CloudFront', otherCf);
    svc('s3', 'S3', (rows.s3 ?? []).length);
    svc('dynamodb', 'DynamoDB', (rows.dynamodb ?? []).length);
  }

  // VPC attachments / VPC 연결
  const eps = (rows.endpoints ?? []).filter(inVpc);
  if (eps.length) attachments.push({ id: 'vpce', kind: 'endpoint', name: 'VPC Endpoints', detail: `×${eps.length}`, count: eps.length });
  const tgwIds = Array.from(new Set((rows.tgw ?? []).filter(r => r.resource_id === vpcId && r.resource_type === 'vpc').map(r => String(r.transit_gateway_id))));
  for (const id of tgwIds) attachments.push({ id, kind: 'tgw', name: 'Transit Gateway', detail: id });

  // AZ > tier, in stable order / AZ > 티어, 안정된 순서
  const azNames = Array.from(new Set(shown.map(s => s.az))).sort();
  const azs: AzModel[] = azNames.map(name => ({
    name,
    public: shown.filter(s => s.az === name && s.tier === 'public').sort((a, b) => a.cidr.localeCompare(b.cidr)),
    private: shown.filter(s => s.az === name && s.tier === 'private').sort((a, b) => a.cidr.localeCompare(b.cidr)),
  }));

  // Drop edges whose ends were hidden; number the legend in reading order / 숨겨진 끝점의 선 제거, 읽는 순서로 번호
  const model: DiagramModel = {
    vpc: { id: vpcId, name: meta.vpc_name || vpcId, cidr: meta.vpc_cidr || '', accountId: meta.account_id || '', region: opt.region || '' },
    internet: edges.some(e => e.from === internet.id) ? internet : undefined,
    igw, lbs, attachments, azs, edgeServices, services, edges, hiddenEmpty, skipped: opt.skipped ?? [],
  };
  const known = new Set<string>(allResources(model).map(r => r.id).concat(shown.map(s => `subnet:${s.id}`)));
  model.edges = edges.filter(e => known.has(e.from) && known.has(e.to));
  allResources(model).forEach((r, i) => { r.n = i + 1; });
  return model;
}

// Every drawn resource in reading order / 그려지는 모든 리소스 (읽는 순서)
export function allResources(m: DiagramModel): Res[] {
  const out: Res[] = [];
  if (m.internet) out.push(m.internet);
  out.push(...m.edgeServices);
  if (m.igw) out.push(m.igw);
  out.push(...m.lbs, ...m.attachments);
  for (const az of m.azs) for (const s of [...az.public, ...az.private]) out.push(...s.resources);
  out.push(...m.services);
  return out;
}
