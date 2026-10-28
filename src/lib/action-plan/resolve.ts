// Target resolution — turns the planner's free-text `ref` into concrete tagged resources. Pure: no AWS calls.
// 계획의 ref(사용자가 쓴 말)를 코드가 실제 리소스로 해석한다. 후보는 태그된 리소스뿐이다.
import type { PlannedStep, Resource, ResolvedStep, TargetRef } from './types';
import { mentionsName } from '@/lib/slack-control/parse';

export type ResolveResult =
  | { kind: 'ok'; steps: ResolvedStep[] }
  | { kind: 'not-found' | 'ambiguous'; ref: string; candidates: TargetRef[] }
  | { kind: 'too-many-resources'; count: number };

const toRef = (r: Resource): TargetRef => ({ type: r.type, id: r.id, name: r.name });
const ID_REF = /^(i|sg)-[0-9a-z]+$/i;

function matchIn(ref: string, pool: Resource[]): Resource[] {
  const trimmed = ref.trim();
  if (ID_REF.test(trimmed)) return pool.filter(r => r.id.toLowerCase() === trimmed.toLowerCase());
  return pool.filter(r => mentionsName(ref, r.name) || (r.groupName ? mentionsName(ref, r.groupName) : false));
}

export function resolveSteps(
  steps: PlannedStep[],
  c: { instances: Resource[]; groups: Resource[] },
  maxResources: number,
): ResolveResult {
  const resolved: ResolvedStep[] = [];

  for (const step of steps) {
    const family = step.action.split('.')[0];
    let target: Resource;

    if (family === 'sg') {
      const groupHits = matchIn(step.ref, c.groups);
      if (groupHits.length > 1) return { kind: 'ambiguous', ref: step.ref, candidates: groupHits.map(toRef) };
      if (groupHits.length === 1) {
        target = groupHits[0];
      } else {
        // Not a group — maybe the user named an instance ("api-dev의 SG"): use its single tagged group.
        const instHits = matchIn(step.ref, c.instances);
        if (instHits.length > 1) return { kind: 'ambiguous', ref: step.ref, candidates: instHits.map(toRef) };
        if (instHits.length === 0) return { kind: 'not-found', ref: step.ref, candidates: c.groups.map(toRef) };
        const own = c.groups.filter(g => (instHits[0].securityGroupIds ?? []).includes(g.id));
        if (own.length !== 1) return { kind: 'ambiguous', ref: step.ref, candidates: own.map(toRef) };
        target = own[0];
      }
    } else {
      const pool = family === 'ec2' ? c.instances : [...c.instances, ...c.groups];
      const hits = matchIn(step.ref, pool);
      if (hits.length === 0) return { kind: 'not-found', ref: step.ref, candidates: pool.map(toRef) };
      if (hits.length > 1) return { kind: 'ambiguous', ref: step.ref, candidates: hits.map(toRef) };
      target = hits[0];
    }

    const out: ResolvedStep = { action: step.action, target: toRef(target) };
    if (step.key !== undefined) out.key = step.key;
    if (step.value !== undefined) out.value = step.value;
    if (step.rule) out.rule = step.rule;
    resolved.push(out);
  }

  const count = new Set(resolved.map(s => s.target.id)).size;
  if (count > maxResources) return { kind: 'too-many-resources', count };
  return { kind: 'ok', steps: resolved };
}
