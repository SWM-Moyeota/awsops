import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../policy';
import type { ActionKind, IngressRule, ResourceSnapshot, ResourceType, Snapshot, StepChange } from '../types';

const cfg = { maxBlastRadius: 5 };
const OK = { 'awsops:control': 'allow' };

function snap(id: string, over: Partial<ResourceSnapshot> = {}, type: ResourceType = 'instance'): ResourceSnapshot {
  return { type, id, name: id, tags: { ...OK }, ...(type === 'instance' ? { state: 'running' } : { ingress: [], eniCount: 1 }), ...over };
}
function ch(action: ActionKind, id: string, extra: { key?: string; value?: string; rule?: IngressRule } = {}, noop = false, type: ResourceType = 'instance'): StepChange {
  return { index: 0, step: { action, target: { type, id, name: id }, ...extra }, before: '', after: '', noop };
}
const rule = (source: string, fromPort: number, toPort = fromPort): IngressRule => ({ protocol: 'tcp', fromPort, toPort, source });
const sgAdd = (id: string, r: IngressRule) => ch('sg.ingress.add', id, { rule: r }, false, 'security-group');
const sgSnap = (id: string, over: Partial<ResourceSnapshot> = {}) => snap(id, over, 'security-group');
const run = (c: StepChange[], s: ResourceSnapshot[]) => evaluatePolicy(c, Object.fromEntries(s.map(x => [x.id, x])) as Snapshot, cfg);

describe('evaluatePolicy', () => {
  it('allows a clean plan', () => {
    expect(run([ch('ec2.stop', 'i-1')], [snap('i-1')])).toEqual({ ok: true, denials: [] });
  });

  it('deniesEachRule', () => {
    // 1 missing tag
    let r = run([ch('ec2.stop', 'i-1')], [snap('i-1', { tags: {} })]);
    expect(r.ok).toBe(false); expect(r.denials[0]).toContain('i-1'); expect(r.denials[0]).toContain('awsops:control');
    // 2 production, case-insensitive key and value
    for (const tags of [{ ...OK, Environment: 'Production' }, { ...OK, ENV: 'PROD' }, { ...OK, environment: 'prod' }]) {
      expect(run([ch('ec2.stop', 'i-1')], [snap('i-1', { tags })]).ok).toBe(false);
    }
    expect(run([ch('ec2.stop', 'i-1')], [snap('i-1', { tags: { ...OK, env: 'dev' } })]).ok).toBe(true);
    // removing the prod marker is blocked too
    expect(run([ch('tag.remove', 'i-1', { key: 'Environment' })], [snap('i-1', { tags: { ...OK, Environment: 'production' } })]).ok).toBe(false);
    // 3 protected key, set and remove
    for (const a of ['tag.set', 'tag.remove'] as const) {
      r = run([ch(a, 'i-1', { key: 'awsops:control', value: 'allow' })], [snap('i-1')]);
      expect(r.ok).toBe(false); expect(r.denials[0]).toContain('awsops:');
    }
    // 4 world-open
    const sg = [sgSnap('sg-1')];
    expect(run([sgAdd('sg-1', rule('0.0.0.0/0', 22))], sg).ok).toBe(false);
    expect(run([sgAdd('sg-1', rule('0.0.0.0/0', 443))], sg).ok).toBe(true);
    expect(run([sgAdd('sg-1', rule('::/0', 80))], sg).ok).toBe(true);
    expect(run([sgAdd('sg-1', rule('::/0', 8080))], sg).ok).toBe(false);
    expect(run([sgAdd('sg-1', rule('0.0.0.0/0', 80, 443))], sg).ok).toBe(false);
    // 5 broad span
    expect(run([sgAdd('sg-1', rule('10.0.0.0/8', 1000, 3000))], sg).ok).toBe(false);
    expect(run([sgAdd('sg-1', rule('10.0.0.0/8', 1000, 1999))], sg).ok).toBe(true);
    // 6 blast radius
    expect(run([sgAdd('sg-1', rule('10.0.0.0/8', 22))], [sgSnap('sg-1', { eniCount: 6 })]).denials[0]).toContain('콘솔');
    expect(run([sgAdd('sg-1', rule('10.0.0.0/8', 22))], [sgSnap('sg-1', { eniCount: 5 })]).ok).toBe(true);
    // 7 transitional states
    expect(run([ch('ec2.start', 'i-1')], [snap('i-1', { state: 'stopping' })]).ok).toBe(false);
    expect(run([ch('ec2.stop', 'i-1')], [snap('i-1', { state: 'pending' })]).ok).toBe(false);
    expect(run([ch('ec2.start', 'i-1')], [snap('i-1', { state: 'shutting-down' })]).ok).toBe(false);
    expect(run([ch('tag.set', 'i-1', { key: 'a', value: 'b' })], [snap('i-1', { state: 'shutting-down' })]).ok).toBe(false);
    expect(run([ch('ec2.start', 'i-1')], [snap('i-1', { state: 'stopped' })]).ok).toBe(true);
  });

  it('collectsAllDenialsAndIgnoresNoops', () => {
    const r = run(
      [ch('ec2.stop', 'i-1'), ch('ec2.start', 'i-2'), ch('ec2.stop', 'i-3', {}, true), sgAdd('sg-1', rule('0.0.0.0/0', 22))],
      [snap('i-1', { tags: {} }), snap('i-2', { state: 'stopping' }), snap('i-3', { tags: {} }), sgSnap('sg-1', { eniCount: 9 })],
    );
    expect(r.ok).toBe(false);
    expect(r.denials.length).toBe(4);
    expect(r.denials.some(d => d.includes('i-3'))).toBe(false);
  });

  it('sanitizes display names', () => {
    const r = run([ch('ec2.stop', 'i-1')], [snap('i-1', { name: '`<@here>`*x*', tags: {} })]);
    expect(r.denials[0]).not.toMatch(/[`<>*]/);
  });
});
