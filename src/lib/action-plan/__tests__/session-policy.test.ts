import { describe, it, expect } from 'vitest';
import { buildSessionPolicy, findDrift } from '../session-policy';
import type { ResolvedStep, Snapshot, StepChange } from '../types';

const inst = { type: 'instance' as const, id: 'i-0abc', name: 'web' };
const sg = { type: 'security-group' as const, id: 'sg-0abc', name: 'web-sg' };
const rule = { protocol: 'tcp' as const, fromPort: 443, toPort: 443, source: '10.0.0.0/8' };

const steps: ResolvedStep[] = [
  { action: 'ec2.start', target: inst },
  { action: 'ec2.stop', target: inst },
  { action: 'tag.set', target: inst, key: 'a', value: 'b' },
  { action: 'tag.remove', target: inst, key: 'a' },
  { action: 'sg.ingress.add', target: sg, rule },
  { action: 'sg.ingress.remove', target: sg, rule, ruleId: 'sgr-1' },
];

describe('buildSessionPolicy', () => {
  it('sessionPolicyListsExactlyThePlansActionsAndArns', () => {
    const p = buildSessionPolicy(steps, '123456789012', 'ap-northeast-2') as any;
    const actions = p.Statement.map((s: any) => s.Action).sort();
    expect(actions).toEqual([
      'ec2:AuthorizeSecurityGroupIngress', 'ec2:CreateTags', 'ec2:DeleteTags',
      'ec2:RevokeSecurityGroupIngress', 'ec2:StartInstances', 'ec2:StopInstances',
    ]);
    const all = p.Statement.flatMap((s: any) => s.Resource);
    expect(all.some((r: string) => r.includes('*'))).toBe(false);
    expect(new Set(all)).toEqual(new Set([
      'arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0abc',
      'arn:aws:ec2:ap-northeast-2:123456789012:security-group/sg-0abc',
    ]));
    const start = p.Statement.find((s: any) => s.Action === 'ec2:StartInstances');
    expect(start.Resource).toEqual(['arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0abc']);
  });

  it('stays under 2048 chars for the max plan and throws beyond', () => {
    const mk = (n: number): ResolvedStep[] =>
      Array.from({ length: n }, (_, i) => ({ action: 'tag.set' as const, target: { type: 'instance' as const, id: `i-${String(i).padStart(17, '0')}`, name: 'x' }, key: 'k', value: 'v' }));
    expect(() => buildSessionPolicy(mk(3), '123456789012', 'ap-northeast-2')).not.toThrow();
    expect(() => buildSessionPolicy(mk(40), '123456789012', 'ap-northeast-2')).toThrow(/too large/);
  });
});

describe('findDrift', () => {
  const snap = (over: Partial<Snapshot[string]> = {}, sgRules = [{ ...rule, ruleId: 'sgr-1' }]): Snapshot => ({
    'i-0abc': { type: 'instance', id: 'i-0abc', name: 'web', tags: { a: 'b' }, state: 'running', ...over },
    'sg-0abc': { type: 'security-group', id: 'sg-0abc', name: 'web-sg', tags: {}, ingress: sgRules },
  });
  const ch = (step: ResolvedStep, i = 0, noop = false): StepChange => ({ index: i, step, before: '', after: '', noop });

  it('driftDetectsTagValueStateAndRuleChanges', () => {
    const base = snap();
    expect(findDrift(steps.map((s, i) => ch(s, i)), base, snap())).toEqual([]);
    expect(findDrift([ch(steps[1])], base, snap({ state: 'stopped' }))).toHaveLength(1);
    expect(findDrift([ch(steps[2])], base, snap({ tags: { a: 'c' } }))).toHaveLength(1);
    expect(findDrift([ch(steps[3])], base, snap({ tags: {} }))).toHaveLength(1);
    // tag change on an unrelated key is not drift
    expect(findDrift([ch(steps[2])], base, snap({ tags: { a: 'b', z: '1' } }))).toEqual([]);
    expect(findDrift([ch(steps[5])], base, snap({}, []))).toHaveLength(1);
    expect(findDrift([ch(steps[4])], snap({}, []), snap())).toHaveLength(1);
    // vanished target and noop
    expect(findDrift([ch(steps[1])], base, {})).toHaveLength(1);
    expect(findDrift([ch(steps[1], 0, true)], base, snap({ state: 'stopped' }))).toEqual([]);
  });
});
