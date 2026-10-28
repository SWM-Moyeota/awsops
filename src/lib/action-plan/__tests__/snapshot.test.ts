import { describe, it, expect } from 'vitest';
import { takeSnapshot, SnapshotError } from '../snapshot';
import type { Ec2Reader, ResolvedStep, Resource } from '../types';

const inst: Resource = { type: 'instance', id: 'i-1', name: 'web', tags: { 'awsops:control': 'allow' }, state: 'running' };
const sg: Resource = { type: 'security-group', id: 'sg-1', name: 'web-sg', tags: { 'awsops:control': 'allow' } };

function reader(over: Partial<Record<string, Resource | null>> = {}): Ec2Reader & { calls: string[] } {
  const calls: string[] = [];
  const all: Record<string, Resource | null> = { 'i-1': inst, 'sg-1': sg, ...over };
  return {
    calls,
    listTaggedInstances: async () => [],
    listTaggedSecurityGroups: async () => [],
    describeInstance: async id => (calls.push(id), all[id] ?? null),
    describeSecurityGroup: async id => (calls.push(id), all[id] ?? null),
    listIngressRules: async () => [{ ruleId: 'sgr-1', protocol: 'tcp', fromPort: 22, toPort: 22, source: '10.0.0.0/8' }],
    listEniUsers: async () => ({ eniCount: 2, instances: [{ id: 'i-1', name: 'web' }] }),
  };
}
const step = (id: string, type: 'instance' | 'security-group'): ResolvedStep => ({
  action: type === 'instance' ? 'ec2.stop' : 'sg.ingress.add',
  target: { type, id, name: id },
});

describe('takeSnapshot', () => {
  it('reads each target once and fills group details', async () => {
    const r = reader();
    const s = await takeSnapshot([step('i-1', 'instance'), step('i-1', 'instance'), step('sg-1', 'security-group')], r);
    expect(r.calls).toEqual(['i-1', 'sg-1']);
    expect(s['i-1'].state).toBe('running');
    expect(s['sg-1'].ingress).toHaveLength(1);
    expect(s['sg-1'].eniCount).toBe(2);
    expect(s['sg-1'].attachedInstances).toEqual([{ id: 'i-1', name: 'web' }]);
  });

  it('snapshotThrowsWhenTargetLostItsTag', async () => {
    const r = reader({ 'i-1': { ...inst, tags: {} } });
    await expect(takeSnapshot([step('i-1', 'instance')], r)).rejects.toMatchObject({ name: 'SnapshotError', resourceId: 'i-1' });
    await expect(takeSnapshot([step('i-1', 'instance')], r)).rejects.toBeInstanceOf(SnapshotError);
  });

  it('throws when a target is missing', async () => {
    const r = reader({ 'sg-1': null });
    await expect(takeSnapshot([step('sg-1', 'security-group')], r)).rejects.toThrow('sg-1');
  });
});
