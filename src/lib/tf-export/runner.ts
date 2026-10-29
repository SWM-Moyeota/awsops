// Allowlisted Terraform executor: the safety boundary for tf-export / 허용 목록 기반 Terraform 실행기: tf-export의 안전 경계
import { spawn } from 'child_process';
import path from 'path';
import { writeFile } from 'fs/promises';
import { freshCredentials } from '@/lib/cloudtrail-access';

export const TF_BIN = path.join(process.cwd(), '.tools/terraform');
export const PLUGIN_CACHE_DIR = path.join(process.cwd(), 'data/tf-export/plugin-cache');

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecFn = (file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; signal?: AbortSignal }) => Promise<ExecResult>;
// Exit code reported for an aborted command / 중단된 명령의 종료 코드
export const ABORTED_CODE = 137;

const FORBIDDEN = new Set(['apply', 'import', 'state', 'destroy', '-auto-approve', 'console', 'taint', 'untaint', 'force-unlock', 'workspace']);
const FILE = /^[a-z0-9._-]+$/;
const isFile = (v: string) => FILE.test(v) && !/^\.+$/.test(v) && !v.startsWith('-');

// Exact flags allowed per subcommand / 하위 명령별 허용 플래그
const FLAGS: Record<string, string[]> = {
  version: ['-json'],
  init: ['-input=false', '-no-color', '-backend=false'],
  plan: ['-input=false', '-no-color', '-detailed-exitcode', '-refresh=true'],
  show: ['-json', '-no-color'],
  validate: ['-no-color', '-json'],
  fmt: ['-no-color'],
};

function forbidden(msg: string): never {
  const e = new Error(msg);
  e.name = 'ForbiddenCommand';
  throw e;
}

/** Throw ForbiddenCommand unless argv is explicitly allowed. / 명시 허용된 argv가 아니면 ForbiddenCommand 발생. */
export function assertAllowed(args: string[]): void {
  const [sub, ...rest] = args;
  if (!sub || !Object.hasOwn(FLAGS, sub)) forbidden('subcommand'); // own keys only / 자체 키만
  for (const a of args) {
    if (FORBIDDEN.has(a) || a.startsWith('-target') || a.includes('/') || a.includes('\0')) forbidden('arg');
  }
  for (const a of rest) {
    if (Object.hasOwn(FLAGS, sub) && FLAGS[sub].includes(a)) continue;
    if (sub === 'plan') {
      const m = /^(-out|-generate-config-out)=(.*)$/.exec(a);
      if (m && isFile(m[2])) continue;
    }
    if (sub === 'show' && isFile(a)) continue;
    forbidden('arg');
  }
}

function named(name: string): Error { const e = new Error(name); e.name = name; return e; }

/** spawn wrapper in its own process group: abort/timeout SIGKILL the whole group (provider plugins too) and resolve only after exit. / 별도 프로세스 그룹으로 실행: 중단·시간 초과 때 그룹 전체(프로바이더 플러그인 포함)를 SIGKILL하고 끝난 뒤에만 돌려준다. */
export const defaultExec: ExecFn = (file, args, o) => new Promise((resolve, reject) => {
  if (o.signal?.aborted) return resolve({ code: ABORTED_CODE, stdout: '', stderr: 'aborted' });
  const child = spawn(file, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let size = 0;
  let why: 'abort' | 'timeout' | 'overflow' | null = null;
  let settled = false;
  // Kill the group, falling back to the child alone / 그룹을 죽이고, 안 되면 자식만
  const killGroup = () => {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* already gone / 이미 끝남 */ } }
  };
  const stop = (w: 'abort' | 'timeout' | 'overflow') => { why ??= w; killGroup(); };
  const onAbort = () => stop('abort');
  o.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('timeout'), o.timeout);
  const take = (into: Buffer[]) => (d: Buffer) => {
    if (why) return;
    size += d.length;
    if (size > o.maxBuffer) return stop('overflow');
    into.push(d);
  };
  child.stdout!.on('data', take(out));
  child.stderr!.on('data', take(err));
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
    fn();
  };
  child.once('error', (e: NodeJS.ErrnoException) => settle(() => {
    killGroup();
    reject(e.code === 'ENOENT' ? named('NotInstalled') : e);
  }));
  // Leftover group members (orphaned plugins) are killed so the pipes close / 남은 그룹 구성원(고아 플러그인)도 죽여 파이프가 닫히게 함
  child.once('exit', () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group empty / 그룹 비었음 */ } } });
  // 'close' fires after the child exited and its pipes closed / 'close'는 자식이 끝나고 파이프가 닫힌 뒤에 온다
  child.once('close', (code) => settle(() => {
    const stdout = Buffer.concat(out).toString('utf8');
    const stderr = Buffer.concat(err).toString('utf8');
    if (why === 'abort') return resolve({ code: ABORTED_CODE, stdout, stderr: 'aborted' });
    if (why === 'timeout') return resolve({ code: 124, stdout, stderr: 'timeout' });
    if (why === 'overflow') return resolve({ code: 125, stdout, stderr: 'output too large' });
    resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
  }));
});

export async function isInstalled(exec: ExecFn = defaultExec): Promise<{ installed: boolean; version?: string }> {
  try {
    const r = await exec(TF_BIN, ['version', '-json'], { cwd: process.cwd(), env: process.env, timeout: 10_000, maxBuffer: 1 << 20 });
    if (r.code !== 0) return { installed: false };
    return { installed: true, version: String(JSON.parse(r.stdout).terraform_version ?? '') || undefined };
  } catch {
    return { installed: false };
  }
}

export async function runTerraform(
  args: string[],
  opts: { cwd: string; accountId: string; hostAccountId: string; region: string; timeoutMs?: number; exec?: ExecFn; signal?: AbortSignal },
): Promise<ExecResult> {
  assertAllowed(args);
  const cross = opts.accountId !== opts.hostAccountId;
  // Drop every inherited TF_* var so env cannot bypass the argv allowlist / 상속된 TF_* 환경변수를 모두 제거해 허용 목록 우회를 막는다
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith('TF_')) env[k] = v;
  // No TF_PLUGIN_CACHE_DIR: the cache folder is the filesystem mirror, and Terraform forbids both being the same / TF_PLUGIN_CACHE_DIR 없음: 캐시 폴더가 곧 미러이고 둘이 같으면 Terraform이 거부한다
  Object.assign(env, { TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1', AWS_REGION: opts.region, AWS_DEFAULT_REGION: opts.region });
  // Credentials come from IMDS (host) or AssumeRole (cross), never a profile file / 자격 증명은 IMDS(호스트) 또는 AssumeRole(교차)에서만, 프로필 파일은 안 씀
  delete env.AWS_PROFILE; delete env.AWS_CONFIG_FILE; delete env.AWS_SHARED_CREDENTIALS_FILE;
  if (cross) {
    // Fail closed: never fall back to host credentials / 호스트 자격증명으로 대체하지 않고 실패
    const c = await freshCredentials(opts.accountId, 'awsops-tf-export');
    if (!c) { const e = new Error('NoCredentials'); e.name = 'NoCredentials'; throw e; }
    env.AWS_ACCESS_KEY_ID = c.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = c.secretAccessKey;
    if (c.sessionToken) env.AWS_SESSION_TOKEN = c.sessionToken; else delete env.AWS_SESSION_TOKEN;
  }
  // Scrub endpoint/proxy overrides / 엔드포인트·프록시 재정의 제거
  for (const k of Object.keys(env)) if (/^AWS_ENDPOINT_URL/i.test(k) || /^(AWS_CA_BUNDLE|HTTPS?_PROXY|ALL_PROXY)$/i.test(k)) delete env[k];
  // Install hashicorp/aws only from the pre-warmed local mirror (no registry, no download) and isolate HOME / 미리 받아 둔 로컬 미러에서만 hashicorp/aws 설치(레지스트리·다운로드 없음), HOME 격리
  const rc = path.join(opts.cwd, '.terraformrc-awsops');
  const body = `provider_installation {\n  filesystem_mirror {\n    path    = "${PLUGIN_CACHE_DIR}"\n    include = ["registry.terraform.io/hashicorp/aws"]\n  }\n}\n`;
  try { await writeFile(rc, body, { flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  env.TF_CLI_CONFIG_FILE = rc;
  env.HOME = opts.cwd;
  const timeout = opts.timeoutMs ?? (cross ? 12 : 10) * 60_000;
  try {
    const r = await (opts.exec ?? defaultExec)('nice', ['-n', '10', TF_BIN, ...args], { cwd: opts.cwd, env, timeout, maxBuffer: 32 * 1024 * 1024, signal: opts.signal });
    // nice exits 127 when it cannot find the terraform binary / nice는 terraform 바이너리를 못 찾으면 127로 끝난다
    if (r.code === 127) throw named('NotInstalled');
    return r.code === 124 ? { ...r, stderr: 'timeout' } : r;
  } catch (err) {
    if ((err as { name?: unknown }).name === 'NotInstalled' || String((err as { code?: unknown }).code) === 'ENOENT') throw named('NotInstalled');
    if (String((err as { code?: unknown }).code) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { code: 125, stdout: '', stderr: 'output too large' };
    if ((err as { killed?: boolean }).killed) return { code: 124, stdout: '', stderr: 'timeout' };
    throw err;
  }
}
