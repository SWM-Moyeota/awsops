import { describe, it, expect } from 'vitest';
import { computeChanges } from '../changes';
import type { ResolvedStep, Snapshot } from '../types';

const I = { type: 'instance' as const, id: 'i-1', name: 'web' };
const G = { type: 'security-group' as const, id: 'sg-1', name: 'web-sg' };
const snap = (): Snapshot => ({
  'i-1': { type: 'instance', id: 'i-1', name: 'web', state: 'stopped', tags: { owner: 'old', env: 'dev' } },
  'sg-1': {
    type: 'security-group', id: 'sg-1', name: 'web-sg', tags: {}, eniCount: 1,
    ingress: [{ ruleId: 'sgr-9', protocol: 'tcp', fromPort: 22, toPort: 22, source: '10.0.0.0/8', description: 'ssh' }],
  },
});
const rule = (p: number, src: string) => ({ protocol: 'tcp' as const, fromPort: p, toPort: p, source: src });

describe('computeChanges', () => {
  it('noopsAreMarkedNotErrors', () => {
    const steps: ResolvedStep[] = [
      { action: 'ec2.stop', target: I },
      { action: 'tag.set', target: I, key: 'owner', value: 'old' },
      { action: 'tag.remove', target: I, key: 'nope' },
      { action: 'sg.ingress.add', target: G, rule: { ...rule(22, '10.0.0.0/8'), description: 'other' } },
    ];
    const { changes, errors } = computeChanges(steps, snap());
    expect(errors).toEqual([]);
    expect(changes.map(c => c.noop)).toEqual([true, true, true, true]);
    expect(changes.every(c => c.inverse === undefined)).toBe(true);
  });

  it('inversesAreComputedFromSnapshotValues', () => {
    const steps: ResolvedStep[] = [
      { action: 'ec2.start', target: I },
      { action: 'tag.set', target: I, key: 'new', value: 'x' },
      { action: 'tag.set', target: I, key: 'owner', value: 'jiwoo' },
      { action: 'tag.remove', target: I, key: 'env' },
      { action: 'sg.ingress.remove', target: G, rule: rule(22, '10.0.0.0/8') },
      { action: 'sg.ingress.add', target: G, rule: rule(8080, '203.0.113.0/24') },
    ];
    const { changes, errors } = computeChanges(steps, snap());
    expect(errors).toEqual([]);
    expect(changes[0].inverse).toEqual({ action: 'ec2.stop', target: I });
    expect(changes[1].inverse).toEqual({ action: 'tag.remove', target: I, key: 'new' });
    expect(changes[2].inverse).toEqual({ action: 'tag.set', target: I, key: 'owner', value: 'old' });
    expect(changes[2].after).toBe('태그 owner: old → jiwoo');
    expect(changes[3].inverse).toEqual({ action: 'tag.set', target: I, key: 'env', value: 'dev' });
    expect(changes[4].step.ruleId).toBe('sgr-9');
    expect(changes[4].inverse).toEqual({ action: 'sg.ingress.add', target: G, rule: { ...rule(22, '10.0.0.0/8'), description: 'ssh' } });
    expect(changes[5].after).toBe('인바운드 tcp 8080 ← 203.0.113.0/24 추가');
    expect(changes[5].inverse).toBeUndefined();
  });

  it('shows the tag example text', () => {
    const s = snap();
    delete s['i-1'].tags.owner;
    const { changes } = computeChanges([{ action: 'tag.set', target: I, key: 'owner', value: 'jiwoo' }], s);
    expect(changes[0].after).toBe('태그 owner: (없음) → jiwoo');
  });

  it('secondStepSeesFirstStepsResult', () => {
    const { changes } = computeChanges(
      [
        { action: 'tag.set', target: I, key: 'owner', value: 'a' },
        { action: 'tag.set', target: I, key: 'owner', value: 'b' },
      ],
      snap(),
    );
    expect(changes[1].before).toBe('태그 owner: a');
    expect(changes[1].inverse).toEqual({ action: 'tag.set', target: I, key: 'owner', value: 'a' });
  });

  it('removeOfMissingRuleIsError', () => {
    const { changes, errors } = computeChanges([{ action: 'sg.ingress.remove', target: G, rule: rule(80, '1.2.3.4/32') }], snap());
    expect(errors).toEqual(['그런 규칙이 없어요']);
    expect(changes).toEqual([]);
  });
});
