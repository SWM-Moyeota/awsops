import { describe, it, expect, vi, beforeEach } from 'vitest';

const ec2Calls = vi.hoisted(() => [] as Array<{ name: string; input: any; creds: unknown }>);
const ec2Reply = vi.hoisted(() => ({ value: {} as any }));
const stsCalls = vi.hoisted(() => [] as Array<{ name: string; input: any }>);

vi.mock('@aws-sdk/client-ec2', () => {
  class Cmd { constructor(public input: any) {} }
  const make = (name: string) => class extends Cmd { static cmdName = name; };
  return {
    EC2Client: class {
      creds: unknown;
      constructor(cfg: any) { this.creds = cfg.credentials; }
      async send(cmd: any) {
        ec2Calls.push({ name: cmd.constructor.cmdName, input: cmd.input, creds: this.creds });
        return ec2Reply.value;
      }
    },
    DescribeInstancesCommand: make('Describe'),
    StartInstancesCommand: make('Start'),
    StopInstancesCommand: make('Stop'),
    RebootInstancesCommand: make('Reboot'),
  };
});
vi.mock('@aws-sdk/client-sts', () => {
  class Cmd { constructor(public input: any) {} }
  return {
    STSClient: class {
      async send(cmd: any) {
        const name = cmd.constructor.name;
        stsCalls.push({ name, input: cmd.input });
        if (name === 'GetCallerIdentityCommand') return { Account: '116662357283' };
        return { Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' } };
      }
    },
    AssumeRoleCommand: class AssumeRoleCommand extends Cmd {},
    GetCallerIdentityCommand: class GetCallerIdentityCommand extends Cmd {},
  };
});

import { listControllableInstances, describeControllable, executeControl, sessionLabel } from '../ec2';

beforeEach(() => {
  ec2Calls.length = 0;
  stsCalls.length = 0;
});

const tagged = (id: string, name: string, state: string, allow = true) => ({
  InstanceId: id, State: { Name: state },
  Tags: [{ Key: 'Name', Value: name }, ...(allow ? [{ Key: 'awsops:control', Value: 'allow' }] : [])],
});

describe('listControllableInstances', () => {
  it('filtersByControlTagAndKeepsOnlyTaggedInstances', async () => {
    ec2Reply.value = { Reservations: [{ Instances: [tagged('i-1', 'a', 'running'), tagged('i-2', 'b', 'stopped', false)] }] };
    const list = await listControllableInstances();
    expect(list).toEqual([{ id: 'i-1', name: 'a', state: 'running' }]);
    expect(JSON.stringify(ec2Calls[0].input.Filters)).toContain('tag:awsops:control');
  });
});

describe('describeControllable', () => {
  it('returnsNullWhenTagWasRemoved', async () => {
    ec2Reply.value = { Reservations: [{ Instances: [tagged('i-2', 'b', 'running', false)] }] };
    expect(await describeControllable('i-2')).toBeNull();
  });
});

describe('executeControl', () => {
  it('assumesControlRoleWithApproverAsSourceIdentityThenStops', async () => {
    ec2Reply.value = { StoppingInstances: [{ PreviousState: { Name: 'running' }, CurrentState: { Name: 'stopping' } }] };
    const r = await executeControl('stop', 'i-1', 'UBOSS');
    expect(r).toEqual({ previous: 'running', current: 'stopping' });
    const assume = stsCalls.find(c => c.name === 'AssumeRoleCommand')!;
    expect(assume.input.RoleArn).toBe('arn:aws:iam::116662357283:role/AWSopsSlackControlRole');
    expect(assume.input.SourceIdentity).toBe('slack-UBOSS');
    const stop = ec2Calls.find(c => c.name === 'Stop')!;
    expect(stop.input).toEqual({ InstanceIds: ['i-1'] });
    expect(stop.creds).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' });
  });

  it('startsAndReboots', async () => {
    ec2Reply.value = { StartingInstances: [{ PreviousState: { Name: 'stopped' }, CurrentState: { Name: 'pending' } }] };
    expect(await executeControl('start', 'i-1', 'UBOSS')).toEqual({ previous: 'stopped', current: 'pending' });
    ec2Reply.value = {};
    expect(await executeControl('reboot', 'i-1', 'UBOSS')).toEqual({ previous: 'running', current: 'rebooting' });
    expect(ec2Calls.map(c => c.name)).toEqual(['Start', 'Reboot']);
  });
});

describe('sessionLabel', () => {
  it('keepsOnlyAllowedCharacters', () => {
    expect(sessionLabel('U0ABC<>!')).toBe('slack-U0ABC');
  });
});
