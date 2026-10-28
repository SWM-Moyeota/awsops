// Per-step before/after, no-ops and inverses, computed from the snapshot. Pure.
// 단계별 전/후, 이미 되어 있음, 역연산을 스냅샷으로 계산한다.
import type { IngressRule, ResolvedStep, Snapshot, SnapshotRule, StepChange } from './types';

interface Work {
  state?: string;
  tags: Record<string, string>;
  ingress: SnapshotRule[];
}

const ruleKey = (r: IngressRule) => `${r.protocol}|${r.fromPort}|${r.toPort}|${r.source}`;
const ports = (r: IngressRule) => (r.fromPort === r.toPort ? `${r.fromPort}` : `${r.fromPort}-${r.toPort}`);
const ruleText = (r: IngressRule) => `인바운드 ${r.protocol} ${ports(r)} ← ${r.source}`;

export function computeChanges(steps: ResolvedStep[], s: Snapshot): { changes: StepChange[]; errors: string[] } {
  const work: Record<string, Work> = {};
  const get = (id: string): Work | null => {
    if (!work[id]) {
      const snap = s[id];
      if (!snap) return null;
      work[id] = { state: snap.state, tags: { ...snap.tags }, ingress: [...(snap.ingress ?? [])] };
    }
    return work[id];
  };

  const changes: StepChange[] = [];
  const errors: string[] = [];

  steps.forEach((step, index) => {
    const w = get(step.target.id);
    if (!w) {
      errors.push(`스냅샷에 없는 대상이에요: ${step.target.id}`);
      return;
    }
    const mk = (before: string, after: string, noop: boolean, inverse?: ResolvedStep, patch?: Partial<ResolvedStep>, previous?: string | null) =>
      changes.push({
        index, step: { ...step, ...patch }, before, after, noop,
        ...(inverse && !noop ? { inverse } : {}),
        ...(previous !== undefined ? { previous } : {}),
      });
    const t = step.target;

    switch (step.action) {
      case 'ec2.stop':
      case 'ec2.start': {
        const stop = step.action === 'ec2.stop';
        const goal = stop ? 'stopped' : 'running';
        const noop = w.state === goal;
        mk(`서버 상태 ${w.state ?? '알 수 없음'}`, `서버 상태 ${goal}`, noop, {
          action: stop ? 'ec2.start' : 'ec2.stop',
          target: t,
        });
        if (!noop) w.state = goal;
        break;
      }
      case 'tag.set': {
        const key = step.key ?? '';
        const value = step.value ?? '';
        const old = w.tags[key];
        const noop = old === value;
        const inverse: ResolvedStep =
          old === undefined ? { action: 'tag.remove', target: t, key } : { action: 'tag.set', target: t, key, value: old };
        mk(`태그 ${key}: ${old ?? '(없음)'}`, `태그 ${key}: ${old ?? '(없음)'} → ${value}`, noop, inverse, undefined, old ?? null);
        w.tags[key] = value;
        break;
      }
      case 'tag.remove': {
        const key = step.key ?? '';
        const old = w.tags[key];
        const noop = old === undefined;
        mk(`태그 ${key}: ${old ?? '(없음)'}`, `태그 ${key}: ${old ?? '(없음)'} → (없음)`, noop,
          noop ? undefined : { action: 'tag.set', target: t, key, value: old }, undefined, old ?? null);
        delete w.tags[key];
        break;
      }
      case 'sg.ingress.add': {
        const rule = step.rule;
        if (!rule) {
          errors.push('규칙 정보가 없어요');
          return;
        }
        const noop = w.ingress.some(r => ruleKey(r) === ruleKey(rule));
        mk('(없음)', `${ruleText(rule)} 추가`, noop);
        if (!noop) w.ingress.push({ ...rule, ruleId: '' });
        break;
      }
      case 'sg.ingress.remove': {
        const rule = step.rule;
        const found = rule ? w.ingress.find(r => ruleKey(r) === ruleKey(rule)) : undefined;
        if (!rule || !found) {
          errors.push('그런 규칙이 없어요');
          return;
        }
        if (!found.ruleId) {
          errors.push('같은 계획에서 방금 추가한 규칙은 지울 수 없어요');
          return;
        }
        const inverseRule: IngressRule = {
          protocol: found.protocol, fromPort: found.fromPort, toPort: found.toPort, source: found.source,
          ...(found.description !== undefined ? { description: found.description } : {}),
        };
        mk(ruleText(found), `${ruleText(found)} 삭제`, false, { action: 'sg.ingress.add', target: t, rule: inverseRule },
          { ruleId: found.ruleId });
        w.ingress = w.ingress.filter(r => r !== found);
        break;
      }
    }
  });

  return { changes, errors };
}
