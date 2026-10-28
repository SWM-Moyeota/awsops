import { describe, it, expect } from 'vitest';
import { resolveSteps } from '../resolve';
import type { PlannedStep, Resource } from '../types';

const inst = (id: string, name: string, sgs: string[] = []): Resource =>
  ({ type: 'instance', id, name, tags: {}, state: 'running', securityGroupIds: sgs });
const grp = (id: string, name: string): Resource =>
  ({ type: 'security-group', id, name, groupName: name, tags: {} });
const stop = (ref: string): PlannedStep => ({ action: 'ec2.stop', ref });
const rule = { protocol: 'tcp' as const, fromPort: 22, toPort: 22, source: '1.2.3.4/32' };

describe('resolveSteps', () => {
  it('resolvesByIdAndWholeTokenName', () => {
    const instances = [inst('i-aaa111', 'api-dev'), inst('i-bbb222', 'api-dev-2')];
    const c = { instances, groups: [] };
    const byId = resolveSteps([stop('i-bbb222')], c, 3);
    expect(byId).toEqual({ kind: 'ok', steps: [{ action: 'ec2.stop', target: { type: 'instance', id: 'i-bbb222', name: 'api-dev-2' } }] });
    const byName = resolveSteps([stop('API-DEV 꺼줘')], c, 3);
    expect(byName.kind).toBe('ok');
    if (byName.kind === 'ok') expect(byName.steps[0].target.id).toBe('i-aaa111');
    const both = resolveSteps([stop('api-dev')], { instances: [inst('i-aaa111', 'api-dev-2')], groups: [] }, 3);
    expect(both.kind).toBe('not-found');
  });

  it('sgStepOnInstanceUsesItsOnlyTaggedGroupElseAmbiguous', () => {
    const step: PlannedStep = { action: 'sg.ingress.add', ref: 'api-dev', rule };
    const groups = [grp('sg-1', 'web'), grp('sg-2', 'db')];
    const one = resolveSteps([step], { instances: [inst('i-a', 'api-dev', ['sg-1', 'sg-untagged'])], groups }, 3);
    expect(one.kind).toBe('ok');
    if (one.kind === 'ok') expect(one.steps[0]).toMatchObject({ target: { id: 'sg-1' }, rule });
    const two = resolveSteps([step], { instances: [inst('i-a', 'api-dev', ['sg-1', 'sg-2'])], groups }, 3);
    expect(two).toMatchObject({ kind: 'ambiguous', ref: 'api-dev' });
    if (two.kind === 'ambiguous') expect(two.candidates.map(x => x.id)).toEqual(['sg-1', 'sg-2']);
    const none = resolveSteps([step], { instances: [inst('i-a', 'api-dev', ['sg-x'])], groups }, 3);
    expect(none.kind).toBe('ambiguous');
  });

  it('untaggedResourcesAreNeverCandidates', () => {
    const r = resolveSteps([stop('prod-db')], { instances: [inst('i-a', 'api-dev')], groups: [grp('sg-1', 'web')] }, 3);
    expect(r).toEqual({ kind: 'not-found', ref: 'prod-db', candidates: [{ type: 'instance', id: 'i-a', name: 'api-dev' }] });
  });

  it('tag steps search both instances and groups', () => {
    const r = resolveSteps([{ action: 'tag.set', ref: 'web', key: 'a', value: 'b' }], { instances: [], groups: [grp('sg-1', 'web')] }, 3);
    expect(r).toMatchObject({ kind: 'ok', steps: [{ target: { id: 'sg-1' }, key: 'a', value: 'b' }] });
  });

  it('moreThanMaxResourcesIsRejected', () => {
    const instances = ['a', 'b', 'c', 'd'].map(n => inst(`i-${n}`, `srv-${n}`));
    const steps = instances.map(i => stop(i.id));
    expect(resolveSteps(steps, { instances, groups: [] }, 3)).toEqual({ kind: 'too-many-resources', count: 4 });
    expect(resolveSteps([...steps.slice(0, 3), stop('i-a')], { instances, groups: [] }, 3).kind).toBe('ok');
  });
});
