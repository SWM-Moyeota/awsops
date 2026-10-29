import { describe, it, expect, vi, beforeEach } from 'vitest';
const stsSend = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = stsSend; },
  AssumeRoleCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@/lib/app-config', () => ({
  getConfig: () => ({ crossAccountExternalId: 'ext-1', accounts: [{ accountId: '111', isHost: true }, { accountId: '222', isHost: false }] }),
}));
import { freshCredentials, resetCloudTrailAccess } from '../cloudtrail-access';

beforeEach(() => { stsSend.mockReset(); resetCloudTrailAccess(); });
const resp = { Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 3600_000) } };

describe('freshCredentials', () => {
  it('host/unknown -> undefined without STS', async () => {
    expect(await freshCredentials('111', 'x')).toBeUndefined();
    expect(await freshCredentials('999', 'x')).toBeUndefined();
    expect(stsSend).not.toHaveBeenCalled();
  });
  it('never cached, passes ExternalId, 900s and abortSignal', async () => {
    stsSend.mockResolvedValue(resp);
    await freshCredentials('222', 'x');
    const c = await freshCredentials('222', 'x');
    expect(stsSend).toHaveBeenCalledTimes(2);
    expect(c).toEqual({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' });
    const [cmd, opts] = stsSend.mock.calls[0];
    expect(cmd.input).toMatchObject({ DurationSeconds: 900, ExternalId: 'ext-1' });
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
