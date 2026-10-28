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

function validIpv4Cidr(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s);
  if (!m) return false;
  return m.slice(1, 5).every(o => Number(o) <= 255) && Number(m[5]) <= 32;
}

function validIpv6Cidr(s: string): boolean {
  const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(s);
  if (!m || Number(m[2]) > 128) return false;
  const addr = m[1];
  if (!addr.includes(':') || addr.includes(':::') || addr.split('::').length > 2) return false;
  const groups = addr.split(':');
  if (addr.includes('.')) return false; // IPv4-mapped forms are not needed
  const compressed = addr.includes('::');
  const nonEmpty = groups.filter(g => g !== '');
  if (!nonEmpty.every(g => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  return compressed ? nonEmpty.length <= 7 : groups.length === 8;
}

const isCidr = (s: string) => validIpv4Cidr(s) || validIpv6Cidr(s);
const isSgId = (s: string) => /^sg-[0-9a-f]{8,17}$/.test(s);

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
  if (s.description !== undefined) rule.description = str(s.description, 'description', 0, 255);
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
      const key = str(item.key, 'key', 1, 128);
      if (key.startsWith('aws:')) fail('aws:로 시작하는 태그 키는 쓸 수 없어요');
      const step: PlannedStep = { action: a, ref, key };
      if (a === 'tag.set') step.value = str(item.value, 'value', 0, 256);
      out.push(step);
    } else if (isSg) {
      const rule = buildRule(item);
      const src = rule.source;
      if (src.startsWith('alias:')) {
        const name = src.slice('alias:'.length);
        const cidrs = Object.prototype.hasOwnProperty.call(opts.aliases, name) ? opts.aliases[name] : undefined;
        if (!cidrs || cidrs.length === 0) return fail(`알 수 없는 출처 별칭이에요: ${name.slice(0, 40)}`);
        for (const cidr of cidrs) {
          if (!isCidr(cidr)) fail(`별칭 ${name.slice(0, 40)}의 CIDR 형식이 올바르지 않아요`);
          out.push({ action: a, ref, rule: { ...rule, source: cidr } });
        }
      } else {
        if (!isCidr(src) && !isSgId(src)) fail('source는 CIDR, sg-ID, alias:<이름> 중 하나여야 해요');
        out.push({ action: a, ref, rule });
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
