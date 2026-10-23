import { describe, it, expect, vi, beforeEach } from 'vitest';

const stsSend = vi.fn();
const configMock = vi.fn(() => ({}) as Record<string, unknown>);

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = stsSend; },
  AssumeRoleCommand: class { constructor(public input: Record<string, unknown>) {} },
}));
vi.mock('@aws-sdk/client-lambda', () => ({ LambdaClient: class {}, InvokeCommand: class {} }));
vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({ BedrockAgentCoreControlClient: class {}, GetAgentRuntimeCommand: class {} }));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({ BedrockRuntimeClient: class {}, InvokeModelCommand: class {} }));
vi.mock('@/lib/app-config', () => ({ getConfig: () => configMock(), getBedrockModelId: () => 'm' }));
vi.mock('@/lib/steampipe', () => ({ pingSteampipe: vi.fn() }));

import { checkCrossAccount } from '../checks';

const host = { accountId: '116662357283', alias: 'Sandbox', isHost: true };
const moyeota = { accountId: '369558869056', alias: 'Moyeota', isHost: false };
const other = { accountId: '222222222222', alias: 'Staging', isHost: false };

beforeEach(() => { stsSend.mockReset(); configMock.mockReset(); });

describe('checkCrossAccount', () => {
  it('noTargetAccountsIsOk', async () => {
    configMock.mockReturnValue({ accounts: [host] });
    const r = await checkCrossAccount();
    expect(r).toMatchObject({ id: 'cross-account', ok: true });
    expect(stsSend).not.toHaveBeenCalled();
  });

  it('allTargetsAssumeOk', async () => {
    configMock.mockReturnValue({ accounts: [host, moyeota, other], crossAccountExternalId: 'ext-123' });
    stsSend.mockResolvedValue({ Credentials: {} });
    const r = await checkCrossAccount();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('2/2');
    expect(stsSend).toHaveBeenCalledTimes(2);
  });

  it('passesRoleArnAndExternalId', async () => {
    configMock.mockReturnValue({ accounts: [host, moyeota], crossAccountExternalId: 'ext-123' });
    stsSend.mockResolvedValue({ Credentials: {} });
    await checkCrossAccount();
    const input = stsSend.mock.calls[0][0].input;
    expect(input.RoleArn).toBe('arn:aws:iam::369558869056:role/AWSopsReadOnlyRole');
    expect(input.ExternalId).toBe('ext-123');
  });

  it('oneFailureNamesTheAccountAndErrorWithoutDetails', async () => {
    configMock.mockReturnValue({ accounts: [host, moyeota, other], crossAccountExternalId: 'ext-123' });
    stsSend.mockImplementation(async (cmd: { input: { RoleArn: string } }) => {
      if (cmd.input.RoleArn.includes('369558869056')) {
        const e = new Error('User: arn:aws:sts::116662357283:assumed-role/x is not authorized ... ext-123');
        e.name = 'AccessDenied';
        throw e;
      }
      return { Credentials: {} };
    });
    const r = await checkCrossAccount();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Moyeota (369558869056)');
    expect(r.message).toContain('AccessDenied');
    expect(r.message).not.toContain('ext-123');
    expect(r.message).not.toContain('Staging');
  });

  it('callIsBoundedAndTimeoutCountsAsFailure', async () => {
    configMock.mockReturnValue({ accounts: [host, moyeota] });
    let signal: unknown;
    stsSend.mockImplementation((_c: unknown, opts: { abortSignal?: AbortSignal }) => {
      signal = opts?.abortSignal;
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      return Promise.reject(e);
    });
    const r = await checkCrossAccount();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Moyeota (369558869056): TimeoutError');
  });
});
