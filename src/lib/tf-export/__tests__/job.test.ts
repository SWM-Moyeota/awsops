// Single-job pipeline with a scripted fake terraform and a fake AI / 대본대로 답하는 가짜 terraform·AI로 단일 작업 파이프라인 시험
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipeline, startJob, recoverInterrupted, getJob, listJobs, readBundleFile, bundleZip, unsafeConfigReason, PROVIDERS_TF, type JobDeps, type TerraformFn } from '../job';
import { saveJob, readJobs, readStats, jobDir, tfExportState } from '../store';
import { splitResources } from '../hcl';
import { LAMBDA_PLACEHOLDER } from '../rules';
import type { AiFixInput, AiFixResult } from '../ai';
import type { ExportItem, JobRecord, Stage, TfType } from '../types';

const fx = path.join(__dirname, 'fixtures');
const RAW = fs.readFileSync(path.join(fx, 'generated.raw.tf'), 'utf-8');
const LOG = fs.readFileSync(path.join(fx, 'plan-errors.txt'), 'utf-8');
const PLAN = JSON.parse(fs.readFileSync(path.join(fx, 'plan.json'), 'utf-8'));
const SECRET = 'fake-secret-1';
const MARK = '# ai-fixed';

// Import ids from the fixture log; the vpc id is the one the subnet uses so references get made / 픽스처 로그의 import id (vpc는 서브넷이 쓰는 값으로 → 참조가 생김)
const IDS: Record<string, string> = {};
for (const m of Array.from(LOG.matchAll(/^(aws_\w+\.r_\w+): Preparing import\.\.\. \[id=([^\]]+)\]/gm))) IDS[m[1]] = m[2];
IDS['aws_vpc.r_vpc'] = 'vpc-928b1a8ef13830697';
const ITEMS: ExportItem[] = splitResources(RAW).map(r => ({
  address: r.address, tfType: r.type as TfType, importId: IDS[r.address], nodeArn: `arn:fake:${r.address}`,
  nodeType: 'vpc', name: `demo ${r.name.slice(2)}`, id: IDS[r.address],
}));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfx-job-'));
  process.env.TF_EXPORT_DATA_DIR = dir;
  globalThis.__awsopsTfExport = undefined;
});
afterEach(() => {
  delete process.env.TF_EXPORT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function makeJob(over: Partial<JobRecord> = {}): JobRecord {
  seq++;
  return {
    id: `20261029-120000-${seq.toString(16).padStart(6, '0')}`, accountId: '111122223333', region: 'ap-northeast-2',
    seed: { kind: 'prefix', prefix: 'demo' }, requestedBy: 'tester', startedAt: new Date(Date.UTC(2026, 9, 29, 12, 0, seq)).toISOString(),
    stage: 'prepare', items: ITEMS, excluded: [{ nodeArn: 'arn:x', name: 'eni-1', nodeType: 'eni', reason: 'unsupported' }], results: [], ...over,
  };
}

const tfFiles = (cwd: string) => fs.readdirSync(cwd).filter(f => f.endsWith('.tf')).map(f => ({ f, t: fs.readFileSync(path.join(cwd, f), 'utf8') }));
const allBlocks = (cwd: string) => tfFiles(cwd).flatMap(({ t }) => splitResources(t));

interface Script {
  // Extra plan errors for the current config (null = clean) / 지금 설정에 대한 추가 plan 오류
  planError?: (files: Array<{ f: string; t: string }>) => string | null;
  // Is a resource still changed? (default: the instance until the AI marks it) / 리소스가 아직 바뀌는지
  changed?: (address: string, body: string, files: Array<{ f: string; t: string }>) => boolean;
  hang?: Promise<void>;
}

// Fake terraform: generate writes the raw fixture + fixture errors; later plans/shows are built from the folder / 가짜 terraform
function fakeTf(script: Script = {}) {
  const calls: string[][] = [];
  const seen: string[] = [];
  const fn: TerraformFn = async (args, o) => {
    calls.push(args);
    const [sub] = args;
    if (script.hang) await script.hang;
    if (sub === 'init' || sub === 'fmt') return { code: 0, stdout: '', stderr: '' };
    const files = tfFiles(o.cwd);
    seen.push(files.map(x => x.t).join('\n') + (fs.existsSync(path.join(o.cwd, 'secrets.auto.tfvars')) ? fs.readFileSync(path.join(o.cwd, 'secrets.auto.tfvars'), 'utf8') : ''));
    if (sub === 'plan') {
      if (args.some(a => a.startsWith('-generate-config-out='))) {
        fs.writeFileSync(path.join(o.cwd, 'generated.tf'), RAW);
        return { code: 1, stdout: '', stderr: LOG };
      }
      const err = script.planError?.(files);
      if (err) return { code: 1, stdout: '', stderr: err };
      fs.writeFileSync(path.join(o.cwd, 'plan.bin'), 'bin');
      return { code: 0, stdout: 'Plan: 0 to add', stderr: '' };
    }
    if (sub === 'show') {
      const changed = script.changed ?? ((a: string, body: string) => a.startsWith('aws_instance.') && !body.includes(MARK));
      const rcs = allBlocks(o.cwd).map(b => {
        const base = PLAN.resource_changes.find((r: { type: string }) => r.type === b.type);
        const rc = JSON.parse(JSON.stringify(base));
        rc.address = b.address;
        rc.name = b.name;
        if (changed(b.address, b.body, files)) {
          rc.change.actions = ['update'];
          if (b.type === 'aws_lambda_function') {
            rc.change.before.environment = [{ variables: { APP_MODE: 'demo-value', DB_PASSWORD: SECRET } }];
            rc.change.after.environment = [{ variables: { APP_MODE: 'demo-value', DB_PASSWORD: 'x' } }];
          }
          else if (b.type !== 'aws_instance') rc.change.after.tags = { changed: 'yes' };
        } else {
          rc.change.actions = ['no-op'];
          rc.change.after = rc.change.before;
        }
        return rc;
      });
      return { code: 0, stdout: JSON.stringify({ ...PLAN, resource_changes: rcs, configuration: { root_module: { resources: rcs.map((r: { address: string }) => ({ address: r.address, mode: 'managed' })) } } }), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { fn, calls, seen };
}

// Fake AI: fixes listed addresses by adding a marker comment / 가짜 AI: 지정한 주소에 표시 주석을 넣어 고침
function fakeAi(fixes: (a: string) => boolean = a => a.startsWith('aws_instance.'), override?: (i: AiFixInput) => string | null) {
  const inputs: AiFixInput[] = [];
  const fn = async (i: AiFixInput): Promise<AiFixResult> => {
    inputs.push(i);
    const o = override?.(i);
    if (o) return { ok: true, block: o, inputTokens: 10, outputTokens: 5 };
    if (!fixes(i.address)) return { ok: false, reason: 'no', inputTokens: 10, outputTokens: 5 };
    return { ok: true, block: i.block.replace('{', `{\n  ${MARK}`), inputTokens: 10, outputTokens: 5 };
  };
  return { fn, inputs };
}

function deps(tf: TerraformFn, ai: JobDeps['aiFix'], stages?: Stage[], extra: Partial<JobDeps> = {}): JobDeps {
  return { terraform: tf, aiFix: ai, account: () => ({ region: 'ap-northeast-2', hostAccountId: '111122223333' }), onStage: s => stages?.push(s), ...extra };
}

// Read every file left in the job folder / 작업 폴더에 남은 모든 파일 읽기
const leftovers = (id: string) => fs.readdirSync(jobDir(id));
const zipText = (b: Buffer) => b.toString('latin1');

describe('runPipeline — happy path on the fixtures', () => {
  it('runs the stages in order, generates once, ships a refactored diff-0 bundle and cleans up', async () => {
    const tf = fakeTf();
    const ai = fakeAi();
    const stages: Stage[] = [];
    const job = makeJob();
    await runPipeline(job, deps(tf.fn, ai.fn, stages));
    expect(job.error).toBeUndefined();
    expect(stages).toEqual(['prepare', 'generate', 'rules', 'ai-fix', 'diff', 'refactor', 'verify', 'package', 'done']);
    expect(job.stage).toBe('done');
    expect(tf.calls.filter(a => a.some(x => x.startsWith('-generate-config-out'))).length).toBe(1);
    // -no-color / -input=false always / 항상 붙음
    for (const a of tf.calls) {
      if (a[0] === 'plan' || a[0] === 'init') expect(a).toEqual(expect.arrayContaining(['-input=false', '-no-color']));
      if (a[0] === 'show' || a[0] === 'fmt') expect(a).toContain('-no-color');
    }
    expect(job.bundleLevel).toBe('refactored');
    expect(job.stats).toMatchObject({ total: 14, passRules: 13, passAi: 14, passFinal: 14, pure: 12, ignore: 2, failed: 0, aiCalls: 1, inputTokens: 10, outputTokens: 5 });
    expect(job.results.filter(r => r.passedAt === 'rules').length).toBe(job.stats!.passRules);
    expect(job.stats!.byType.aws_instance).toEqual({ total: 1, pass: 1 });
    const inst = job.results.find(r => r.tfType === 'aws_instance')!;
    expect(inst).toMatchObject({ outcome: 'pass-ignore', passedAt: 'ai', ignored: ['user_data'] });
    expect(job.results.find(r => r.tfType === 'aws_vpc')).toMatchObject({ outcome: 'pass', passedAt: 'rules', address: 'aws_vpc.demo_vpc' });
    expect(job.results.find(r => r.tfType === 'aws_lambda_function')).toMatchObject({ outcome: 'pass-ignore', ignored: ['filename', 'source_code_hash'] });
    // Bundle files / 묶음 파일
    expect(job.files).toEqual(expect.arrayContaining(['providers.tf', 'variables.tf', 'imports.tf', 'network.tf', 'security.tf', 'compute.tf', 'data.tf', 'iam.tf', 'edge.tf', 'terraform.tfvars.example', LAMBDA_PLACEHOLDER, 'README.md', 'report.json']));
    expect(leftovers(job.id).sort()).toEqual([...job.files!, 'bundle.zip'].sort());
    const network = (await readBundleFile(job.id, 'network.tf'))!;
    expect(network).toMatch(/vpc_id\s+= aws_vpc\.demo_vpc\.id/);
    expect(await readBundleFile(job.id, 'imports.tf')).toContain('to = aws_vpc.demo_vpc');
    expect(await readBundleFile(job.id, 'generated.tf')).toBeNull();
    expect(await readBundleFile(job.id, LAMBDA_PLACEHOLDER)).toBeNull();
    expect(await readBundleFile(job.id, 'variables.tf')).toMatch(/sensitive\s+= true/);
    expect(await readBundleFile(job.id, 'terraform.tfvars.example')).toContain('CHANGE_ME');
    const readme = (await readBundleFile(job.id, 'README.md'))!;
    expect(readme).toContain('14 to import, 0 to add, 0 to change, 0 to destroy');
    expect(readme).toContain('CHANGE_ME');
    expect(readme).toContain('지원 안 함');
    expect(readme).toContain('user_data');
    expect(readme).toContain('Lambda 코드');
    // The secret never reaches the AI, the zip, the report or the folder / 비밀은 AI·zip·리포트·폴더 어디에도 없음
    expect(JSON.stringify(ai.inputs)).not.toContain(SECRET);
    const zip = (await bundleZip(job.id))!;
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zipText(zip)).not.toContain(SECRET);
    expect(zipText(zip)).toContain('report.json');
    for (const f of leftovers(job.id)) expect(fs.readFileSync(path.join(jobDir(job.id), f), 'latin1'), f).not.toContain(SECRET);
    // Rules/AI working files only ever held var.<name>; the real value lived in secrets.auto.tfvars / 작업 파일엔 var.<이름>만, 실제 값은 secrets.auto.tfvars에만
    expect(tf.seen.slice(1).every(t => !t.replace(/^.*= "fake-secret-1"$/m, '').includes(SECRET))).toBe(true);
    expect(tf.seen.slice(1).some(t => /= "fake-secret-1"/.test(t))).toBe(true);
    // Stats accumulated / 지표 누적
    expect(await readStats()).toMatchObject({ jobs: 1, total: 14, passFinal: 14 });
    expect((await readJobs())[0]).toMatchObject({ id: job.id, stage: 'done' });
  });

  it('creates the empty placeholder zip as soon as the lambda rule fires', async () => {
    let seenAt = -1;
    const base = fakeTf();
    const tf: TerraformFn = async (a, o) => {
      if (seenAt < 0 && a[0] === 'plan' && !a.some(x => x.startsWith('-generate')) && fs.existsSync(path.join(o.cwd, LAMBDA_PLACEHOLDER))) seenAt = base.calls.length;
      return base.fn(a, o);
    };
    const job = makeJob();
    await runPipeline(job, deps(tf, fakeAi().fn));
    expect(seenAt).toBe(2); // first plan after generate / generate 다음 첫 plan
  });
});

describe('runPipeline — failures and fallbacks', () => {
  it('drops a resource that keeps erroring, together with its import block', async () => {
    const eipErr = 'Error: Unsupported argument\n\n  with aws_eip.r_eip,\n  on generated.tf line 1, in resource "aws_eip" "r_eip":\n   1: resource "aws_eip" "r_eip" {\n\nAn argument named "bogus" is not expected here.\n';
    const tf = fakeTf({ planError: files => (files.some(x => /resource "aws_eip" "r_eip"/.test(x.t)) ? eipErr : null) });
    const ai = fakeAi();
    const job = makeJob();
    await runPipeline(job, deps(tf.fn, ai.fn));
    expect(job.stage).toBe('done');
    expect(ai.inputs.filter(i => i.address === 'aws_eip.r_eip').length).toBe(3);
    expect(ai.inputs.find(i => i.address === 'aws_eip.r_eip')!.problem).toMatchObject({ kind: 'error' });
    expect(job.results.find(r => r.tfType === 'aws_eip')).toMatchObject({ outcome: 'failed', reason: '자동 수정 실패' });
    expect(job.stats).toMatchObject({ total: 14, passRules: 12, passAi: 13, passFinal: 13, failed: 1 });
    const imports = (await readBundleFile(job.id, 'imports.tf'))!;
    expect(imports).not.toContain('eipalloc-');
    expect((await readBundleFile(job.id, 'network.tf'))!).not.toContain('aws_eip');
    expect(await readBundleFile(job.id, 'README.md')).toContain('자동 수정 실패');
  });

  it('drops a resource whose diff the AI cannot fix, hiding secret remote values from the AI', async () => {
    const tf = fakeTf({ changed: (a, body) => a.startsWith('aws_lambda_function.') || (a.startsWith('aws_instance.') && !body.includes(MARK)) });
    const ai = fakeAi();
    const job = makeJob();
    await runPipeline(job, deps(tf.fn, ai.fn));
    expect(job.stage).toBe('done');
    const lam = ai.inputs.filter(i => i.address.startsWith('aws_lambda_function.'));
    expect(lam.length).toBe(3);
    expect(lam[0].problem).toEqual({ kind: 'diff', changes: [{ path: 'environment[0].variables.DB_PASSWORD', remote: '[숨김]' }] });
    expect(JSON.stringify(ai.inputs)).not.toContain(SECRET);
    expect(job.results.find(r => r.tfType === 'aws_lambda_function')).toMatchObject({ outcome: 'failed', reason: 'diff가 남음(environment[0].variables.DB_PASSWORD)' });
    expect(job.files).not.toContain('terraform.tfvars.example');
    expect(job.files).not.toContain(LAMBDA_PLACEHOLDER);
    expect(await readBundleFile(job.id, 'variables.tf')).not.toContain('sensitive');
  });

  it('rejects an AI block with a provisioner (counted as a failed fix)', async () => {
    const tf = fakeTf();
    const ai = fakeAi(() => false, i => `resource "aws_instance" "${i.address.split('.')[1]}" {\n  provisioner "local-exec" { command = "id" }\n}`);
    const job = makeJob();
    await runPipeline(job, deps(tf.fn, ai.fn));
    expect(job.results.find(r => r.tfType === 'aws_instance')).toMatchObject({ outcome: 'failed' });
    expect(job.stats!.aiCalls).toBe(3);
  });

  it('undoes references of a resource that changes after refactor', async () => {
    // The subnet changes only while it references the vpc / 서브넷은 vpc를 참조할 때만 바뀜
    const tf = fakeTf({ changed: (a, body) => (a.startsWith('aws_instance.') && !body.includes(MARK)) || (a.startsWith('aws_subnet.') && /aws_vpc\.\w+\.id/.test(body)) });
    const job = makeJob();
    await runPipeline(job, deps(tf.fn, fakeAi().fn));
    expect(job.bundleLevel).toBe('refactored');
    expect(job.stats!.passFinal).toBe(14);
    expect(await readBundleFile(job.id, 'network.tf')).toContain('"vpc-928b1a8ef13830697"');
  });

  it('falls back to named on a whole-plan error with references (e.g. a cycle)', async () => {
    const cycle = 'Error: Cycle: aws_security_group.a, aws_security_group.b\n';
    const tf = fakeTf({ planError: files => (files.some(x => /= aws_\w+\.\w+\.(id|arn)\b/.test(x.t)) ? cycle : null) });
    const stages: Stage[] = [];
    const job = makeJob();
    await runPipeline(job, deps(tf.fn, fakeAi().fn, stages));
    expect(job.bundleLevel).toBe('named');
    expect(job.stats!.passFinal).toBe(14);
    expect(stages.filter(s => s === 'verify').length).toBe(2);
    expect(await readBundleFile(job.id, 'network.tf')).toContain('resource "aws_vpc" "demo_vpc"');
    expect(await readBundleFile(job.id, 'README.md')).toContain('묶음 단계: named');
  });

  it('falls back to raw (the last diff-0 text) when every refactored layout errors', async () => {
    const tf = fakeTf({ planError: files => (files.some(x => x.f === 'network.tf') ? 'Error: Something broke\n' : null) });
    const job = makeJob();
    await runPipeline(job, deps(tf.fn, fakeAi().fn));
    expect(job.bundleLevel).toBe('raw');
    expect(job.files).toContain('main.tf');
    expect(job.files).not.toContain('network.tf');
    const main = (await readBundleFile(job.id, 'main.tf'))!;
    expect(main).toContain('resource "aws_vpc" "r_vpc"');
    expect(main).toContain(MARK);
    expect(main).not.toContain(SECRET);
    expect(await readBundleFile(job.id, 'imports.tf')).toContain('to = aws_vpc.r_vpc');
  });

  it('fails with UnsafeConfig when a plan would load a module, and deletes secrets and logs', async () => {
    const base = fakeTf();
    const tf: TerraformFn = async (a, o) => {
      const r = await base.fn(a, o);
      if (a.some(x => x.startsWith('-generate'))) fs.appendFileSync(path.join(o.cwd, 'generated.tf'), '\nmodule "x" {\n  source = "./evil"\n}\n');
      return r;
    };
    const job = makeJob();
    await runPipeline(job, deps(tf, fakeAi().fn));
    expect(job).toMatchObject({ stage: 'failed', error: 'UnsafeConfig' });
    expect(fs.existsSync(jobDir(job.id)) ? leftovers(job.id) : []).toEqual([]);
  });

  it('a thrown error fails the job and still deletes secrets, logs and generated.tf', async () => {
    const base = fakeTf();
    let secretsSeen = false;
    const tf: TerraformFn = async (a, o) => {
      if (a[0] === 'show') { secretsSeen = fs.readFileSync(path.join(o.cwd, 'secrets.auto.tfvars'), 'utf8').includes(SECRET); return { code: 1, stdout: '', stderr: 'boom' }; }
      return base.fn(a, o);
    };
    const job = makeJob();
    await runPipeline(job, deps(tf, fakeAi().fn));
    expect(secretsSeen).toBe(true);
    expect(job).toMatchObject({ stage: 'failed', error: 'ShowFailed' });
    expect(leftovers(job.id)).toEqual([]);
    expect((await readJobs())[0]).toMatchObject({ stage: 'failed', error: 'ShowFailed' });
  });

  it('the 30-minute cap fails the job with Timeout and deletes secrets', async () => {
    let release!: () => void;
    const hang = new Promise<void>(r => { release = r; });
    const base = fakeTf();
    const tf: TerraformFn = async (a, o) => {
      if (a[0] === 'show') { setTimeout(release, 80); await hang; }
      return base.fn(a, o);
    };
    const job = makeJob();
    await runPipeline(job, deps(tf, fakeAi().fn, undefined, { capMs: 30 }));
    expect(job).toMatchObject({ stage: 'failed', error: 'Timeout' });
    expect(leftovers(job.id)).toEqual([]);
    expect((await readJobs())[0]).toMatchObject({ stage: 'failed', error: 'Timeout' });
  });
});

describe('runPipeline — fix round 1', () => {
  it('the cap aborts a running terraform and cleans up only after the child exited', async () => {
    const base = fakeTf();
    let signalSeen: AbortSignal | undefined;
    // Fake honoring the signal: like a killed plan it writes files right before it exits / signal을 따르는 가짜: 끝나기 직전 파일을 씀
    const tf: TerraformFn = async (a, o) => {
      if (a[0] === 'show') {
        signalSeen = o.signal;
        return new Promise(res => o.signal!.addEventListener('abort', () => {
          setTimeout(() => {
            fs.writeFileSync(path.join(o.cwd, 'plan.bin'), 'late');
            fs.writeFileSync(path.join(o.cwd, 'generated.tf'), `x = "${SECRET}"`);
            res({ code: 137, stdout: '', stderr: 'aborted' });
          }, 20);
        }));
      }
      return base.fn(a, o);
    };
    const job = makeJob();
    await runPipeline(job, deps(tf, fakeAi().fn, undefined, { capMs: 1000 }));
    expect(signalSeen?.aborted).toBe(true);
    expect(job).toMatchObject({ stage: 'failed', error: 'Timeout' });
    expect(leftovers(job.id)).toEqual([]);
  });

  it('a rules round that adds errors is reverted and the loop stops', async () => {
    const vpcErr = 'Error: Invalid value\n\n  with aws_vpc.r_vpc,\n  on generated.tf line 1, in resource "aws_vpc" "r_vpc":\n   1: resource "aws_vpc" "r_vpc" {\n\nbad\n';
    const eipErr = 'Error: Unsupported argument\n\n  with aws_eip.r_eip,\n  on generated.tf line 1, in resource "aws_eip" "r_eip":\n   1: resource "aws_eip" "r_eip" {\n\nbogus\n';
    const rulesRan = (files: Array<{ f: string; t: string }>) => files.some(x => x.f === 'generated.tf' && x.t.includes(LAMBDA_PLACEHOLDER));
    const tf = fakeTf({
      planError: files => {
        if (rulesRan(files)) return vpcErr.repeat(20);
        const eipFixed = files.some(x => /resource "aws_eip"[^]*?# ai-fixed/.test(x.t));
        return eipFixed ? null : eipErr;
      },
    });
    const ai = fakeAi(a => a.startsWith('aws_eip.') || a.startsWith('aws_instance.'));
    const job = makeJob();
    await runPipeline(job, deps(tf.fn, ai.fn));
    expect(job.stage).toBe('done');
    // Only one rules plan + one re-plan of the reverted text before ai-fix / 규칙 plan 한 번 + 되돌린 텍스트 plan 한 번
    const plansBeforeAi = tf.calls.slice(2, 4).map(a => a[0]);
    expect(plansBeforeAi).toEqual(['plan', 'plan']);
    expect(ai.inputs[0]).toMatchObject({ address: 'aws_eip.r_eip', problem: { kind: 'error' } });
    expect(job.results.find(r => r.tfType === 'aws_lambda_function')).toMatchObject({ outcome: 'pass' });
    expect(job.files).not.toContain(LAMBDA_PLACEHOLDER);
    expect(await readBundleFile(job.id, 'compute.tf')).not.toContain(LAMBDA_PLACEHOLDER);
  });

  it('still-changing resources after undoing their references go to named, nothing is dropped', async () => {
    const anyRef = (files: Array<{ f: string; t: string }>) => files.some(x => /= aws_\w+\.\w+\.(id|arn)\b/.test(x.t));
    const tf = fakeTf({ changed: (a, body, files) => (a.startsWith('aws_instance.') && !body.includes(MARK)) || (a.startsWith('aws_subnet.') && anyRef(files)) });
    const stages: Stage[] = [];
    const job = makeJob();
    await runPipeline(job, deps(tf.fn, fakeAi().fn, stages));
    expect(job.bundleLevel).toBe('named');
    expect(stages.filter(s => s === 'verify').length).toBe(3);
    expect(job.stats).toMatchObject({ passFinal: 14, failed: 0 });
  });
});

describe('unsafeConfigReason', () => {
  it('accepts our providers.tf and generated resources', () => {
    expect(unsafeConfigReason('providers.tf', PROVIDERS_TF)).toBeNull();
    expect(unsafeConfigReason('generated.tf', RAW)).toBeNull();
    expect(unsafeConfigReason('x.tf', 'resource "aws_s3_bucket" "b" {\n  tags = { Note = "provisioner module provider" }\n}\n')).toBeNull();
  });
  it('rejects provisioners, external/http data, modules, stray providers and other required_providers', () => {
    expect(unsafeConfigReason('a.tf', 'resource "aws_instance" "i" {\n  provisioner "local-exec" {\n    command = "id"\n  }\n}\n')).toBe('provisioner');
    expect(unsafeConfigReason('a.tf', 'data "external" "x" {\n  program = ["sh"]\n}\n')).toBe('data.external');
    expect(unsafeConfigReason('a.tf', 'data "http" "x" {\n  url = "http://169.254.169.254"\n}\n')).toBe('data.http');
    expect(unsafeConfigReason('a.tf', 'module "m" {\n  source = "./m"\n}\n')).toBe('module');
    expect(unsafeConfigReason('a.tf', 'provider "aws" {\n  region = "us-east-1"\n}\n')).toBe('provider');
    expect(unsafeConfigReason('providers.tf', PROVIDERS_TF + '\nprovider "null" {}\n')).toBe('provider');
    expect(unsafeConfigReason('a.tf', 'terraform {\n  backend "s3" {}\n}\n')).toBe('terraform');
    const extra = PROVIDERS_TF.replace('    aws = {', '    evil = {\n      source = "evil/evil"\n    }\n    aws = {');
    expect(unsafeConfigReason('providers.tf', extra)).toBe('required_providers');
    const swapped = PROVIDERS_TF.replace('"hashicorp/aws"', '"evil/aws"');
    expect(unsafeConfigReason('providers.tf', swapped)).toBe('required_providers');
  });
});

describe('startJob / recoverInterrupted', () => {
  const graph = async () => ({ nodes: [], edges: [], dropped: 0 });
  const select = async () => ({ items: ITEMS, excluded: [] });

  it('throws NotInstalled, NotFound and Empty', async () => {
    const tf = fakeTf();
    const base = { ...deps(tf.fn, fakeAi().fn), graph, select, installed: async () => true };
    const req = { accountId: '111122223333', seed: { kind: 'prefix' as const, prefix: 'demo' }, requestedBy: null };
    await expect(startJob(req, { ...base, installed: async () => false })).rejects.toThrow('NotInstalled');
    await expect(startJob(req, { ...base, account: () => null })).rejects.toThrow('NotFound');
    await expect(startJob(req, { ...base, graph: async () => null })).rejects.toThrow('NotFound');
    await expect(startJob(req, { ...base, select: async () => ({ items: [], excluded: [] }) })).rejects.toThrow('Empty');
    expect(tfExportState().running).toBeNull();
    expect(tf.calls).toEqual([]);
  });

  it('runs one job at a time (Busy) and frees the slot when done', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const base = fakeTf();
    const tf: TerraformFn = async (a, o) => { if (a[0] === 'init') await gate; return base.fn(a, o); };
    const d = { ...deps(tf, fakeAi().fn), graph, select, installed: async () => true };
    const req = { accountId: '111122223333', seed: { kind: 'prefix' as const, prefix: 'demo' }, requestedBy: 'a@b.c' };
    const { jobId } = await startJob(req, d);
    await expect(startJob(req, d)).rejects.toThrow('Busy');
    expect((await getJob(jobId))!.stage).toBe('prepare');
    release();
    for (let k = 0; k < 200 && tfExportState().running; k++) await new Promise(r => setTimeout(r, 10));
    expect(tfExportState().running).toBeNull();
    expect((await getJob(jobId))!.stage).toBe('done');
    expect((await listJobs()).map(j => j.id)).toEqual([jobId]);
  });

  it('sweeps raw files: failed folders emptied, done folders keep only the bundle (also at startJob)', async () => {
    const failed = makeJob({ stage: 'failed', error: 'Timeout' });
    const done = makeJob({ stage: 'done', files: ['main.tf'] });
    await saveJob(failed);
    await saveJob(done);
    for (const [j, names] of [[failed, ['plan.bin', 'secrets.auto.tfvars']], [done, ['main.tf', 'bundle.zip', 'plan.bin', 'generated.tf']]] as const) {
      fs.mkdirSync(jobDir(j.id), { recursive: true });
      for (const n of names) fs.writeFileSync(path.join(jobDir(j.id), n), SECRET);
    }
    await recoverInterrupted();
    expect(leftovers(failed.id)).toEqual([]);
    expect(leftovers(done.id).sort()).toEqual(['bundle.zip', 'main.tf']);
    // Cheap check at startJob, even when the start itself fails / 시작이 실패해도 startJob에서 한 번 검사
    fs.writeFileSync(path.join(jobDir(failed.id), 'generated.tf'), SECRET);
    await expect(startJob({ accountId: '111122223333', seed: { kind: 'prefix', prefix: 'x' }, requestedBy: null }, { ...deps(fakeTf().fn, fakeAi().fn), installed: async () => false })).rejects.toThrow('NotInstalled');
    expect(leftovers(failed.id)).toEqual([]);
  });

  it('marks jobs left unfinished by a restart as failed, once', async () => {
    const stuck = makeJob({ stage: 'diff' });
    const done = makeJob({ stage: 'done' });
    await saveJob(stuck);
    await saveJob(done);
    fs.mkdirSync(jobDir(stuck.id), { recursive: true });
    fs.writeFileSync(path.join(jobDir(stuck.id), 'secrets.auto.tfvars'), `x = "${SECRET}"`);
    expect(await recoverInterrupted()).toBe(1);
    expect(await recoverInterrupted()).toBe(0);
    const list = await readJobs();
    expect(list.find(j => j.id === stuck.id)).toMatchObject({ stage: 'failed', error: '서버 재시작' });
    expect(list.find(j => j.id === done.id)!.stage).toBe('done');
    expect(leftovers(stuck.id)).toEqual([]);
  });
});
