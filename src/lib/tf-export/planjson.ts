// Judge `terraform show -json` output for the diff-0 gate / diff-0 관문을 위한 plan JSON 판정
export type Outcome = 'pass' | 'changed' | 'missing';
// sensitiveOnly: an import whose values are unchanged and only sensitivity marks differ (secret variables) / sensitiveOnly: 값은 같고 숨김 표시만 바뀐 가져오기 (비밀 변수)
export interface Verdict { outcome: Outcome; actions: string[]; changedPaths: string[]; sensitiveOnly?: string[] }

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

// True when any leaf of after_unknown is true / after_unknown에 true인 잎이 하나라도 있으면 true
function hasUnknown(u: unknown): boolean {
  if (u === true) return true;
  if (Array.isArray(u)) return u.some(hasUnknown);
  return isObj(u) && Object.values(u).some(hasUnknown);
}

// Paths whose sensitivity mark differs; missing and false both mean not sensitive / 숨김 표시가 다른 경로 (없음·false는 숨김 아님)
function sensDiff(b: unknown, a: unknown, path: string, out: string[]): void {
  if (out.length >= MAX_PATHS) return;
  if (b === true || a === true) { if (b !== a) out.push(path || '(resource)'); return; }
  if (Array.isArray(b) || Array.isArray(a)) {
    const bl = Array.isArray(b) ? b : [], al = Array.isArray(a) ? a : [];
    for (let i = 0; i < Math.max(bl.length, al.length); i++) sensDiff(bl[i], al[i], `${path}[${i}]`, out);
    return;
  }
  if (isObj(b) || isObj(a)) {
    const bo = isObj(b) ? b : {}, ao = isObj(a) ? a : {};
    for (const k of Array.from(new Set(Object.keys(bo).concat(Object.keys(ao))))) sensDiff(bo[k], ao[k], path ? `${path}.${k}` : k, out);
  }
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
    const importing = ch.importing !== undefined && ch.importing !== null;
    // Same values, nothing unknown, only sensitivity marks changed / 값이 같고 모르는 값도 없이 숨김 표시만 바뀜
    let sensitiveOnly: string[] | undefined;
    if (importing && actions.length === 1 && actions[0] === 'update' && changedPaths.length === 0 && !hasUnknown(ch.after_unknown)) {
      const sp: string[] = [];
      sensDiff(ch.before_sensitive, ch.after_sensitive, '', sp);
      if (sp.length) sensitiveOnly = sp;
    }
    if (!noop && !sensitiveOnly && changedPaths.length === 0 && actions.length > 0) changedPaths.push('(resource)'); // whole-resource change / 리소스 전체 변경
    const pass = (noop && importing) || !!sensitiveOnly;
    res.set(address, { outcome: pass ? 'pass' : 'changed', actions, changedPaths, ...(sensitiveOnly ? { sensitiveOnly } : {}) });
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
