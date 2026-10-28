// Network edges: vpc/subnet/sg/eni/lb/eip/nat relations.
// 네트워크 간선 추출 — null/이상한 모양의 열은 건너뛰고 던지지 않는다.
import type { EdgeType, GraphNode, NodeType, Row, Rows } from '../types';
import type { NodeIndex } from '../nodes';
import { asArray, str } from '../nodes';
import type { EdgeSink } from '../sink';
import { acct, field, listRows } from './util';

/** Adds src -> (id resolved by type). Empty id adds nothing; unresolved id counts as dropped. */
// id가 비면 무시, 있는데 노드가 없으면 dropped로 센다.
export function link(
  sink: EdgeSink, ix: NodeIndex, src: GraphNode | undefined, account: string,
  id: string | undefined, type: NodeType, edge: EdgeType,
): void {
  if (!src || !id) return;
  sink.add(src.arn, ix.byId(account, id, type)?.arn, edge);
}

const LB_TAIL = /:loadbalancer\/((?:app|net)\/[^/]+\/[0-9a-f]+)$/;
const ELB_DESC = /^ELB ((?:app|net)\/[^/]+\/[0-9a-f]+)$/;
const LAMBDA_DESC = /^AWS Lambda VPC ENI-(.+)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// Hyperplane ENIs in real data carry no uuid: "AWS Lambda VPC ENI-<name>". Tried after LAMBDA_DESC.
// 실데이터의 Hyperplane ENI는 uuid 없이 "AWS Lambda VPC ENI-<이름>" — LAMBDA_DESC 다음에 시도한다.
const LAMBDA_DESC_BARE = /^AWS Lambda VPC ENI-(.+)$/;

export function networkEdges(rows: Rows, ix: NodeIndex, sink: EdgeSink): void {
  const list = (q: keyof Rows): Row[] => listRows(rows, q);

  // lb lookup by account + ARN tail, built once. / 계정+ARN 끝부분으로 lb를 한 번만 색인.
  const lbByTail = new Map<string, GraphNode>();
  for (const n of ix.nodes) {
    if (n.type !== 'lb') continue;
    const m = LB_TAIL.exec(n.arn);
    if (m) lbByTail.set(`${n.accountId}\0${m[1]}`, n);
  }
  // lambda lookup by account + region + name (names repeat across regions).
  // 계정+리전+이름으로 lambda 색인 — 이름은 리전이 다르면 겹칠 수 있다.
  const lambdaByName = new Map<string, GraphNode>();
  for (const n of ix.nodes) if (n.type === 'lambda') lambdaByName.set(`${n.accountId}\0${n.region}\0${n.id}`, n);

  for (const r of list('subnet')) {
    const a = acct(r);
    link(sink, ix, ix.byId(a, str(r.subnet_id) ?? '', 'subnet'), a, str(r.vpc_id), 'vpc', 'in_vpc');
  }
  for (const r of list('sg')) {
    const a = acct(r);
    link(sink, ix, ix.byId(a, str(r.group_id) ?? '', 'sg'), a, str(r.vpc_id), 'vpc', 'in_vpc');
  }
  for (const r of list('sgRule')) {
    if (r.is_egress !== false) continue;
    const ref = str(r.referenced_group_id);
    const gid = str(r.group_id);
    if (!ref || !gid) continue;
    const a = acct(r);
    link(sink, ix, ix.byId(a, gid, 'sg'), a, ref, 'sg', 'allows_from');
  }
  for (const r of list('eni')) {
    const a = acct(r);
    const eni = ix.byId(a, str(r.network_interface_id) ?? '', 'eni');
    if (!eni) continue;
    link(sink, ix, eni, a, str(r.subnet_id), 'subnet', 'in_subnet');
    for (const g of asArray(r.groups)) link(sink, ix, eni, a, field(g, 'GroupId'), 'sg', 'uses_sg');
    const inst = str(r.attached_instance_id);
    if (inst) sink.add(ix.byId(a, inst, 'instance')?.arn, eni.arn, 'uses_eni');
    const desc = str(r.description);
    const m = desc ? ELB_DESC.exec(desc) : null;
    if (m) sink.add(lbByTail.get(`${a}\0${m[1]}`)?.arn, eni.arn, 'uses_eni');
    // Lambda ENI: only when that lambda is in the graph; no match is not dropped.
    // 람다 ENI — 그 람다가 그래프에 있을 때만 잇고, 없으면 dropped로 세지 않는다.
    if (desc) {
      const key = (name: string | undefined) => (name ? lambdaByName.get(`${a}\0${str(r.region) ?? ''}\0${name}`) : undefined);
      const fn = key(LAMBDA_DESC.exec(desc)?.[1]) ?? key(LAMBDA_DESC_BARE.exec(desc)?.[1]);
      if (fn) sink.add(fn.arn, eni.arn, 'uses_eni');
    }
  }
  for (const r of list('eip')) {
    const a = acct(r);
    const eip = ix.byId(a, str(r.allocation_id) ?? '', 'eip');
    if (!eip) continue;
    const eniId = str(r.network_interface_id);
    const instId = str(r.instance_id);
    // ENI wins over instance. / ENI가 있으면 ENI만 잇는다.
    if (eniId) sink.add(ix.byId(a, eniId, 'eni')?.arn, eip.arn, 'uses_eip');
    else if (instId) sink.add(ix.byId(a, instId, 'instance')?.arn, eip.arn, 'uses_eip');
  }
  for (const r of list('nat')) {
    const a = acct(r);
    const nat = ix.byId(a, str(r.nat_gateway_id) ?? '', 'nat');
    if (!nat) continue;
    link(sink, ix, nat, a, str(r.subnet_id), 'subnet', 'in_subnet');
    for (const ad of asArray(r.nat_gateway_addresses)) {
      link(sink, ix, nat, a, field(ad, 'NetworkInterfaceId'), 'eni', 'uses_eni');
      link(sink, ix, nat, a, field(ad, 'AllocationId'), 'eip', 'uses_eip');
    }
  }
}
