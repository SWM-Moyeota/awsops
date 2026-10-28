// Undo planning — pure functions. Inverses were computed at execution time; here we only order them,
// guard against overwriting later changes, and check the undo window. No LLM, no AWS calls.
// 되돌리기 계획: 실행 때 저장한 역연산을 뒤집어 순서대로 돌려주고, 그 사이 바뀐 단계는 뺀다.
import type { AfterCheck, ExecutionRecord, ResolvedStep, Snapshot, StepResult } from './types';
import { safeName } from '@/lib/slack-control/ec2';

const SKIP_PREFIX = '그 사이 다른 변경이 있어서 되돌리지 않아요';

type DoneStep = StepResult & { inverse: ResolvedStep };

function doneWithInverse(rec: ExecutionRecord): DoneStep[] {
  return rec.results.filter((r): r is DoneStep => r.status === 'done' && !!r.inverse);
}

/** Inverses of the done steps, last step first. */
export function undoSteps(rec: ExecutionRecord): ResolvedStep[] {
  return doneWithInverse(rec).reverse().map(r => r.inverse);
}

function holds(check: AfterCheck, fresh: Snapshot): boolean {
  switch (check.kind) {
    case 'instance-state': {
      const state = fresh[check.id]?.state;
      return !!state && check.states.includes(state);
    }
    case 'tag': {
      const res = fresh[check.id];
      if (!res) return false;
      return (res.tags[check.key] ?? null) === check.value;
    }
    case 'rule-present': {
      const ingress = fresh[check.sgId]?.ingress;
      return !!ingress && ingress.some(r => r.ruleId === check.ruleId);
    }
    case 'rule-absent': {
      const ingress = fresh[check.sgId]?.ingress;
      if (!ingress) return false;
      const { protocol, fromPort, toPort, source } = check.rule;
      return !ingress.some(r => r.protocol === protocol && r.fromPort === fromPort && r.toPort === toPort && r.source === source);
    }
  }
}

/** Keeps the inverses whose step is still in its "right after execution" state; the rest are skipped with a reason. */
export function checkUndo(rec: ExecutionRecord, fresh: Snapshot): { steps: ResolvedStep[]; skipped: string[] } {
  const steps: ResolvedStep[] = [];
  const skipped: string[] = [];
  for (const r of doneWithInverse(rec).reverse()) {
    if (r.after && holds(r.after, fresh)) {
      steps.push(r.inverse);
    } else {
      const t = r.inverse.target;
      skipped.push(`${SKIP_PREFIX}: ${safeName(t.name || t.id)} (${t.id})`);
    }
  }
  return { steps, skipped };
}

/** True while within `undoHours` of execution and there is at least one inverse to run. */
export function isUndoAvailable(rec: ExecutionRecord, undoHours: number, now: Date = new Date()): boolean {
  const at = Date.parse(rec.executedAt);
  if (!Number.isFinite(at)) return false;
  if (now.getTime() - at > undoHours * 3600_000) return false;
  return doneWithInverse(rec).length > 0;
}
