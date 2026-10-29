// Judge `terraform show -json` output for the diff-0 gate / diff-0 관문을 위한 plan JSON 판정
export type Outcome = 'pass' | 'changed' | 'missing';
export interface Verdict { outcome: Outcome; actions: string[]; changedPaths: string[] }

const MAX_PATHS = 20; // per resource / 리소스당 최대 경로 수

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// Collect differing leaf paths, skipping unknown-after paths / after_unknown이 true인 경로는 건너뛰고 다른 경로 수집
function diff(before: unknown, after: unknown, unknown_: unknown, path: string, out: string[]): void {
  if (out.length >= MAX_PATHS || unknown_ === true) return;
  if (isObj(before) && isObj(after)) {
    const u = isObj(unknown_) ? unknown_ : {};
    for (const k of Array.from(new Set(Object.keys(before).concat(Object.keys(after))))) {
      diff(before[k], after[k], u[k], path ? `${path}.${k}` : k, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const u = Array.isArray(unknown_) ? unknown_ : [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) diff(before[i], after[i], u[i], `${path}[${i}]`, out);
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push(path || '(resource)');
}

export function judgePlan(json: unknown): Map<string, Verdict> {
  const res = new Map<string, Verdict>();
  const root = isObj(json) ? json : {};
  const changes = Array.isArray(root.resource_changes) ? (root.resource_changes as Obj[]) : [];
  for (const rc of changes) {
    if (rc.mode !== undefined && rc.mode !== 'managed') continue; // managed only / managed만
    const address = String(rc.address ?? '');
    const ch = isObj(rc.change) ? rc.change : {};
    const actions = Array.isArray(ch.actions) ? (ch.actions as string[]) : [];
    const noop = actions.length === 1 && actions[0] === 'no-op';
    const changedPaths: string[] = [];
    if (!noop) diff(ch.before, ch.after, ch.after_unknown, '', changedPaths);
    if (!noop && changedPaths.length === 0 && actions.length > 0) changedPaths.push('(resource)'); // whole-resource change / 리소스 전체 변경
    const pass = noop && ch.importing !== undefined && ch.importing !== null;
    res.set(address, { outcome: pass ? 'pass' : 'changed', actions, changedPaths });
  }
  const cfg = isObj(root.configuration) && isObj(root.configuration.root_module) ? root.configuration.root_module : {};
  const resources = Array.isArray(cfg.resources) ? (cfg.resources as Obj[]) : [];
  for (const r of resources) {
    if (r.mode !== undefined && r.mode !== 'managed') continue;
    const address = String(r.address ?? '');
    if (address && !res.has(address)) res.set(address, { outcome: 'missing', actions: [], changedPaths: [] });
  }
  return res;
}
