// Delivery edges: lb, target group, rds, s3 notifications, cloudfront origins.
// 전달 계층 간선 — 모양이 이상한 열은 건너뛰고 던지지 않는다.
import type { GraphNode, Row, Rows } from '../types';
import type { NodeIndex } from '../nodes';
import { asArray, str } from '../nodes';
import type { EdgeSink } from '../sink';
import { acct, field, listRows } from './util';
import { link } from './network';

const S3_ORIGIN = /^(.+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
const S3_WEBSITE = /^(.+)\.s3-website[.-][a-z0-9-]+\.amazonaws\.com$/;

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && Array.from(a).every(x => b.has(x));
}

export function deliveryEdges(rows: Rows, ix: NodeIndex, sink: EdgeSink): void {
  const list = (q: keyof Rows): Row[] => listRows(rows, q);

  for (const q of ['alb', 'nlb', 'clb'] as const) {
    for (const r of list(q)) {
      const a = acct(r);
      // Own node by ARN: names are only unique per region. / 이름은 리전마다만 유일해서 ARN으로.
      const lb = ix.byArn(str(r.arn) ?? '');
      if (!lb) continue;
      if (q === 'clb') {
        for (const s of asArray(r.subnets)) link(sink, ix, lb, a, str(s), 'subnet', 'in_subnet');
      } else {
        for (const az of asArray(r.availability_zones)) link(sink, ix, lb, a, field(az, 'SubnetId'), 'subnet', 'in_subnet');
      }
      for (const g of asArray(r.security_groups)) link(sink, ix, lb, a, str(g), 'sg', 'uses_sg');
    }
  }

  for (const r of list('tg')) {
    const a = acct(r);
    const tg = ix.byArn(str(r.target_group_arn) ?? '');
    if (!tg) continue;
    for (const l of asArray(r.load_balancer_arns)) {
      const lbArn = str(l);
      if (lbArn) sink.add(ix.byArn(lbArn)?.arn, tg.arn, 'forwards_to');
    }
    link(sink, ix, tg, a, str(r.vpc_id), 'vpc', 'in_vpc');
    const tt = str(r.target_type);
    for (const d of asArray(r.target_health_descriptions)) {
      const id = field((d as Record<string, unknown> | null)?.Target, 'Id');
      if (!id) continue;
      if (tt === 'instance') sink.add(tg.arn, ix.byId(a, id, 'instance')?.arn, 'targets');
      else if (tt === 'lambda') sink.add(tg.arn, ix.byArn(id)?.arn, 'targets');
    }
  }

  // Subnet and SG ids per rds, kept here only to match RDS ENIs (not stored in attrs).
  // RDS ENI를 맞추려고 여기서만 쓰는 서브넷·SG 목록 — attrs에는 넣지 않는다.
  const dbNets: Array<{ db: GraphNode; account: string; subnets: Set<string>; sgs: Set<string> }> = [];
  for (const r of list('rds')) {
    const a = acct(r);
    const db = ix.byArn(str(r.arn) ?? '');
    if (!db) continue;
    const subnets = new Set<string>(), sgs = new Set<string>();
    for (const s of asArray(r.subnets)) {
      const id = field(s, 'SubnetIdentifier');
      if (id) subnets.add(id);
      link(sink, ix, db, a, id, 'subnet', 'in_subnet');
    }
    for (const g of asArray(r.vpc_security_groups)) {
      const id = field(g, 'VpcSecurityGroupId');
      if (id) sgs.add(id);
      link(sink, ix, db, a, id, 'sg', 'uses_sg');
    }
    dbNets.push({ db, account: a, subnets, sgs });
  }
  // RDS ENI: same account, ENI subnet in the db's subnets, ENI SG set equal to the db's.
  // RDS ENI — 같은 계정, ENI 서브넷이 db 서브넷 중 하나, SG 집합이 같으면 rds → eni.
  for (const r of list('eni')) {
    if (str(r.description) !== 'RDSNetworkInterface') continue;
    const a = acct(r);
    const eni = ix.byId(a, str(r.network_interface_id) ?? '', 'eni');
    const subnet = str(r.subnet_id);
    if (!eni || !subnet) continue;
    const groups = new Set<string>();
    for (const g of asArray(r.groups)) { const id = field(g, 'GroupId'); if (id) groups.add(id); }
    for (const d of dbNets) {
      if (d.account !== a || !d.subnets.has(subnet) || !sameSet(d.sgs, groups)) continue;
      sink.add(d.db.arn, eni.arn, 'uses_eni');
    }
  }

  for (const r of list('s3')) {
    const bucket = ix.byArn(str(r.arn) ?? '');
    if (!bucket) continue;
    const cfg = r.event_notification_configuration;
    const lambdas = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).LambdaFunctionConfigurations : undefined;
    for (const c of asArray(lambdas)) {
      const fn = field(c, 'LambdaFunctionArn');
      if (fn) sink.add(bucket.arn, ix.byArn(fn)?.arn, 'notifies');
    }
  }

  // lb lookup by lowercased DNS name, built once. / DNS 이름(소문자)으로 lb를 한 번만 색인.
  const lbByDns = new Map<string, GraphNode>();
  for (const n of ix.nodes) {
    const dns = n.type === 'lb' ? str(n.attrs.dnsName) : undefined;
    if (dns) lbByDns.set(dns.toLowerCase(), n);
  }
  for (const r of list('cloudfront')) {
    const cf = ix.byId(acct(r), str(r.id) ?? '', 'cloudfront');
    if (!cf) continue;
    const partition = str(r.partition) ?? 'aws';
    for (const o of asArray(r.origins)) {
      const domain = field(o, 'DomainName')?.toLowerCase();
      if (!domain) continue;
      const m = S3_WEBSITE.exec(domain) ?? S3_ORIGIN.exec(domain);
      if (m) {
        // Buckets are global: resolve by ARN. / 버킷 이름은 전역이라 ARN으로 찾는다.
        const bucket = ix.byArn(`arn:${partition}:s3:::${m[1]}`);
        if (bucket) sink.add(cf.arn, bucket.arn, 'origin');
        continue;
      }
      const lb = lbByDns.get(domain);
      if (lb) sink.add(cf.arn, lb.arn, 'origin');
    }
  }
}
