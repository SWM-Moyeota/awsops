import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/cloudtrail-access', () => ({
  freshCredentials: vi.fn(async (id: string) => (id === '222' ? { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' } : undefined)),
}));
import { assertAllowed, runTerraform, TF_BIN } from '../runner';

const ok = { code: 0, stdout: '', stderr: '' };
describe('assertAllowed', () => {
  it.each([
    ['apply'], ['plan', '-target=x'], ['plan', '-out=../x'], ['import', 'a', 'b'], ['state', 'list'],
    ['plan', '-auto-approve'], ['destroy'], ['plan', '-out=a/b'], ['plan', '-out=A.bin'], ['show', '../x'], ['show', '..'],
    ['init', '-backend=true'], ['fmt', '-write=true'], ['workspace', 'new'], [], ['plan', 'apply'],
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
  const base = { cwd: '/tmp/j', hostAccountId: '111' };
  it('does not call exec for forbidden argv', async () => {
    const exec = vi.fn();
    await expect(runTerraform(['apply'], { ...base, accountId: '111', exec })).rejects.toThrow('subcommand');
    expect(exec).not.toHaveBeenCalled();
  });
  it('host: inherited env, no injected creds, nice wrapper', async () => {
    const exec = vi.fn(async () => ok);
    process.env.AWS_ACCESS_KEY_ID = 'HOSTKEY';
    await runTerraform(['version'], { ...base, accountId: '111', exec });
    const [file, args, o] = exec.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number }];
    expect(file).toBe('nice'); expect(args).toEqual(['-n', '10', TF_BIN, 'version']);
    expect(o.env.AWS_ACCESS_KEY_ID).toBe('HOSTKEY');
    expect(o.env.TF_IN_AUTOMATION).toBe('1'); expect(o.env.TF_INPUT).toBe('0'); expect(o.env.CHECKPOINT_DISABLE).toBe('1');
    expect(o.maxBuffer).toBe(32 * 1024 * 1024); expect(o.timeout).toBe(600_000);
    delete process.env.AWS_ACCESS_KEY_ID;
  });
  it('cross-account: fresh creds only in child env', async () => {
    const exec = vi.fn(async () => ok);
    process.env.AWS_ACCESS_KEY_ID = 'HOSTKEY';
    await runTerraform(['version'], { ...base, accountId: '222', exec });
    const o = (exec.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; timeout: number }])[2];
    expect(o.env.AWS_ACCESS_KEY_ID).toBe('AK'); expect(o.env.AWS_SECRET_ACCESS_KEY).toBe('SK'); expect(o.env.AWS_SESSION_TOKEN).toBe('ST');
    expect(o.timeout).toBe(720_000);
    expect(process.env.AWS_ACCESS_KEY_ID).toBe('HOSTKEY');
    delete process.env.AWS_ACCESS_KEY_ID;
  });
  it('timeout gives code 124', async () => {
    const exec = vi.fn(async () => { throw Object.assign(new Error('x'), { killed: true }); });
    expect(await runTerraform(['version'], { ...base, accountId: '111', exec })).toEqual({ code: 124, stdout: '', stderr: 'timeout' });
    const exec2 = vi.fn(async () => ({ code: 124, stdout: 'o', stderr: 'zzz' }));
    expect((await runTerraform(['version'], { ...base, accountId: '111', exec: exec2 })).stderr).toBe('timeout');
  });
});
