// Ordered executor: stop at the first failure, no auto-rollback (spec 3.9). Errors carry the name only.
// 계획 순서대로 실행하고, 실패하면 그 자리에서 멈춘다.
import type { AfterCheck, Ec2Writer, ResolvedStep, StepChange, StepResult } from './types';

function errName(e: unknown): string {
  return (e as { name?: string } | null)?.name || 'Error';
}

/** What must be true right after the step ran (undo's overwrite guard). */
export function afterCheckFor(step: ResolvedStep, ruleIdFromResult?: string): AfterCheck {
  const id = step.target.id;
  switch (step.action) {
    case 'ec2.stop':
      return { kind: 'instance-state', id, states: ['stopping', 'stopped'] };
    case 'ec2.start':
      return { kind: 'instance-state', id, states: ['pending', 'running'] };
    case 'tag.set':
      return { kind: 'tag', id, key: step.key ?? '', value: step.value ?? '' };
    case 'tag.remove':
      return { kind: 'tag', id, key: step.key ?? '', value: null };
    case 'sg.ingress.add':
      return { kind: 'rule-present', sgId: id, ruleId: ruleIdFromResult ?? '' };
    case 'sg.ingress.remove':
      return { kind: 'rule-absent', sgId: id, rule: step.rule! };
  }
}

export async function executeChanges(changes: StepChange[], writer: Ec2Writer): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let failed = false;
  for (const c of changes) {
    if (c.noop) continue;
    if (failed) {
      results.push({ index: c.index, status: 'not-run' });
      continue;
    }
    try {
      const r = await writer.run(c.step, false);
      let inverse = c.inverse;
      if (!inverse && c.step.action === 'sg.ingress.add') {
        inverse = { action: 'sg.ingress.remove', target: c.step.target, rule: c.step.rule, ruleId: r.ruleId };
      }
      results.push({
        index: c.index,
        status: 'done',
        requestId: r.requestId,
        inverse,
        after: afterCheckFor(c.step, r.ruleId),
      });
    } catch (e) {
      failed = true;
      results.push({ index: c.index, status: 'failed', error: errName(e) });
    }
  }
  return results;
}

/** DryRun every non-noop step; `error` is the error name of the first rejection. */
export async function dryRunAll(changes: StepChange[], writer: Ec2Writer): Promise<{ ok: boolean; error?: string }> {
  for (const c of changes) {
    if (c.noop) continue;
    try {
      await writer.run(c.step, true);
    } catch (e) {
      return { ok: false, error: errName(e) };
    }
  }
  return { ok: true };
}
