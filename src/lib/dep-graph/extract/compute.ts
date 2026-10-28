// Compute edges: instance and lambda relations.
// 컴퓨트 간선 추출 — instance, lambda, ebs 연결.
import type { Row, Rows } from '../types';
import type { NodeIndex } from '../nodes';
import { asArray, str } from '../nodes';
import type { EdgeSink } from '../sink';
import { acct, field, listRows } from './util';
import { link } from './network';

export function computeEdges(rows: Rows, ix: NodeIndex, sink: EdgeSink): void {
  const list = (q: keyof Rows): Row[] => listRows(rows, q);

  // instance profile ARN -> role ARN. / 인스턴스 프로파일 ARN을 역할 ARN으로.
  const profileToRole = new Map<string, string>();
  for (const r of list('role')) {
    const arn = str(r.arn);
    if (!arn) continue;
    for (const p of asArray(r.instance_profile_arns)) { const s = str(p); if (s) profileToRole.set(s, arn); }
  }

  for (const r of list('instance')) {
    const a = acct(r);
    const inst = ix.byId(a, str(r.instance_id) ?? '', 'instance');
    if (!inst) continue;
    link(sink, ix, inst, a, str(r.subnet_id), 'subnet', 'in_subnet');
    for (const g of asArray(r.security_groups)) link(sink, ix, inst, a, field(g, 'GroupId'), 'sg', 'uses_sg');
    const prof = str(r.iam_instance_profile_arn);
    if (prof) sink.add(inst.arn, profileToRole.get(prof), 'uses_role');
  }
  for (const r of list('ebs')) {
    const a = acct(r);
    const ebs = ix.byId(a, str(r.volume_id) ?? '', 'ebs');
    if (!ebs) continue;
    for (const at of asArray(r.attachments)) {
      const id = field(at, 'InstanceId');
      if (id) sink.add(ix.byId(a, id, 'instance')?.arn, ebs.arn, 'uses_volume');
    }
  }
  for (const r of list('lambda')) {
    const a = acct(r);
    // By ARN: names are only unique per region. / 이름은 리전마다만 유일해서 ARN으로 찾는다.
    const fn = ix.byArn(str(r.arn) ?? '');
    if (!fn) continue;
    const role = str(r.role);
    if (role) sink.add(fn.arn, ix.byArn(role)?.arn, 'uses_role');
    for (const s of asArray(r.vpc_subnet_ids)) link(sink, ix, fn, a, str(s), 'subnet', 'in_subnet');
    for (const g of asArray(r.vpc_security_group_ids)) link(sink, ix, fn, a, str(g), 'sg', 'uses_sg');
  }
}
