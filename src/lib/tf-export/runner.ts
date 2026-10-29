// Allowlisted Terraform executor: the safety boundary for tf-export / 허용 목록 기반 Terraform 실행기: tf-export의 안전 경계
import { execFile } from 'child_process';
import path from 'path';
import { freshCredentials } from '@/lib/cloudtrail-access';

export const TF_BIN = path.join(process.cwd(), '.tools/terraform');
export const PLUGIN_CACHE_DIR = path.join(process.cwd(), 'data/tf-export/plugin-cache');

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecFn = (file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<ExecResult>;

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
  if (!sub || !(sub in FLAGS)) forbidden('subcommand');
  for (const a of args) {
    if (FORBIDDEN.has(a) || a.startsWith('-target') || a.includes('/') || a.includes('\0')) forbidden('arg');
  }
  for (const a of rest) {
    if (FLAGS[sub].includes(a)) continue;
    if (sub === 'plan') {
      const m = /^(-out|-generate-config-out)=(.*)$/.exec(a);
      if (m && isFile(m[2])) continue;
    }
    if (sub === 'show' && isFile(a)) continue;
    forbidden('arg');
  }
}

const defaultExec: ExecFn = (file, args, o) => new Promise((resolve) => {
  execFile(file, args, { cwd: o.cwd, env: o.env, timeout: o.timeout, maxBuffer: o.maxBuffer }, (err, stdout, stderr) => {
    if (!err) return resolve({ code: 0, stdout, stderr });
    const e = err as NodeJS.ErrnoException & { killed?: boolean };
    if (e.killed) return resolve({ code: 124, stdout, stderr: 'timeout' });
    resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout, stderr });
  });
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
  opts: { cwd: string; accountId: string; hostAccountId: string; timeoutMs?: number; exec?: ExecFn },
): Promise<ExecResult> {
  assertAllowed(args);
  const cross = opts.accountId !== opts.hostAccountId;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1', TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE_DIR,
  };
  if (cross) {
    delete env.AWS_PROFILE;
    const c = await freshCredentials(opts.accountId, 'awsops-tf-export');
    if (c) {
      env.AWS_ACCESS_KEY_ID = c.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = c.secretAccessKey;
      if (c.sessionToken) env.AWS_SESSION_TOKEN = c.sessionToken; else delete env.AWS_SESSION_TOKEN;
    }
  }
  const timeout = opts.timeoutMs ?? (cross ? 12 : 10) * 60_000;
  try {
    const r = await (opts.exec ?? defaultExec)('nice', ['-n', '10', TF_BIN, ...args], { cwd: opts.cwd, env, timeout, maxBuffer: 32 * 1024 * 1024 });
    return r.code === 124 ? { ...r, stderr: 'timeout' } : r;
  } catch (err) {
    if ((err as { killed?: boolean }).killed) return { code: 124, stdout: '', stderr: 'timeout' };
    throw err;
  }
}
