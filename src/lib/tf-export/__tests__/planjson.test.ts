import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { judgePlan } from '../planjson';

describe('judgePlan', () => {
  it('fixture: 13 pass, 1 changed on user_data', () => {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/plan.json'), 'utf8'));
    const m = judgePlan(j);
    const vals = Array.from(m.values());
    expect(vals.filter((v) => v.outcome === 'pass')).toHaveLength(13);
    const ch = vals.filter((v) => v.outcome === 'changed');
    expect(ch).toHaveLength(1);
    expect(m.get('aws_instance.r_instance')!.changedPaths).toContain('user_data');
    expect(m.get('aws_instance.r_instance')!.changedPaths).toContain('user_data_replace_on_change');
    expect(vals.some((v) => v.outcome === 'missing')).toBe(false);
  });
  it('skips data sources and labels whole-resource change', () => {
    const m = judgePlan({ resource_changes: [
      { address: 'data.x.y', mode: 'data', change: { actions: ['read'] } },
      { address: 'a.new', mode: 'managed', change: { actions: ['create'], before: null, after: null } }] });
    expect(m.has('data.x.y')).toBe(false);
    expect(m.get('a.new')!.changedPaths).toEqual(['(resource)']);
  });
  it('diff paths, unknown skipping, cap, missing', () => {
    const m = judgePlan({
      resource_changes: [{ address: 'a.b', change: { actions: ['update'], before: { tags: { Name: 'x' }, ingress: [{ cidr: 1 }], k: 1 }, after: { tags: { Name: 'y' }, ingress: [{ cidr: 2 }], k: 2 }, after_unknown: { k: true } } },
        { address: 'a.big', change: { actions: ['update'], before: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 0])), after: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 1])) } },
        { address: 'a.noimp', change: { actions: ['no-op'], before: {}, after: {} } }],
      configuration: { root_module: { resources: [{ address: 'a.b' }, { address: 'a.gone' }] } },
    });
    expect(m.get('a.b')!.changedPaths).toEqual(['tags.Name', 'ingress[0].cidr']);
    expect(m.get('a.big')!.changedPaths).toHaveLength(20);
    expect(m.get('a.noimp')!.outcome).toBe('changed');
    expect(m.get('a.gone')!.outcome).toBe('missing');
  });
});
