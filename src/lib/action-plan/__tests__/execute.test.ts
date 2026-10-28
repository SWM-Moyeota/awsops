import { describe, it, expect } from 'vitest';
import { executeChanges, dryRunAll, afterCheckFor } from '../execute';
import type { Ec2Writer, ResolvedStep, StepChange } from '../types';

const inst = { type: 'instance' as const, id: 'i-1', name: 'web' };
const sg = { type: 'security-group' as const, id: 'sg-1', name: 'sg' };
const rule = { protocol: 'tcp' as const, fromPort: 22, toPort: 22, source: '1.2.3.4/32' };
const ch = (index: number, step: ResolvedStep, extra: Partial<StepChange> = {}): StepChange => ({ index, step, before: '', after: '', noop: false, ...extra });

const named = (name: string) => Object.assign(new Error('secret detail'), { name });

describe('executeChanges', () => {
  it('stopsAtFirstFailureAndKeepsInverseOfDoneSteps', async () => {
    const calls: string[] = [];
    const writer: Ec2Writer = {
      async run(step, dry) {
        calls.push(step.action + (dry ? ':dry' : ''));
        if (step.action === 'tag.set') throw named('UnauthorizedOperation');
        return { requestId: 'req-' + calls.length, ruleId: step.action === 'sg.ingress.add' ? 'sgr-9' : undefined };
      },
    };
    const stopInverse: ResolvedStep = { action: 'ec2.start', target: inst };
    const changes: StepChange[] = [
      ch(0, { action: 'ec2.stop', target: inst }, { inverse: stopInverse }),
      ch(1, { action: 'sg.ingress.add', target: sg, rule }),
      ch(2, { action: 'ec2.start', target: inst }, { noop: true }),
      ch(3, { action: 'tag.set', target: inst, key: 'k', value: 'v' }),
      ch(4, { action: 'ec2.start', target: inst }),
    ];
    const r = await executeChanges(changes, writer);
    expect(r.map((x) => [x.index, x.status])).toEqual([[0, 'done'], [1, 'done'], [3, 'failed'], [4, 'not-run']]);
    expect(r[0].inverse).toEqual(stopInverse);
    expect(r[0].requestId).toBe('req-1');
    expect(r[0].after).toEqual({ kind: 'instance-state', id: 'i-1', states: ['stopping', 'stopped'] });
    expect(r[1].inverse).toEqual({ action: 'sg.ingress.remove', target: sg, rule, ruleId: 'sgr-9' });
    expect(r[1].after).toEqual({ kind: 'rule-present', sgId: 'sg-1', ruleId: 'sgr-9' });
    expect(r[2].error).toBe('UnauthorizedOperation');
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(calls).toEqual(['ec2.stop', 'sg.ingress.add', 'tag.set']);
  });
});

describe('dryRunAll', () => {
  it('dryRunReportsUnauthorizedByName', async () => {
    const writer: Ec2Writer = {
      async run(step, dry) {
        expect(dry).toBe(true);
        if (step.action === 'ec2.stop') throw named('UnauthorizedOperation');
        return {};
      },
    };
    const ok = await dryRunAll([ch(0, { action: 'ec2.start', target: inst })], writer);
    expect(ok).toEqual({ ok: true });
    const bad = await dryRunAll([ch(0, { action: 'ec2.start', target: inst }), ch(1, { action: 'ec2.stop', target: inst })], writer);
    expect(bad).toEqual({ ok: false, error: 'UnauthorizedOperation' });
  });
});

describe('afterCheckFor', () => {
  it('maps every action', () => {
    expect(afterCheckFor({ action: 'ec2.start', target: inst })).toEqual({ kind: 'instance-state', id: 'i-1', states: ['pending', 'running'] });
    expect(afterCheckFor({ action: 'tag.set', target: inst, key: 'k', value: 'v' })).toEqual({ kind: 'tag', id: 'i-1', key: 'k', value: 'v' });
    expect(afterCheckFor({ action: 'tag.remove', target: inst, key: 'k' })).toEqual({ kind: 'tag', id: 'i-1', key: 'k', value: null });
    expect(afterCheckFor({ action: 'sg.ingress.remove', target: sg, rule, ruleId: 'sgr-1' })).toEqual({ kind: 'rule-absent', sgId: 'sg-1', rule });
  });
});
