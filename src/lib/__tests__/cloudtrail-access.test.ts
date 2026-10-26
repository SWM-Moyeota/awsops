import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const stsSend = vi.fn();
const stsCtor = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { constructor(o: unknown) { stsCtor(o); } send = stsSend; },
  AssumeRoleCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@/lib/app-config', () => ({
  getConfig: () => ({
    crossAccountExternalId: 'ext-1',
    accounts: [
      { accountId: '111111111111', isHost: true },
      { accountId: '222222222222', isHost: false },
    ],
  }),
}));

import { cloudTrailSlot, accountCredentials, resetCloudTrailAccess } from '../cloudtrail-access';

beforeEach(() => { stsSend.mockReset(); stsCtor.mockReset(); resetCloudTrailAccess(); });
afterEach(() => { vi.useRealTimers(); });

describe('cloudtrail-access', () => {
  it('slotsSpaceCallsPerAccountRegion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const times: number[] = [];
    const t0 = Date.now();
    const a = cloudTrailSlot('1', 'ap-northeast-2').then(() => times.push(Date.now() - t0));
    const b = cloudTrailSlot('1', 'ap-northeast-2').then(() => times.push(Date.now() - t0));
    const c = cloudTrailSlot('2', 'ap-northeast-2').then(() => times.push(Date.now() - t0));
    const d = cloudTrailSlot('1', 'us-east-1').then(() => times.push(Date.now() - t0));
    await vi.advanceTimersByTimeAsync(0);
    expect(times).toEqual([0, 0, 0]); // a, c, d immediate; b waits
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([a, b, c, d]);
    expect(times).toHaveLength(4);
    expect(times[3]).toBeGreaterThanOrEqual(1000);
  });

  it('hostAccountUsesDefaultChain', async () => {
    expect(await accountCredentials('111111111111', 's')).toBeUndefined();
    expect(await accountCredentials('999999999999', 's')).toBeUndefined();
    expect(stsSend).not.toHaveBeenCalled();
  });

  it('crossAccountAssumesReadOnlyRoleWithExternalId', async () => {
    stsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 900_000) } });
    const c1 = await accountCredentials('222222222222', 'awsops-x');
    expect(c1).toEqual({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' });
    const input = (stsSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.RoleArn).toBe('arn:aws:iam::222222222222:role/AWSopsReadOnlyRole');
    expect(input.ExternalId).toBe('ext-1');
    expect(input.RoleSessionName).toBe('awsops-x');
    expect(input.DurationSeconds).toBe(900);
    await accountCredentials('222222222222', 'awsops-x');
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('cachesCredentialsPerSessionName', async () => {
    stsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', Expiration: new Date(Date.now() + 900_000) } });
    await accountCredentials('222222222222', 'one');
    await accountCredentials('222222222222', 'two');
    expect(stsSend).toHaveBeenCalledTimes(2);
    await accountCredentials('222222222222', 'one');
    expect(stsSend).toHaveBeenCalledTimes(2);
  });
});
