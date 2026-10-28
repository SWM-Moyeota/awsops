// Hand-written validation of the planner's submit_plan output (spec 3.2-3.3). Any single problem rejects the whole plan.
// 플래너 출력 형식 검사. 하나라도 틀리면 계획 전체를 거부한다.
import type { ActionKind, IngressRule, PlannedStep, PlannerOutput } from './types';

export interface ValidateOptions {
  aliases: Record<string, string[]>;
  maxSteps: number;
}
export type ValidateResult = { ok: true; value: PlannerOutput } | { ok: false; error: string };

const ACTIONS: readonly ActionKind[] = ['ec2.start', 'ec2.stop', 'tag.set', 'tag.remove', 'sg.ingress.add', 'sg.ingress.remove'];
const STEP_FIELDS = ['action', 'ref', 'key', 'value', 'protocol', 'fromPort', 'toPort', 'source', 'description'];
const SG_FIELDS = ['protocol', 'fromPort', 'toPort', 'source', 'description'];
const MAX_REF = 256;
const MAX_TEXT = 1000;

class Bad extends Error {}
const fail = (msg: string): never => {
  throw new Bad(msg);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Prefix length: decimal digits only (leading zeros allowed, normalised), within max. */
function prefixOf(p: string, max: number): number | null {
  if (!/^\d{1,3}$/.test(p)) return null;
  const n = Number(p);
  return n <= max ? n : null;
}

/** IPv4 CIDR → canonical "a.b.c.d/n" (decimal octets, no leading zeros), or null. Host bits must be zero. */
function canonicalIpv4(addr: string, pfx: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  const n = prefixOf(pfx, 32);
  if (!m || n === null) return null;
  const octets = m.slice(1, 5).map(Number);
  if (!octets.every(o => o <= 255)) return null;
  for (let i = 0; i < 4; i++) {
    const keep = Math.max(0, Math.min(8, n - i * 8));
    const mask = keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff;
    if ((octets[i] & ~mask & 0xff) !== 0) return null; // host bits set
  }
  return `${octets.join('.')}/${n}`;
}

/** IPv6 address → 8 groups, or null. IPv4-embedded forms are not accepted. */
function ipv6Groups(addr: string): number[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(addr) || !addr.includes(':')) return null;
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const part = (h: string): string[] | null => {
    if (h === '') return [];
    const gs = h.split(':');
    return gs.every(g => /^[0-9a-fA-F]{1,4}$/.test(g)) ? gs : null;
  };
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  if (!head || !tail) return null;
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  return groups.map(g => parseInt(g, 16));
}

/** RFC 5952 text form: lower case, no leading zeros, the longest run (≥2) of zero groups as "::". */
function formatIpv6(g: number[]): string {
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map(x => x.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

function canonicalIpv6(addr: string, pfx: string): string | null {
  const g = ipv6Groups(addr);
  const n = prefixOf(pfx, 128);
  if (!g || n === null) return null;
  for (let i = 0; i < 8; i++) {
    const keep = Math.max(0, Math.min(16, n - i * 16));
    const mask = keep === 0 ? 0 : (0xffff << (16 - keep)) & 0xffff;
    if ((g[i] & ~mask & 0xffff) !== 0) return null; // host bits set
  }
  return `${formatIpv6(g)}/${n}`;
}

/**
 * Any CIDR spelling → one canonical string, or null when it is not a valid network address
 * (bad syntax, out-of-range prefix, or host bits set such as 1.2.3.4/0). Policy and the card see only this form.
 * CIDR을 하나의 표준 표기로 바꾼다. 호스트 비트가 0이 아니면(예: 1.2.3.4/0) 거부한다.
 */
export function canonicalCidr(s: string): string | null {
  const slash = s.indexOf('/');
  if (slash < 0 || slash !== s.lastIndexOf('/')) return null;
  const addr = s.slice(0, slash);
  const pfx = s.slice(slash + 1);
  return addr.includes(':') ? canonicalIpv6(addr, pfx) : canonicalIpv4(addr, pfx);
}

const isSgId = (s: string) => /^sg-[0-9a-f]{8,17}$/.test(s);

// Backticks and control characters (newline, CR, tab, …) cannot be shown faithfully inside a Slack code span,
// so values that will be sent to AWS must not contain them (the card must show exactly what executes).
// 실행되는 값에는 백틱·줄바꿈 같은 제어 문자를 허용하지 않는다 — 카드에 그대로 보여 줄 수 없기 때문이다.
const UNSHOWABLE = /[`\u0000-\u001f\u007f]/;
function showable(v: string, field: string): string {
  if (UNSHOWABLE.test(v)) fail(`${field}에는 백틱(\`)이나 줄바꿈 같은 제어 문자를 쓸 수 없어요`);
  return v;
}

function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') return fail(`${field}는 문자열이어야 해요`);
  if (v.length < min || v.length > max) return fail(`${field}의 길이가 ${min}-${max}자 범위를 벗어났어요`);
  return v;
}

function port(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 65535) return fail(`${field}는 0-65535 사이 정수여야 해요`);
  return v;
}

function buildRule(s: Record<string, unknown>): Omit<IngressRule, 'source'> & { source: string } {
  if (s.protocol !== 'tcp' && s.protocol !== 'udp') fail('protocol은 tcp 또는 udp만 쓸 수 있어요');
  const fromPort = port(s.fromPort, 'fromPort');
  const toPort = port(s.toPort, 'toPort');
  if (fromPort > toPort) fail('fromPort가 toPort보다 클 수 없어요');
  const source = str(s.source, 'source', 1, 200);
  const rule: IngressRule = { protocol: s.protocol as 'tcp' | 'udp', fromPort, toPort, source };
  if (s.description !== undefined) rule.description = showable(str(s.description, 'description', 0, 255), 'description');
  return rule;
}

function expandSteps(raw: unknown[], opts: ValidateOptions): PlannedStep[] {
  const out: PlannedStep[] = [];
  for (const item of raw) {
    if (!isObj(item)) return fail('step은 객체여야 해요');
    for (const k of Object.keys(item)) if (!STEP_FIELDS.includes(k)) fail(`알 수 없는 필드예요: ${k}`);
    const action = item.action;
    if (typeof action !== 'string' || !ACTIONS.includes(action as ActionKind)) return fail(`알 수 없는 action이에요: ${String(action).slice(0, 40)}`);
    const a = action as ActionKind;
    const ref = str(item.ref, 'ref', 1, MAX_REF);
    const isSg = a.startsWith('sg.');
    const isTag = a.startsWith('tag.');

    if (!isSg) for (const k of SG_FIELDS) if (item[k] !== undefined) fail(`${a}에는 ${k}를 쓸 수 없어요`);
    if (!isTag) for (const k of ['key', 'value']) if (item[k] !== undefined) fail(`${a}에는 ${k}를 쓸 수 없어요`);
    if (a === 'tag.remove' && item.value !== undefined) fail('tag.remove에는 value를 쓸 수 없어요');

    if (isTag) {
      const key = showable(str(item.key, 'key', 1, 128), 'key');
      if (key.startsWith('aws:')) fail('aws:로 시작하는 태그 키는 쓸 수 없어요');
      const step: PlannedStep = { action: a, ref, key };
      if (a === 'tag.set') step.value = showable(str(item.value, 'value', 0, 256), 'value');
      out.push(step);
    } else if (isSg) {
      const rule = buildRule(item);
      const src = rule.source;
      if (src.startsWith('alias:')) {
        const name = src.slice('alias:'.length);
        const cidrs = Object.prototype.hasOwnProperty.call(opts.aliases, name) ? opts.aliases[name] : undefined;
        if (!cidrs || cidrs.length === 0) return fail(`알 수 없는 출처 별칭이에요: ${name.slice(0, 40)}`);
        for (const cidr of cidrs) {
          const canonical = canonicalCidr(cidr);
          if (!canonical) return fail(`별칭 ${name.slice(0, 40)}의 CIDR 형식이 올바르지 않아요 (호스트 비트는 0이어야 해요)`);
          out.push({ action: a, ref, rule: { ...rule, source: canonical } });
        }
      } else if (isSgId(src)) {
        out.push({ action: a, ref, rule });
      } else {
        const canonical = canonicalCidr(src);
        if (!canonical) return fail('source는 CIDR(호스트 비트 0), sg-ID, alias:<이름> 중 하나여야 해요');
        out.push({ action: a, ref, rule: { ...rule, source: canonical } });
      }
    } else {
      out.push({ action: a, ref });
    }
    if (out.length > opts.maxSteps) fail(`단계가 너무 많아요 (최대 ${opts.maxSteps}개)`);
  }
  return out;
}

export function validatePlannerOutput(raw: unknown, opts: ValidateOptions): ValidateResult {
  try {
    if (!isObj(raw)) return { ok: false, error: '플래너 출력이 객체가 아니에요' };
    const kind = raw.kind;
    if (kind === 'not-action') return { ok: true, value: { kind: 'not-action' } };
    if (kind === 'clarify') return { ok: true, value: { kind: 'clarify', question: str(raw.question, 'question', 1, MAX_TEXT) } };
    if (kind !== 'plan') return { ok: false, error: '알 수 없는 kind예요' };
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) return { ok: false, error: 'steps가 비어 있어요' };
    if (raw.steps.length > opts.maxSteps) return { ok: false, error: `단계가 너무 많아요 (최대 ${opts.maxSteps}개)` };
    const summary = raw.summary === undefined ? '' : str(raw.summary, 'summary', 0, MAX_TEXT);
    return { ok: true, value: { kind: 'plan', steps: expandSteps(raw.steps, opts), summary } };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.message };
    throw e;
  }
}
