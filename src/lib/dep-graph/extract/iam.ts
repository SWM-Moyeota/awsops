// IAM edges: role can_access resources named in its Allow policies.
// IAM 간선 — 정책 문서의 Allow Resource ARN을 읽어 role → 리소스를 잇는다.
import type { Row, Rows } from '../types';
import type { NodeIndex } from '../nodes';
import { asArray, str } from '../nodes';
import type { EdgeSink } from '../sink';
import { listRows } from './util';

const S3_PREFIX = /^arn:(aws[a-z-]*):s3:::([^/*?]+)\//;

function parseDoc(doc: unknown): Record<string, unknown> | undefined {
  if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch { return undefined; } }
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
}

/** Resource strings of Allow statements. Never throws. / Allow 문장의 Resource 문자열 모음. */
export function policyResourceArns(doc: unknown): string[] {
  const d = parseDoc(doc);
  if (!d) return [];
  const st = d.Statement;
  const statements = Array.isArray(st) ? st : st && typeof st === 'object' ? [st] : [];
  const out: string[] = [];
  for (const s of statements) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (o.Effect !== 'Allow') continue;
    const res = Array.isArray(o.Resource) ? o.Resource : [o.Resource];
    for (const x of res) { const v = str(x); if (v) out.push(v); }
  }
  return out;
}

export function iamEdges(rows: Rows, ix: NodeIndex, sink: EdgeSink): void {
  const policyDocs = new Map<string, unknown>();
  for (const p of listRows(rows, 'policy')) {
    const arn = str(p.arn);
    if (arn && p.policy_std) policyDocs.set(arn, p.policy_std);
  }

  // Policies come from rolePolicy rows, matched to role nodes by ARN.
  // 정책은 rolePolicy 행에서 읽고 ARN으로 역할 노드에 맞춘다.
  for (const r of listRows(rows, 'rolePolicy') as Row[]) {
    const role = ix.byArn(str(r.arn) ?? '');
    if (!role || role.type !== 'role') continue;
    const docs: unknown[] = [];
    for (const ip of asArray(r.inline_policies_std)) {
      if (ip && typeof ip === 'object') docs.push((ip as Record<string, unknown>).PolicyDocument);
    }
    for (const pa of asArray(r.attached_policy_arns)) {
      const doc = policyDocs.get(str(pa) ?? '');
      if (doc) docs.push(doc);
    }
    for (const doc of docs) {
      for (const res of policyResourceArns(doc)) {
        let target = res;
        if (/[*?]/.test(res)) {
          // Only S3 bucket/prefix wildcards are honored. / 와일드카드는 S3 버킷 접두사만 인정.
          const m = S3_PREFIX.exec(res);
          if (!m) continue;
          target = `arn:${m[1]}:s3:::${m[2]}`;
        }
        const dst = ix.byArn(target);
        if (dst) sink.add(role.arn, dst.arn, 'can_access');
      }
    }
  }
}
