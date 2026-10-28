import { describe, it, expect } from 'vitest';
import { validatePlannerOutput, canonicalCidr } from '../validate';

const opts = { aliases: { 사무실: ['10.1.1.1/32', '10.2.2.2/32'] } as Record<string, string[]>, maxSteps: 5 };
const sg = (over: Record<string, unknown> = {}) => ({ action: 'sg.ingress.add', ref: 'web-sg', protocol: 'tcp', fromPort: 80, toPort: 80, source: '10.0.0.0/24', ...over });
const plan = (...steps: unknown[]) => ({ kind: 'plan', steps, summary: '요약' });

describe('validatePlannerOutput', () => {
  it('builds a rule from flat sg fields', () => {
    const r = validatePlannerOutput(plan(sg({ description: 'x' })), opts);
    expect(r).toEqual({ ok: true, value: { kind: 'plan', summary: '요약', steps: [{ action: 'sg.ingress.add', ref: 'web-sg', rule: { protocol: 'tcp', fromPort: 80, toPort: 80, source: '10.0.0.0/24', description: 'x' } }] } });
  });

  it('rejectsUnknownActionsFieldsAndBadValues', () => {
    const bad: unknown[] = [
      plan({ action: 'ec2.terminate', ref: 'a' }),
      plan({ action: 'ec2.stop', ref: 'a', extra: 1 }),
      plan(sg({ toPort: 70000 })),
      plan(sg({ fromPort: 90, toPort: 80 })),
      plan(sg({ source: '10.0.0.0/33' })),
      plan({ action: 'tag.set', ref: 'a', key: 'aws:foo', value: 'v' }),
      plan({ action: 'tag.set', ref: 'a', key: 'k'.repeat(129), value: 'v' }),
      plan({ action: 'tag.set', ref: 'a', key: 'k', value: 'v'.repeat(257) }),
      plan(sg({ protocol: '-1' })),
    ];
    for (const b of bad) expect(validatePlannerOutput(b, opts).ok).toBe(false);
  });

  it('accepts boundary values and tag.remove', () => {
    expect(validatePlannerOutput(plan({ action: 'tag.set', ref: 'a', key: 'k'.repeat(128), value: '' }), opts).ok).toBe(true);
    expect(validatePlannerOutput(plan({ action: 'tag.remove', ref: 'a', key: 'k' }), opts).ok).toBe(true);
    expect(validatePlannerOutput(plan(sg({ source: '2001:db8::/32' }), sg({ source: 'sg-0123456789abcdef0' })), opts).ok).toBe(true);
  });

  it('expandsAliasToOneStepPerCidrAndCountsTowardMaxSteps', () => {
    const r = validatePlannerOutput(plan(sg({ source: 'alias:사무실' })), opts);
    expect(r.ok && r.value.kind === 'plan' && r.value.steps.map(s => s.rule?.source)).toEqual(['10.1.1.1/32', '10.2.2.2/32']);
    const over = validatePlannerOutput(plan(sg({ source: 'alias:사무실' }), sg({ source: 'alias:사무실' }), sg({ source: 'alias:사무실' })), opts);
    expect(over.ok).toBe(false);
  });

  it('names unknown aliases in the error', () => {
    const r = validatePlannerOutput(plan(sg({ source: 'alias:집' })), opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('집');
  });

  it('acceptsClarifyAndNotAction', () => {
    expect(validatePlannerOutput({ kind: 'clarify', question: '어느 서버요?' }, opts)).toEqual({ ok: true, value: { kind: 'clarify', question: '어느 서버요?' } });
    expect(validatePlannerOutput({ kind: 'not-action' }, opts)).toEqual({ ok: true, value: { kind: 'not-action' } });
  });

  it('rejects non-objects, empty plans and wrong-field combos', () => {
    expect(validatePlannerOutput(null, opts).ok).toBe(false);
    expect(validatePlannerOutput({ kind: 'plan', steps: [], summary: '' }, opts).ok).toBe(false);
    expect(validatePlannerOutput(plan({ action: 'ec2.stop', ref: 'a', source: '10.0.0.0/8' }), opts).ok).toBe(false);
  });

  it('canonicalizesCidrsAndRejectsHostBits', () => {
    const canon: Array<[string, string]> = [
      ['0.0.0.0/0', '0.0.0.0/0'], ['0.0.0.0/00', '0.0.0.0/0'], ['000.0.0.0/0', '0.0.0.0/0'],
      ['010.001.0.0/16', '10.1.0.0/16'], ['10.0.0.0/08', '10.0.0.0/8'],
      ['::/0', '::/0'], ['::0/0', '::/0'], ['0::/0', '::/0'], ['0:0:0:0:0:0:0:0/0', '::/0'], ['0000::0000/000', '::/0'],
      ['2001:DB8:0:0::/32', '2001:db8::/32'], ['2001:0db8:0000:0000:0000:0000:0000:0001/128', '2001:db8::1/128'],
      ['1:0:0:1:0:0:0:1/128', '1:0:0:1::1/128'], ['1:0:0:1:0:0:1:1/128', '1::1:0:0:1:1/128'], ['1:0:1:0:1:0:1:0/128', '1:0:1:0:1:0:1:0/128'],
    ];
    for (const [input, out] of canon) expect(canonicalCidr(input), input).toBe(out);
    for (const bad of ['1.2.3.4/0', '10.0.0.1/24', '256.0.0.0/8', '10.0.0.0/33', '2001:db8::1/32', '::1/0', '1::2::3/64',
      '::ffff:1.2.3.4/128', '12345::/16', '10.0.0.0', '10.0.0.0/8/8', '0.0.0.0/-0', '0.0.0.0/0000']) {
      expect(canonicalCidr(bad), bad).toBeNull();
    }
    // the validated rule carries the canonical form
    const r = validatePlannerOutput(plan(sg({ source: '2001:DB8:0::/48' })), opts);
    expect(r.ok && r.value.kind === 'plan' && r.value.steps[0].rule?.source).toBe('2001:db8::/48');
    expect(validatePlannerOutput(plan(sg({ source: '1.2.3.4/0' })), opts).ok).toBe(false);
    // alias CIDRs are canonicalized and checked too
    const a = validatePlannerOutput(plan(sg({ source: 'alias:x' })), { ...opts, aliases: { x: ['010.0.0.0/8'] } });
    expect(a.ok && a.value.kind === 'plan' && a.value.steps[0].rule?.source).toBe('10.0.0.0/8');
    expect(validatePlannerOutput(plan(sg({ source: 'alias:x' })), { ...opts, aliases: { x: ['10.0.0.1/8'] } }).ok).toBe(false);
  });

  it('rejectsBackticksAndControlCharactersInExecutedText', () => {
    for (const b of [
      plan({ action: 'tag.set', ref: 'a', key: 'k`x', value: 'v' }),
      plan({ action: 'tag.set', ref: 'a', key: 'k', value: 'line1\nline2' }),
      plan({ action: 'tag.set', ref: 'a', key: 'k', value: 'a\rb' }),
      plan({ action: 'tag.set', ref: 'a', key: 'k', value: 'a\tb' }),
      plan({ action: 'tag.remove', ref: 'a', key: 'k\n' }),
      plan(sg({ description: 'x`y' })),
      plan(sg({ description: 'x\ny' })),
    ]) expect(validatePlannerOutput(b, opts).ok).toBe(false);
    // ordinary special characters stay allowed and untouched
    const ok = validatePlannerOutput(plan({ action: 'tag.set', ref: 'a', key: 'cost_center', value: 'a*b_c~d <&> |x|' }), opts);
    expect(ok.ok && ok.value.kind === 'plan' && ok.value.steps[0]).toEqual({ action: 'tag.set', ref: 'a', key: 'cost_center', value: 'a*b_c~d <&> |x|' });
  });
});
