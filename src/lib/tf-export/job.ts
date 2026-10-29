// Single-job export pipeline with the diff-0 gate (spec §2 steps 1-8, §6) / diff-0 관문을 둔 단일 작업 내보내기 파이프라인 (설계 §2 1~8단계, §6)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { GraphData } from '@/lib/dep-graph/types';
import { withCap } from '@/lib/with-cap';
import type { ExportItem, ExportSeed, Excluded, ItemResult, JobRecord, JobStats, Stage, TfType } from './types';
import { splitResources, replaceResource, removeResource, removeImport, nestedBlocks } from './hcl';
import { parsePlanErrors, applyRules, LAMBDA_PLACEHOLDER, type PlanError } from './rules';
import { assertAllowed, type ExecResult } from './runner';
import { judgePlan, type Verdict } from './planjson';
import { refactorBundle } from './refactor';
import { extractSecrets, variablesTf, tfvarsExample, secretsTfvars, scrubErrorText, scrubValue, type SecretVar } from './secrets';
import { validateFix, type AiFixInput, type AiFixResult } from './ai';
import { hclString, tokenize, decodeStr } from './_scan';
import { makeZip } from './zip';
import { buildReadme } from './readme';
import { tfExportState, saveJob, readJobs, addStats, jobDir, jobsRoot, JOB_ID } from './store';

export const JOB_CAP_MS = 30 * 60_000;
const RULE_ROUNDS = 4;
const AI_ROUNDS = 3;
const BUNDLE_ZIP = 'bundle.zip';

// Same contract as runTerraform; must stop the command when `signal` aborts / runTerraform과 같은 계약, signal이 중단되면 명령을 멈춰야 함
export type TerraformFn = (args: string[], opts: { cwd: string; accountId: string; hostAccountId: string; region: string; signal?: AbortSignal }) => Promise<ExecResult>;
// Injectable dependencies (tests use fakes) / 주입 가능한 의존성 (테스트는 가짜를 씀)
export interface JobDeps {
  terraform?: TerraformFn;
  aiFix?: (input: AiFixInput) => Promise<AiFixResult>;
  installed?: () => Promise<boolean>;
  account?: (accountId: string) => { region: string; hostAccountId: string } | null;
  graph?: () => Promise<GraphData | null>;
  select?: (input: { accountId: string; seed: ExportSeed; data: GraphData; region: string }) => Promise<{ items: ExportItem[]; excluded: Excluded[] }>;
  capMs?: number;
  onStage?: (stage: Stage) => void;
}

// Error carrying only a name / 이름만 가진 오류
function named(name: string): Error { const e = new Error(name); e.name = name; return e; }
const bare = (a: string) => a.replace(/\[[^\]]*\]$/, '');

// ---------- safety scan / 안전 검사 ----------

const REG_AWS = /^(registry\.terraform\.io\/)?hashicorp\/aws$/;
// Reason a .tf file is unsafe to plan, or null / plan하기에 위험한 .tf 파일이면 이유, 아니면 null
export function unsafeConfigReason(file: string, text: string): string | null {
  const toks = tokenize(text);
  const stack: Array<{ name: string }> = [];
  const isP = (i: number, v: string) => toks[i]?.k === 'punct' && toks[i].v === v;
  let rp = -1; // stack depth of required_providers body / required_providers 본문 깊이
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'punct' && '{[('.includes(t.v)) {
      let name = '';
      let j = i - 1;
      while (j >= 0 && toks[j].k === 'str' && toks[j].line === t.line) j--;
      if (j >= 0 && toks[j].k === 'ident' && toks[j].line === t.line && t.v === '{') name = toks[j].v;
      stack.push({ name });
      if (name === 'required_providers' && stack.length >= 2 && stack[stack.length - 2].name === 'terraform') rp = stack.length;
      continue;
    }
    if (t.k === 'punct' && '}])'.includes(t.v)) { if (stack.length === rp) rp = -1; stack.pop(); continue; }
    if (t.k === 'ident') {
      if (t.v === 'provisioner') return 'provisioner';
      const labels: string[] = [];
      let j = i + 1;
      while (toks[j]?.k === 'str' && toks[j].line === t.line) labels.push(decodeStr(toks[j++].v));
      const block = isP(j, '{') && toks[j].line === t.line;
      if (block && t.v === 'data' && labels[0] && /^(external|http)$/.test(labels[0])) return `data.${labels[0]}`;
      // aws_lambda_invocation runs a function during plan / aws_lambda_invocation은 plan 중에 함수를 실행한다
      if (block && (t.v === 'data' || t.v === 'resource') && labels[0] === 'aws_lambda_invocation') return `${t.v}.aws_lambda_invocation`;
      if (block && stack.length === 0) {
        if (t.v === 'module') return 'module';
        if (t.v === 'provider' && (file !== 'providers.tf' || labels[0] !== 'aws')) return 'provider';
        if (t.v === 'terraform' && file !== 'providers.tf') return 'terraform';
      }
      // required_providers: only `aws`, sourced from hashicorp/aws / required_providers는 hashicorp/aws의 aws만
      if (rp > 0 && stack.length === rp && isP(i + 1, '=') && t.v !== 'aws') return 'required_providers';
      if (rp > 0 && stack.length > rp && t.v === 'source' && isP(i + 1, '=')) {
        const v = toks[i + 2];
        if (!v || v.k !== 'str' || !REG_AWS.test(decodeStr(v.v))) return 'required_providers';
      }
    }
  }
  return null;
}

// Scan every config file in the job folder before a plan / plan 전에 작업 폴더의 모든 설정 파일 검사
export async function assertSafeConfig(dir: string): Promise<void> {
  for (const f of await fs.promises.readdir(dir)) {
    if (f.endsWith('.tf.json')) throw named('UnsafeConfig');
    if (!f.endsWith('.tf')) continue;
    if (unsafeConfigReason(f, await fs.promises.readFile(path.join(dir, f), 'utf8'))) {
      console.error('[tf-export] UnsafeConfig');
      throw named('UnsafeConfig');
    }
  }
}

// ---------- fixed files / 고정 파일 ----------

// Working providers.tf pins the exact Terraform the job runs / 작업용 providers.tf는 작업이 쓰는 Terraform을 정확히 고정
const providersTf = (requiredVersion: string) => `terraform {
  required_version = "${requiredVersion}"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.100.0"
    }
  }
}

provider "aws" {
  region = var.region
}
`;
export const PROVIDERS_TF = providersTf('= 1.9.8');
// Shipped providers.tf accepts any 1.x from 1.5 (import blocks need 1.5) / 묶음의 providers.tf는 1.5 이상 1.x 허용 (import 블록은 1.5부터)
export const BUNDLE_PROVIDERS_TF = providersTf('>= 1.5.0, < 2.0.0');

// variables.tf: region + sensitive secret variables / variables.tf: region과 sensitive 비밀 변수
function variablesFile(region: string, vars: SecretVar[], rename?: Record<string, string>): string {
  const region_ = `variable "region" {\n  type    = string\n  default = ${hclString(region)}\n}\n`;
  const vs = vars.map(v => ({ ...v, address: rename?.[v.address] ?? v.address }));
  return vs.length ? `${region_}\n${variablesTf(vs)}` : region_;
}

function importsFile(items: ExportItem[]): string {
  return items.map(i => `import {\n  to = ${i.address}\n  id = ${hclString(i.importId)}\n}\n`).join('\n');
}

// Attributes under lifecycle.ignore_changes of a resource / 리소스의 lifecycle.ignore_changes 속성
function ignoreChangesOf(text: string, address: string): string[] {
  const out: string[] = [];
  for (const b of nestedBlocks(text, address, 'lifecycle')) {
    const m = /ignore_changes\s*=\s*\[([^\]]*)\]/.exec(b.body);
    if (m) for (const a of m[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)) if (!out.includes(a)) out.push(a);
  }
  return out;
}

// Value at a plan path like `a.b[0].c` / `a.b[0].c` 같은 경로의 값
function valueAt(obj: unknown, p: string): unknown {
  let cur: unknown = obj;
  for (const part of p.split(/[.[\]]+/).filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// ---------- pipeline context / 파이프라인 문맥 ----------

interface Ctx {
  job: JobRecord;
  dir: string;
  deps: JobDeps;
  hostAccountId: string;
  generated: string;
  imports: string;
  secrets: SecretVar[];
  ruleIgnored: Record<string, string[]>;
  // Diff-stage passes where only sensitivity marks changed (original addresses) / diff 단계에서 숨김 표시만 바뀐 통과 (원래 주소)
  sensitiveOnly: Map<string, string[]>;
  placeholder: boolean;
  failed: Map<string, { reason: string; changedPaths?: string[] }>;
  passedAtRules: Set<string>;
  aiTouched: Set<string>;
  bundleFiles: Set<string>;
  ai: { calls: number; inputTokens: number; outputTokens: number };
  logN: number;
  cancelled: boolean;
  abort: AbortController;
}

type Check = { verdicts: Map<string, Verdict>; json: unknown } | { errors: PlanError[] };

function checkpoint(ctx: Ctx): void {
  if (ctx.cancelled) throw named('Timeout');
}

async function setStage(ctx: Ctx, stage: Stage): Promise<void> {
  checkpoint(ctx);
  ctx.job.stage = stage;
  ctx.deps.onStage?.(stage);
  await saveJob(ctx.job);
}

const present = (ctx: Ctx) => ctx.job.items.filter(i => !ctx.failed.has(i.address));

async function write(ctx: Ctx, name: string, text: string | Buffer): Promise<void> {
  checkpoint(ctx);
  await fs.promises.writeFile(path.join(ctx.dir, name), text);
}
const rm = (ctx: Ctx, name: string) => fs.promises.rm(path.join(ctx.dir, name), { recursive: true, force: true });

// Run one allowed terraform command and keep its log in the job folder / 허용된 terraform 명령 하나 실행, 로그는 작업 폴더에
async function tf(ctx: Ctx, args: string[]): Promise<ExecResult> {
  checkpoint(ctx);
  assertAllowed(args);
  const run = ctx.deps.terraform ?? (await import('./runner')).runTerraform;
  const r = await run(args, { cwd: ctx.dir, accountId: ctx.job.accountId, hostAccountId: ctx.hostAccountId, region: ctx.job.region, signal: ctx.abort.signal });
  checkpoint(ctx);
  const n = String(++ctx.logN).padStart(3, '0');
  await fs.promises.mkdir(path.join(ctx.dir, 'logs'), { recursive: true });
  await fs.promises.writeFile(path.join(ctx.dir, 'logs', `${n}-${args[0]}.log`), `${r.stdout}\n${r.stderr}`);
  if (r.code === 124) throw named('CommandTimeout');
  return r;
}

// Write the raw working set: generated.tf + imports.tf / 작업용 원본 세트 쓰기
async function writeWorking(ctx: Ctx, generated = ctx.generated, imports = ctx.imports): Promise<void> {
  await write(ctx, 'generated.tf', generated);
  await write(ctx, 'imports.tf', imports);
}

// Secrets referenced by the current text only / 지금 텍스트가 참조하는 비밀만
const usedSecrets = (vars: SecretVar[], texts: string[]) => vars.filter(v => texts.some(t => new RegExp(`\\bvar\\.${v.name}\\b`).test(t)));

async function writeSecrets(ctx: Ctx, vars: SecretVar[], rename?: Record<string, string>): Promise<void> {
  await write(ctx, 'variables.tf', variablesFile(ctx.job.region, vars, rename));
  if (vars.length) await write(ctx, 'secrets.auto.tfvars', secretsTfvars(vars));
  else await rm(ctx, 'secrets.auto.tfvars');
}

// plan -out=plan.bin; errors parsed from the output / plan 실행, 출력에서 오류 파싱
async function plan(ctx: Ctx): Promise<PlanError[]> {
  await assertSafeConfig(ctx.dir);
  await rm(ctx, 'plan.bin');
  const r = await tf(ctx, ['plan', '-input=false', '-no-color', '-out=plan.bin']);
  const errors = parsePlanErrors(`${r.stdout}\n${r.stderr}`);
  if (r.code !== 0 && !errors.length) errors.push({ title: 'PlanFailed', detail: '' });
  return errors;
}

async function show(ctx: Ctx): Promise<{ verdicts: Map<string, Verdict>; json: unknown }> {
  const r = await tf(ctx, ['show', '-json', '-no-color', 'plan.bin']);
  if (r.code !== 0) throw named('ShowFailed');
  let json: unknown;
  try { json = JSON.parse(r.stdout); } catch { throw named('ShowFailed'); }
  await write(ctx, 'plan.json', r.stdout);
  return { verdicts: judgePlan(json), json };
}

async function check(ctx: Ctx): Promise<Check> {
  const errors = await plan(ctx);
  if (errors.length) return { errors };
  return show(ctx);
}

// Before-value (remote) of a resource change / 리소스 변경의 before(원격) 값
function remoteOf(json: unknown, address: string): unknown {
  const rcs = (json as { resource_changes?: Array<{ address?: string; change?: { before?: unknown } }> })?.resource_changes ?? [];
  return rcs.find(r => r.address === address)?.change?.before;
}

// Mark failed and drop the resource together with its import block (Review Focus #4) / 실패 표시 후 리소스와 import 블록을 함께 빼기
function dropItem(ctx: Ctx, address: string, reason: string, changedPaths?: string[]): void {
  ctx.failed.set(address, { reason, changedPaths });
  ctx.generated = removeResource(ctx.generated, address);
  ctx.imports = removeImport(ctx.imports, address);
}

// One AI fix, re-validated here as defense in depth / AI 수정 한 번, 여기서 다시 검증
async function callAi(ctx: Ctx, input: AiFixInput): Promise<string | null> {
  checkpoint(ctx);
  const fix = ctx.deps.aiFix ?? (await import('./ai')).aiFix;
  let r: AiFixResult;
  try {
    r = await fix({ ...input, userId: ctx.job.requestedBy ?? undefined });
  } catch (e) {
    console.error('[tf-export] AiFixFailed', e instanceof Error ? e.name : 'Error');
    return null;
  }
  checkpoint(ctx);
  ctx.ai.calls++;
  ctx.ai.inputTokens += r.inputTokens || 0;
  ctx.ai.outputTokens += r.outputTokens || 0;
  ctx.aiTouched.add(input.address);
  if (!r.ok || !r.block) return null;
  const v = validateFix(r.block, input.address, input.block);
  return v.ok ? v.block : null;
}

const blockOf = (text: string, address: string) => splitResources(text).find(r => r.address === bare(address))?.body;

// Group addressed errors by present resource; the rest are unattributed / 주소 있는 오류를 리소스별로 묶고 나머지는 귀속 불가
function groupErrors(ctx: Ctx, errors: PlanError[]): { by: Map<string, PlanError[]>; other: PlanError[] } {
  const known = new Set(present(ctx).map(i => i.address));
  const by = new Map<string, PlanError[]>();
  const other: PlanError[] = [];
  for (const e of errors) {
    const a = e.address ? bare(e.address) : '';
    if (a && known.has(a)) (by.get(a) ?? by.set(a, []).get(a)!).push(e);
    else other.push(e);
  }
  return { by, other };
}

async function ensurePlaceholder(ctx: Ctx): Promise<void> {
  if (ctx.placeholder) return;
  await write(ctx, LAMBDA_PLACEHOLDER, makeZip([]));
  ctx.placeholder = true;
}

// ---------- stages / 단계 ----------

async function prepare(ctx: Ctx): Promise<void> {
  await setStage(ctx, 'prepare');
  await fs.promises.mkdir(ctx.dir, { recursive: true });
  ctx.imports = importsFile(ctx.job.items);
  await write(ctx, 'providers.tf', PROVIDERS_TF);
  await write(ctx, 'variables.tf', variablesFile(ctx.job.region, []));
  await write(ctx, 'imports.tf', ctx.imports);
  const r = await tf(ctx, ['init', '-input=false', '-no-color']);
  if (r.code !== 0) throw named('InitFailed');
}

// generate once, then move secrets into variables right away (ruling 1) / 한 번만 생성하고 바로 비밀을 변수로 옮김
async function generate(ctx: Ctx): Promise<PlanError[]> {
  await setStage(ctx, 'generate');
  await assertSafeConfig(ctx.dir);
  await rm(ctx, 'generated.tf');
  const r = await tf(ctx, ['plan', '-input=false', '-no-color', '-generate-config-out=generated.tf']);
  let raw: string;
  try { raw = await fs.promises.readFile(path.join(ctx.dir, 'generated.tf'), 'utf8'); } catch { throw named('GenerateFailed'); }
  const ex = extractSecrets(raw);
  raw = '';
  ctx.generated = ex.text;
  ctx.secrets = ex.vars;
  await write(ctx, 'generated.tf', ctx.generated);
  await writeSecrets(ctx, ctx.secrets);
  // Import targets without generated config / 설정이 생성되지 않은 import 대상
  const have = new Set(splitResources(ctx.generated).map(b => b.address));
  for (const it of ctx.job.items) if (!have.has(it.address)) dropItem(ctx, it.address, '설정을 만들지 못함');
  await write(ctx, 'imports.tf', ctx.imports);
  return parsePlanErrors(`${r.stdout}\n${r.stderr}`);
}

// Rules loop (≤4 while the error count shrinks), then one diff check for passRules / 규칙 반복 후 passRules 측정용 diff 확인 한 번
async function rules(ctx: Ctx, genErrors: PlanError[]): Promise<{ errors: PlanError[]; check: Check | null }> {
  await setStage(ctx, 'rules');
  let errors = genErrors;
  let count = genErrors.length;
  let planned = false;
  for (let round = 0; round < RULE_ROUNDS; round++) {
    const prev = { text: ctx.generated, ignored: JSON.parse(JSON.stringify(ctx.ruleIgnored)) as Record<string, string[]>, errors };
    const r = applyRules(ctx.generated, errors);
    for (const [a, attrs] of Object.entries(r.ignored)) {
      const cur = ctx.ruleIgnored[a] ?? (ctx.ruleIgnored[a] = []);
      for (const x of attrs) if (!cur.includes(x)) cur.push(x);
    }
    if (r.applied.some(x => x.startsWith('lambda-placeholder'))) await ensurePlaceholder(ctx);
    const changed = r.text !== ctx.generated;
    ctx.generated = r.text;
    if (!changed && planned) break;
    await writeWorking(ctx);
    errors = await plan(ctx);
    planned = true;
    if (errors.length > count) {
      // This round made it worse: go back to the previous text and stop / 이번 회차가 더 나빠지면 이전 텍스트로 되돌리고 멈춤
      ctx.generated = prev.text;
      ctx.ruleIgnored = prev.ignored;
      await writeWorking(ctx);
      // Round-0 errors came from generate (resource-relative lines); re-plan for current ones / 0회차 오류는 generate 것이라 다시 plan
      errors = round === 0 || !prev.errors.length ? await plan(ctx) : prev.errors;
      break;
    }
    if (!errors.length || errors.length === count) break;
    count = errors.length;
  }
  // passRules: diff check right after rules; resources still in error are left out of it / 규칙 직후 diff 확인, 오류가 남은 리소스는 빼고
  let chk: Check | null = null;
  if (!errors.length) {
    chk = await show(ctx);
  } else {
    const { by, other } = groupErrors(ctx, errors);
    if (!other.length) {
      let g = ctx.generated;
      let im = ctx.imports;
      for (const a of Array.from(by.keys())) { g = removeResource(g, a); im = removeImport(im, a); }
      await writeWorking(ctx, g, im);
      const c = await check(ctx);
      if (!('errors' in c)) for (const [a, v] of Array.from(c.verdicts)) if (v.outcome === 'pass') ctx.passedAtRules.add(a);
      await writeWorking(ctx);
      return { errors, check: null };
    }
  }
  if (chk) for (const [a, v] of Array.from(chk.verdicts)) if (v.outcome === 'pass') ctx.passedAtRules.add(a);
  return { errors, check: chk };
}

// AI fixes for resources still in error (≤3 rounds), then drop the rest / 오류가 남은 리소스를 AI로 고치고(최대 3회) 나머지는 빼기
async function aiFixStage(ctx: Ctx, errors: PlanError[]): Promise<boolean> {
  await setStage(ctx, 'ai-fix');
  if (!errors.length) return false;
  for (let round = 0; round < AI_ROUNDS && errors.length; round++) {
    const { by } = groupErrors(ctx, errors);
    if (!by.size) break;
    for (const [address, list] of Array.from(by)) {
      const block = blockOf(ctx.generated, address);
      if (!block) continue;
      const messages = list.map(e => scrubErrorText(`${e.title}\n${e.detail}`.trim()));
      const fixed = await callAi(ctx, { address, block, problem: { kind: 'error', messages } });
      if (fixed) ctx.generated = replaceResource(ctx.generated, address, fixed);
    }
    await writeWorking(ctx);
    errors = await plan(ctx);
  }
  const { by } = groupErrors(ctx, errors);
  for (const a of Array.from(by.keys())) dropItem(ctx, a, '자동 수정 실패');
  await writeWorking(ctx);
  return true;
}

// diff-0 gate on the raw working set; AI diff fixes ≤3 rounds, drop on failure / 원본 세트의 diff-0 관문, AI 수정 최대 3회, 실패는 빼기
async function diffStage(ctx: Ctx, reuse: Check | null): Promise<void> {
  await setStage(ctx, 'diff');
  let aiRounds = 0;
  let reverts = 0;
  let dropped = false;
  let edits = new Map<string, string>();
  let next: Check | null = reuse;
  for (;;) {
    const c = next ?? await check(ctx);
    next = null;
    if ('errors' in c) {
      // An AI diff fix broke the plan: undo it, else drop the resource / AI 수정이 plan을 깨면 되돌리고, 아니면 리소스 빼기
      if (++reverts > AI_ROUNDS) throw named('PlanFailed');
      const { by, other } = groupErrors(ctx, c.errors);
      const targets = by.size ? Array.from(by.keys()) : other.length && edits.size ? Array.from(edits.keys()) : [];
      if (!targets.length) throw named('PlanFailed');
      for (const a of targets) {
        const prev = edits.get(a);
        if (prev) ctx.generated = replaceResource(ctx.generated, a, prev);
        else dropItem(ctx, a, 'plan 오류');
      }
      edits = new Map();
      await writeWorking(ctx);
      continue;
    }
    edits = new Map();
    const changed = present(ctx).filter(i => c.verdicts.get(i.address)?.outcome !== 'pass');
    if (!changed.length) {
      ctx.sensitiveOnly = sensitiveOf(present(ctx).map(i => i.address), c.verdicts, a => a);
      return;
    }
    if (dropped) throw named('DiffUnstable');
    if (aiRounds >= AI_ROUNDS) {
      for (const i of changed) {
        const paths = c.verdicts.get(i.address)?.changedPaths ?? ['(resource)'];
        dropItem(ctx, i.address, `diff가 남음(${paths.join(', ')})`, paths);
      }
      dropped = true;
      await writeWorking(ctx);
      continue;
    }
    aiRounds++;
    for (const i of changed) {
      const block = blockOf(ctx.generated, i.address);
      if (!block) continue;
      const v = c.verdicts.get(i.address);
      const before = remoteOf(c.json, i.address);
      const changes = (v?.changedPaths ?? ['(resource)']).map(p => ({ path: p, remote: p === '(resource)' ? null : scrubValue(p, valueAt(before, p)) }));
      const fixed = await callAi(ctx, { address: i.address, block, problem: { kind: 'diff', changes } });
      if (fixed) { edits.set(i.address, block); ctx.generated = replaceResource(ctx.generated, i.address, fixed); }
    }
    await writeWorking(ctx);
  }
}

type Bundle = { level: 'refactored' | 'named' | 'raw'; files: Record<string, string>; addresses: Record<string, string>; vars: SecretVar[]; sensitive: Map<string, string[]> };

// Sensitivity-only passes keyed by original address / 숨김 표시만 바뀐 통과 (원래 주소 기준)
function sensitiveOf(addresses: string[], verdicts: Map<string, Verdict>, to: (a: string) => string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const a of addresses) { const sp = verdicts.get(to(a))?.sensitiveOnly; if (sp) m.set(a, sp); }
  return m;
}
type LevelResult = { ok: true; bundle: Bundle } | { ok: false; whole: boolean; failed: Map<string, string[]> };

// Replace the files in the job folder with a candidate bundle / 작업 폴더의 파일을 후보 묶음으로 바꾸기
async function writeBundle(ctx: Ctx, files: Record<string, string>, vars: SecretVar[], rename?: Record<string, string>): Promise<void> {
  for (const f of Array.from(ctx.bundleFiles)) if (!(f in files)) await rm(ctx, f);
  await rm(ctx, 'generated.tf');
  ctx.bundleFiles = new Set(Object.keys(files));
  for (const [f, t] of Object.entries(files)) await write(ctx, f, t);
  await writeSecrets(ctx, vars, rename);
}

// Refactor at a level, fmt and verify; read back the formatted files on success / 단계별 정리 → fmt → 확인, 성공하면 정리된 파일을 다시 읽음
async function tryLevel(ctx: Ctx, level: 'refactored' | 'named', base: { generated: string; imports: string }, noRefs: string[]): Promise<LevelResult> {
  await setStage(ctx, 'refactor');
  const have = new Set(splitResources(base.generated).map(r => r.address));
  const items = present(ctx).filter(i => have.has(i.address));
  const b = refactorBundle({ generated: base.generated, imports: base.imports, items, level, noRefs });
  const texts = Object.values(b.files);
  const all = ctx.secrets.concat(b.secrets.filter(s => !ctx.secrets.some(x => x.name === s.name)));
  const vars = usedSecrets(all, texts);
  await writeBundle(ctx, b.files, vars, b.addresses);
  const fmt = await tf(ctx, ['fmt', '-no-color']);
  if (fmt.code !== 0) return { ok: false, whole: true, failed: new Map() };
  await setStage(ctx, 'verify');
  const c = await check(ctx);
  if ('errors' in c) return { ok: false, whole: true, failed: new Map() };
  const failed = new Map<string, string[]>();
  for (const i of items) {
    const v = c.verdicts.get(b.addresses[i.address] ?? i.address);
    if (v?.outcome !== 'pass') failed.set(i.address, v?.changedPaths ?? ['(resource)']);
  }
  if (failed.size) return { ok: false, whole: false, failed };
  const files: Record<string, string> = {};
  for (const f of Object.keys(b.files)) files[f] = await fs.promises.readFile(path.join(ctx.dir, f), 'utf8');
  const sensitive = sensitiveOf(items.map(i => i.address), c.verdicts, a => b.addresses[a] ?? a);
  return { ok: true, bundle: { level, files, addresses: b.addresses, vars, sensitive } };
}

// refactored → (undo refs of failed ones) → (drop) → named → raw; the shipped bundle is always the last diff-0 one / 정리 단계 폴백, 내주는 묶음은 언제나 마지막 diff 0
async function refactorAndVerify(ctx: Ctx): Promise<Bundle> {
  const base = { generated: ctx.generated, imports: ctx.imports };
  let r = await tryLevel(ctx, 'refactored', base, []);
  if (r.ok) return r.bundle;
  if (!r.whole) {
    const noRefs = Array.from(r.failed.keys());
    r = await tryLevel(ctx, 'refactored', base, noRefs);
    if (r.ok) return r.bundle;
  }
  // Still changing (or a whole-plan error): no references at all (spec §6.5) / 그래도 바뀌거나 plan 전체 오류면 참조 없이
  const n = await tryLevel(ctx, 'named', base, []);
  if (n.ok) return n.bundle;
  // Raw: the diff-0 working set from the diff stage, not planned again / 원본: diff 단계에서 diff 0이었던 세트 (다시 plan하지 않음)
  const files = { 'imports.tf': base.imports, 'main.tf': base.generated };
  const vars = usedSecrets(ctx.secrets, [base.generated]);
  return { level: 'raw', files, addresses: Object.fromEntries(present(ctx).map(i => [i.address, i.address])), vars, sensitive: ctx.sensitiveOnly };
}

// Item results and job stats / 항목 결과와 작업 지표
function finalize(ctx: Ctx, bundle: Bundle | null, passAi: number, text: string): JobStats {
  const results: ItemResult[] = [];
  const byType: JobStats['byType'] = {};
  let pure = 0, ignore = 0, failed = 0;
  for (const i of ctx.job.items) {
    const t = (byType[i.tfType as TfType] ??= { total: 0, pass: 0 });
    t.total++;
    const f = ctx.failed.get(i.address);
    if (f || !bundle) {
      failed++;
      results.push({ address: i.address, tfType: i.tfType, name: i.name, outcome: 'failed', reason: f?.reason ?? '실패', ...(f?.changedPaths ? { changedPaths: f.changedPaths } : {}) });
      continue;
    }
    t.pass++;
    const ign = Array.from(new Set((ctx.ruleIgnored[i.address] ?? []).concat(ignoreChangesOf(text, i.address))));
    const passedAt = ctx.passedAtRules.has(i.address) && !ctx.aiTouched.has(i.address) ? 'rules' : 'ai';
    const sens = bundle.sensitive.get(i.address);
    const yellow = ign.length > 0 || !!sens;
    if (yellow) ignore++; else pure++;
    results.push({ address: bundle.addresses[i.address] ?? i.address, tfType: i.tfType, name: i.name, outcome: yellow ? 'pass-ignore' : 'pass', passedAt, ...(ign.length ? { ignored: ign } : {}), ...(sens ? { sensitiveOnly: sens } : {}) });
  }
  ctx.job.results = results;
  return {
    total: ctx.job.items.length, passRules: results.filter(r => r.passedAt === 'rules').length, passAi, passFinal: bundle ? pure + ignore : 0,
    pure, ignore, failed, byType, aiCalls: ctx.ai.calls, inputTokens: ctx.ai.inputTokens, outputTokens: ctx.ai.outputTokens,
  };
}

// Files that may stay in a finished job folder / 끝난 작업 폴더에 남겨도 되는 파일
async function cleanup(dir: string, keep: Set<string>): Promise<void> {
  let names: string[] = [];
  try { names = await fs.promises.readdir(dir); } catch { return; }
  for (const n of names) if (!keep.has(n)) await fs.promises.rm(path.join(dir, n), { recursive: true, force: true });
}

async function packageBundle(ctx: Ctx, bundle: Bundle): Promise<void> {
  await setStage(ctx, 'package');
  const files: Record<string, string | Buffer> = { 'providers.tf': BUNDLE_PROVIDERS_TF, 'variables.tf': variablesFile(ctx.job.region, bundle.vars, bundle.addresses), ...bundle.files };
  if (bundle.vars.length) files['terraform.tfvars.example'] = tfvarsExample(bundle.vars);
  if (Object.values(bundle.files).some(t => t.includes(LAMBDA_PLACEHOLDER))) files[LAMBDA_PLACEHOLDER] = makeZip([]);
  const names = Object.keys(files).concat(['README.md', 'report.json']);
  ctx.job.files = names;
  ctx.job.bundleLevel = bundle.level;
  ctx.job.finishedAt = new Date().toISOString();
  files['README.md'] = buildReadme(ctx.job, names);
  const report = {
    id: ctx.job.id, accountId: ctx.job.accountId, region: ctx.job.region, seed: ctx.job.seed,
    startedAt: ctx.job.startedAt, finishedAt: ctx.job.finishedAt, bundleLevel: bundle.level,
    items: scrubValue('', ctx.job.items.map(i => ({ address: bundle.addresses[i.address] ?? i.address, tfType: i.tfType, name: i.name, importId: i.importId }))),
    excluded: scrubValue('', ctx.job.excluded), results: scrubValue('', ctx.job.results), stats: ctx.job.stats,
  };
  files['report.json'] = JSON.stringify(report, null, 2) + '\n';
  checkpoint(ctx);
  // Drop working files (generated.tf, plan.bin, plan JSON, logs, secrets) before writing the bundle / 묶음을 쓰기 전에 작업 파일 지우기
  await cleanup(ctx.dir, new Set());
  for (const [f, d] of Object.entries(files)) await write(ctx, f, d);
  await write(ctx, BUNDLE_ZIP, makeZip(names.map(name => ({ name, data: files[name] }))));
}

async function pipeline(ctx: Ctx): Promise<void> {
  await prepare(ctx);
  const genErrors = await generate(ctx);
  const r = await rules(ctx, genErrors);
  const usedAi = await aiFixStage(ctx, r.errors);
  await diffStage(ctx, usedAi ? null : r.check);
  const passAi = present(ctx).length;
  if (!passAi) {
    ctx.job.stats = finalize(ctx, null, 0, '');
    await addStats(ctx.job.stats);
    throw named('NothingPassed');
  }
  const rawText = ctx.generated;
  const bundle = await refactorAndVerify(ctx);
  checkpoint(ctx);
  ctx.job.stats = finalize(ctx, bundle, passAi, rawText);
  await packageBundle(ctx, bundle);
  await addStats(ctx.job.stats);
  await setStage(ctx, 'done');
}

// Host account id for credentials / 자격 증명용 호스트 계정 id
async function accountInfo(accountId: string, deps: JobDeps): Promise<{ region: string; hostAccountId: string } | null> {
  if (deps.account) return deps.account(accountId);
  const cfg = await import('@/lib/app-config');
  const acc = cfg.getAccountById(accountId);
  if (!acc) return null;
  const host = cfg.getHostAccount()?.accountId ?? (cfg.getAccounts().length === 1 ? accountId : null);
  return host ? { region: acc.region, hostAccountId: host } : null;
}

/** Run the whole pipeline under the 30-minute cap; never throws. / 30분 상한 안에서 전체 파이프라인 실행, throw하지 않음. */
export async function runPipeline(job: JobRecord, deps: JobDeps = {}): Promise<void> {
  const st = tfExportState();
  st.jobs.set(job.id, job);
  const info = await accountInfo(job.accountId, deps).catch(() => null);
  const ctx: Ctx = {
    job, dir: jobDir(job.id), deps, hostAccountId: info?.hostAccountId ?? '', generated: '', imports: '', secrets: [], ruleIgnored: {}, sensitiveOnly: new Map(),
    placeholder: false, failed: new Map(), passedAtRules: new Set(), aiTouched: new Set(), bundleFiles: new Set(),
    ai: { calls: 0, inputTokens: 0, outputTokens: 0 }, logN: 0, cancelled: false, abort: new AbortController(),
  };
  const inner = info ? pipeline(ctx) : Promise.reject(named('NotFound'));
  inner.catch(() => undefined);
  try {
    await withCap(() => inner, deps.capMs ?? JOB_CAP_MS);
  } catch (e) {
    // Stop: no new steps, and kill a running terraform (SIGKILL) / 멈춤: 새 단계 금지, 실행 중인 terraform은 SIGKILL
    ctx.cancelled = true;
    ctx.abort.abort();
    const name = e instanceof Error && e.name ? e.name : 'Error';
    console.error('[tf-export] JobFailed', name);
    job.stage = 'failed';
    job.error = name;
    job.finishedAt = new Date().toISOString();
    delete job.files;
    deps.onStage?.('failed');
    await saveJob(job).catch(() => console.error('[tf-export] SaveFailed'));
    // Clean only after the run (and its child process) has settled / 실행과 자식 프로세스가 끝난 뒤에만 정리
    await inner.catch(() => undefined);
    await cleanup(ctx.dir, new Set()).catch(() => undefined);
    job.stage = 'failed';
    delete job.files;
    await saveJob(job).catch(() => console.error('[tf-export] SaveFailed'));
  } finally {
    st.jobs.delete(job.id);
  }
}

// ---------- public API / 공개 API ----------

function newJobId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const d = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const t = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${d}-${t}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Start one job in the background; throws Busy / NotInstalled / NotFound / Empty. / 작업 하나를 백그라운드로 시작. */
export async function startJob(req: { accountId: string; seed: ExportSeed; requestedBy: string | null }, deps: JobDeps = {}): Promise<{ jobId: string }> {
  await recoverInterrupted();
  const st = tfExportState();
  if (st.running) throw named('Busy');
  st.running = 'starting';
  let job: JobRecord;
  try {
    await sweepJobFolders();
    const installed = deps.installed ? await deps.installed() : (await (await import('./runner')).isInstalled()).installed;
    if (!installed) throw named('NotInstalled');
    const info = await accountInfo(req.accountId, deps);
    if (!info) throw named('NotFound');
    const data = deps.graph ? await deps.graph() : (await (await import('@/lib/dep-graph/build')).ensureGraph())?.data() ?? null;
    if (!data) throw named('NotFound');
    const select = deps.select ?? (await import('./select')).selectResources;
    const sel = await select({ accountId: req.accountId, seed: req.seed, data, region: info.region });
    if (!sel.items.length) throw named('Empty');
    job = {
      id: newJobId(), accountId: req.accountId, region: info.region, seed: req.seed, requestedBy: req.requestedBy,
      startedAt: new Date().toISOString(), stage: 'prepare', items: sel.items, excluded: sel.excluded, results: [],
    };
    await saveJob(job);
    st.running = job.id;
  } catch (e) {
    st.running = null;
    throw e;
  }
  void runPipeline(job, deps).finally(() => { if (st.running === job.id) st.running = null; });
  return { jobId: job.id };
}

/** Mark jobs left unfinished by a restart as failed (once per process). / 재시작으로 끝나지 않은 작업을 failed로 (프로세스당 한 번). */
export async function recoverInterrupted(): Promise<number> {
  const st = tfExportState();
  if (st.recovered) return 0;
  st.recovered = true;
  let n = 0;
  for (const j of await readJobs()) {
    if (j.stage === 'done' || j.stage === 'failed' || st.jobs.has(j.id) || st.running === j.id) continue;
    await saveJob({ ...j, stage: 'failed', error: '서버 재시작', finishedAt: new Date().toISOString() });
    n++;
  }
  await sweepJobFolders();
  return n;
}

/** Remove raw files from idle job folders: not-done folders are emptied, done ones keep only the bundle. / 쉬는 작업 폴더의 원본 파일 지우기: 끝나지 않은 폴더는 비우고, 끝난 폴더는 묶음만 남김. */
export async function sweepJobFolders(): Promise<void> {
  const st = tfExportState();
  const busy = (id: string) => st.jobs.has(id) || st.running === id;
  const jobs = await readJobs();
  const known = new Set(jobs.map(j => j.id));
  for (const j of jobs) {
    if (!JOB_ID.test(j.id) || busy(j.id)) continue; // malformed ids never become paths / 형식이 틀린 id는 경로로 쓰지 않음
    const keep = j.stage === 'done' && j.files ? new Set([...j.files, BUNDLE_ZIP]) : new Set<string>();
    await cleanup(jobDir(j.id), keep).catch(() => console.error('[tf-export] SweepFailed'));
  }
  let names: string[] = [];
  try { names = await fs.promises.readdir(jobsRoot()); } catch { return; }
  for (const n of names) if (JOB_ID.test(n) && !known.has(n) && !busy(n)) await fs.promises.rm(path.join(jobsRoot(), n), { recursive: true, force: true }).catch(() => undefined);
}

export async function getJob(id: string): Promise<JobRecord | null> {
  if (!JOB_ID.test(id)) return null;
  await recoverInterrupted();
  return tfExportState().jobs.get(id) ?? (await readJobs()).find(j => j.id === id) ?? null;
}

export async function listJobs(): Promise<JobRecord[]> {
  await recoverInterrupted();
  const mem = tfExportState().jobs;
  return (await readJobs()).map(j => mem.get(j.id) ?? j);
}

export function runningJobId(): string | null {
  const r = tfExportState().running;
  return r && r !== 'starting' ? r : null;
}

/** One text file of a finished bundle (names listed in job.files only). / 끝난 묶음의 텍스트 파일 하나 (job.files에 있는 이름만). */
export async function readBundleFile(id: string, name: string): Promise<string | null> {
  const job = await getJob(id);
  if (!job || job.stage !== 'done' || !job.files?.includes(name) || name.endsWith('.zip')) return null;
  try { return await fs.promises.readFile(path.join(jobDir(id), name), 'utf8'); } catch { return null; }
}

/** The bundle zip of a finished job. / 끝난 작업의 묶음 zip. */
export async function bundleZip(id: string): Promise<Buffer | null> {
  const job = await getJob(id);
  if (!job || job.stage !== 'done' || !job.files) return null;
  try { return await fs.promises.readFile(path.join(jobDir(id), BUNDLE_ZIP)); } catch { return null; }
}

