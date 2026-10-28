import { describe, it, expect } from 'vitest';
import { buildPlannerRequest, callPlanner, PlannerError } from '../planner';

const ACTIONS = ['ec2.start', 'ec2.stop', 'tag.set', 'tag.remove', 'sg.ingress.add', 'sg.ingress.remove'];

describe('planner request', () => {
  it('plannerInputHasOnlyMessageCatalogAndAliasNames', () => {
    const aliases = { 사무실: ['203.0.113.0/24'] };
    const req = buildPlannerRequest('<@U123> web-1 켜줘', Object.keys(aliases));
    const s = JSON.stringify(req);
    expect(s).toContain('web-1 켜줘');
    expect(s).toContain('사무실');
    for (const a of ACTIONS) expect(s).toContain(a);
    expect(s).not.toContain('203.0.113');
    expect(s).not.toContain('<@U123>');
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'submit_plan' });
    const long = buildPlannerRequest('가'.repeat(1500), []);
    expect(long.messages[0].content.length).toBe(1000);
  });

  it('returnsToolInputAndThrowsOnTextOnlyReply', async () => {
    const input = { kind: 'not-action' };
    const ok = await callPlanner('hi', [], async () => ({ content: [{ type: 'text', text: 'x' }, { type: 'tool_use', input }] }));
    expect(ok).toEqual(input);
    await expect(callPlanner('hi', [], async () => ({ content: [{ type: 'text', text: 'x' }] }))).rejects.toBeInstanceOf(PlannerError);
    await expect(callPlanner('hi', [], async () => { throw new TypeError('boom'); })).rejects.toBeInstanceOf(PlannerError);
  });
});
