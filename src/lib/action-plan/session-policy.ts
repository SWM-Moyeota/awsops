// Inline session policy + drift check for the scoped executor (spec 3.7, 3.9).
// 실행 역할을 맡을 때 붙이는 인라인 세션 정책과, 실행 직전 상태 변화 검사.
import type { ActionKind, ResolvedStep, Snapshot, SnapshotRule, StepChange } from './types';

const ACTION_MAP: Record<ActionKind, string> = {
  'ec2.start': 'ec2:StartInstances',
  'ec2.stop': 'ec2:StopInstances',
  'tag.set': 'ec2:CreateTags',
  'tag.remove': 'ec2:DeleteTags',
  'sg.ingress.add': 'ec2:AuthorizeSecurityGroupIngress',
  'sg.ingress.remove': 'ec2:RevokeSecurityGroupIngress',
};

/** AWS session policies are limited to 2048 packed characters. */
export const SESSION_POLICY_MAX_CHARS = 2048;

/**
 * One Allow statement per action, resources limited to the exact ARNs of the plan's targets.
 *
 * security-group-rule ARN: NOT added. Source: AWS Service Authorization Reference for Amazon EC2
 * (list_amazonec2.html; machine-readable copy https://servicereference.us-east-1.amazonaws.com/v1/ec2/ec2.json,
 * checked 2026-10-28). RevokeSecurityGroupIngress lists only the `security-group` resource type.
 * AuthorizeSecurityGroupIngress lists `security-group` plus an optional `security-group-rule`, whose only
 * condition keys are aws:RequestTag/aws:TagKeys (i.e. it matters only when TagSpecifications are passed;
 * the executor never passes any). So the SG ARN alone is enough and no wildcard is granted.
 * Task 14's IAM script should likewise grant on the security-group ARN only.
 */
export function buildSessionPolicy(steps: ResolvedStep[], account: string, region: string): object {
  const byAction = new Map<string, Set<string>>();
  for (const s of steps) {
    const action = ACTION_MAP[s.action];
    const kind = s.target.type === 'instance' ? 'instance' : 'security-group';
    const arn = `arn:aws:ec2:${region}:${account}:${kind}/${s.target.id}`;
    if (!byAction.has(action)) byAction.set(action, new Set());
    byAction.get(action)!.add(arn);
  }
  const policy = {
    Version: '2012-10-17',
    Statement: Array.from(byAction, ([action, arns]) => ({
      Effect: 'Allow',
      Action: action,
      Resource: Array.from(arns),
    })),
  };
  const size = JSON.stringify(policy).length;
  if (size > SESSION_POLICY_MAX_CHARS) {
    throw new Error(`session policy too large (${size} > ${SESSION_POLICY_MAX_CHARS})`);
  }
  return policy;
}

function sameRule(a: SnapshotRule, b: { protocol: string; fromPort: number; toPort: number; source: string }): boolean {
  return a.protocol === b.protocol && a.fromPort === b.fromPort && a.toPort === b.toPort && a.source === b.source;
}

function hasRule(rules: SnapshotRule[] | undefined, step: ResolvedStep): boolean {
  const list = rules ?? [];
  if (step.ruleId) return list.some((r) => r.ruleId === step.ruleId);
  return step.rule ? list.some((r) => sameRule(r, step.rule!)) : false;
}

/** One Korean reason per non-noop step whose touched field changed since plan time. */
export function findDrift(changes: StepChange[], planSnap: Snapshot, fresh: Snapshot): string[] {
  const reasons: string[] = [];
  for (const c of changes) {
    if (c.noop) continue;
    const { step } = c;
    const id = step.target.id;
    const name = step.target.name;
    const was = planSnap[id];
    const now = fresh[id];
    if (!now) {
      reasons.push(`${name}을(를) 더 이상 찾을 수 없어요`);
      continue;
    }
    switch (step.action) {
      case 'ec2.start':
      case 'ec2.stop':
        if (was?.state !== now.state) reasons.push(`${name}의 상태가 ${was?.state ?? '알 수 없음'}에서 ${now.state ?? '알 수 없음'}(으)로 바뀌었어요`);
        break;
      case 'tag.set':
      case 'tag.remove': {
        const key = step.key ?? '';
        const a = was?.tags?.[key];
        const b = now.tags?.[key];
        if (a !== b) reasons.push(`${name}의 태그 ${key} 값이 바뀌었어요`);
        break;
      }
      case 'sg.ingress.add':
      case 'sg.ingress.remove':
        if (hasRule(was?.ingress, step) !== hasRule(now.ingress, step)) {
          reasons.push(`${name}의 인바운드 규칙이 그 사이에 바뀌었어요`);
        }
        break;
    }
  }
  return reasons;
}
