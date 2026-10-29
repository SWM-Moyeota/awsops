import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('@/lib/cloudtrail-access', () => ({
  freshCredentials: vi.fn(async (id: string) => (id === '222' ? { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' } : undefined)),
}));
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertAllowed, runTerraform, TF_BIN, PLUGIN_CACHE_DIR } from '../runner';

afterEach(() => vi.unstubAllEnvs());
const ok = { code: 0, stdout: '', stderr: '' };
describe('assertAllowed', () => {
  it.each([
    ['apply'], ['plan', '-target=x'], ['plan', '-out=../x'], ['import', 'a', 'b'], ['state', 'list'],
    ['plan', '-auto-approve'], ['destroy'], ['plan', '-out=a/b'], ['plan', '-out=A.bin'], ['show', '../x'], ['show', '..'],
    ['init', '-backend=true'], ['fmt', '-write=true'], ['workspace', 'new'], [], ['plan', 'apply'], ['constructor'], ['__proto__'], ['toString'], ['hasOwnProperty'], ['plan', 'constructor'],
  ])('rejects %j', (...a) => {
    expect(() => assertAllowed(a)).toThrow(expect.objectContaining({ name: 'ForbiddenCommand' }));
  });
  it.each([
    ['version', '-json'], ['init', '-input=false', '-no-color', '-backend=false'], ['fmt'], ['fmt', '-no-color'],
    ['validate', '-no-color', '-json'], ['show', '-json', '-no-color', 'plan.bin'],
    ['plan', '-input=false', '-no-color', '-out=plan.bin', '-generate-config-out=generated.tf', '-detailed-exitcode', '-refresh=true'],
  ])('allows %j', (...a) => { expect(() => assertAllowed(a)).not.toThrow(); });
});

describe('runTerraform', () => {
  const base = { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'tfr-')), hostAccountId: '111', region: 'ap-northeast-2' };
  it('does not call exec for forbidden argv', async () => {
    const exec = vi.fn();
    await expect(runTerraform(['apply'], { ...base, accountId: '111', exec })).rejects.toThrow('subcommand');
    expect(exec).not.toHaveBeenCalled();
  });
  it('host: inherited env, no injected creds, nice wrapper', async () => {
    const exec = vi.fn(async () => ok);
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'HOSTKEY');
    await runTerraform(['version'], { ...base, accountId: '111', exec });
    const [file, args, o] = exec.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number }];
    expect(file).toBe('nice'); expect(args).toEqual(['-n', '10', TF_BIN, 'version']);
    expect(o.env.AWS_ACCESS_KEY_ID).toBe('HOSTKEY');
    expect(o.env.TF_IN_AUTOMATION).toBe('1'); expect(o.env.TF_INPUT).toBe('0'); expect(o.env.CHECKPOINT_DISABLE).toBe('1');
    expect(o.maxBuffer).toBe(32 * 1024 * 1024); expect(o.timeout).toBe(600_000);
  });
  it('cross-account: fresh creds only in child env', async () => {
    const exec = vi.fn(async () => ok);
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'HOSTKEY');
    await runTerraform(['version'], { ...base, accountId: '222', exec });
    const o = (exec.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; timeout: number }])[2];
    expect(o.env.AWS_ACCESS_KEY_ID).toBe('AK'); expect(o.env.AWS_SECRET_ACCESS_KEY).toBe('SK'); expect(o.env.AWS_SESSION_TOKEN).toBe('ST');
    expect(o.timeout).toBe(720_000);
    expect(process.env.AWS_ACCESS_KEY_ID).toBe('HOSTKEY');
  });
  it('timeout gives code 124', async () => {
    const exec = vi.fn(async () => { throw Object.assign(new Error('x'), { killed: true }); });
    expect(await runTerraform(['version'], { ...base, accountId: '111', exec })).toEqual({ code: 124, stdout: '', stderr: 'timeout' });
    const exec2 = vi.fn(async () => ({ code: 124, stdout: 'o', stderr: 'zzz' }));
    expect((await runTerraform(['version'], { ...base, accountId: '111', exec: exec2 })).stderr).toBe('timeout');
  });
  it('drops inherited TF_* and sets region', async () => {
    vi.stubEnv('TF_CLI_ARGS_plan', '-target=x'); vi.stubEnv('TF_CLI_CONFIG_FILE', '/evil'); vi.stubEnv('tf_var_x', '1'); vi.stubEnv('TF_LOG', 'trace');
    const exec = vi.fn(async () => ok);
    await runTerraform(['version'], { ...base, accountId: '111', exec });
    const env = (exec.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(Object.keys(env).filter((k) => /^tf_/i.test(k)).sort()).toEqual(['TF_CLI_CONFIG_FILE', 'TF_IN_AUTOMATION', 'TF_INPUT', 'TF_PLUGIN_CACHE_DIR'].sort());
    expect(env.AWS_REGION).toBe('ap-northeast-2'); expect(env.AWS_DEFAULT_REGION).toBe('ap-northeast-2');
  });
  it('cross-account drops profile/config files', async () => {
    vi.stubEnv('AWS_PROFILE', 'p'); vi.stubEnv('AWS_CONFIG_FILE', '/c'); vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/s');
    const exec = vi.fn(async () => ok);
    await runTerraform(['version'], { ...base, accountId: '222', exec });
    const env = (exec.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(env.AWS_PROFILE).toBeUndefined(); expect(env.AWS_CONFIG_FILE).toBeUndefined(); expect(env.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined();
  });
  it('cross-account without credentials throws NoCredentials and never spawns', async () => {
    const exec = vi.fn(async () => ok);
    await expect(runTerraform(['version'], { ...base, accountId: '333', exec })).rejects.toMatchObject({ name: 'NoCredentials' });
    expect(exec).not.toHaveBeenCalled();
  });
  it('maxBuffer overflow is 125 not timeout', async () => {
    const exec = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }); });
    expect(await runTerraform(['version'], { ...base, accountId: '111', exec })).toEqual({ code: 125, stdout: '', stderr: 'output too large' });
  });
  it('pins CLI config inside cwd and HOME=cwd', async () => {
    const exec = vi.fn(async () => ok);
    await runTerraform(['version'], { ...base, accountId: '111', exec });
    const env = (exec.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(env.HOME).toBe(base.cwd); expect(env.TF_CLI_CONFIG_FILE).toBe(path.join(base.cwd, '.terraformrc-awsops'));
    expect(env.TF_PLUGIN_CACHE_DIR).toBe(PLUGIN_CACHE_DIR);
    const txt = fs.readFileSync(env.TF_CLI_CONFIG_FILE!, 'utf8');
    expect(txt).toContain('filesystem_mirror'); expect(txt).toContain('direct');
    expect(txt.match(/include = \["([^"]+)"\]/g)).toEqual(Array(2).fill('include = ["registry.terraform.io/hashicorp/aws"]'));
    await runTerraform(['version'], { ...base, accountId: '111', exec }); // second run keeps file / 재실행 시 파일 유지
    expect(fs.readFileSync(env.TF_CLI_CONFIG_FILE!, 'utf8')).toBe(txt);
  });
  it('drops endpoint and proxy overrides', async () => {
    for (const k of ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3', 'AWS_CA_BUNDLE', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY']) vi.stubEnv(k, 'x');
    const exec = vi.fn(async () => ok);
    await runTerraform(['version'], { ...base, accountId: '111', exec });
    const env = (exec.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(Object.keys(env).filter((k) => /^(aws_endpoint_url|aws_ca_bundle|https?_proxy|all_proxy)/i.test(k))).toEqual([]);
  });
});
