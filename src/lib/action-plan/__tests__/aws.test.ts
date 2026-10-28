import { describe, it, expect } from 'vitest';
import { createEc2Reader, createWriter, createWriterFactory } from '../aws';
import { computeChanges } from '../changes';
import type { ResolvedStep } from '../types';

const step = (o: Partial<ResolvedStep>): ResolvedStep =>
  ({ action: 'ec2.stop', target: { type: 'instance', id: 'i-1', name: 'a' }, ...o });

describe('writer', () => {
  it('writerTreatsDryRunOperationAsSuccess', async () => {
    const w = createWriter(async () => { throw Object.assign(new Error('x'), { name: 'DryRunOperation' }); });
    await expect(w.run(step({}), true)).resolves.toEqual({});
    // not swallowed on a real run, nor for other errors
    await expect(w.run(step({}), false)).rejects.toThrow();
    const u = createWriter(async () => { throw Object.assign(new Error('x'), { name: 'UnauthorizedOperation' }); });
    await expect(u.run(step({}), true)).rejects.toMatchObject({ name: 'UnauthorizedOperation' });
  });

  it('authorizeReturnsRuleIdAndRevokeUsesIt', async () => {
    const seen: any[] = [];
    const w = createWriter(async c => {
      seen.push(c);
      return { $metadata: { requestId: 'req-1' }, SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-9' }, { SecurityGroupRuleId: 'sgr-8' }] };
    });
    const sg = { type: 'security-group' as const, id: 'sg-1', name: 'g' };
    const add = await w.run(step({ action: 'sg.ingress.add', target: sg, rule: { protocol: 'tcp', fromPort: 80, toPort: 80, source: '10.0.0.0/8' } }), false);
    expect(add).toEqual({ requestId: 'req-1', ruleId: 'sgr-9' });
    expect(seen[0].input).toMatchObject({ GroupId: 'sg-1', DryRun: false, IpPermissions: [{ IpRanges: [{ CidrIp: '10.0.0.0/8' }] }] });
    await w.run(step({ action: 'sg.ingress.remove', target: sg, ruleId: 'sgr-9' }), false);
    expect(seen[1].input).toMatchObject({ GroupId: 'sg-1', SecurityGroupRuleIds: ['sgr-9'], DryRun: false });
  });
});

describe('writer factory', () => {
  it('assumeRolePassesSessionPolicySourceIdentityAnd900s', async () => {
    const calls: any[] = [];
    let creds: any;
    const stsSend = async (c: any) => {
      calls.push(c);
      if (c.constructor.name === 'GetCallerIdentityCommand') return { Account: '123456789012' };
      return { Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' } };
    };
    const policy = { Version: '2012-10-17', Statement: [] };
    const make = createWriterFactory({ stsSend, ec2SendFor: c => { creds = c; return async () => ({}); } });
    await make('slack-U1', policy);
    const assume = calls.find(c => c.constructor.name === 'AssumeRoleCommand').input;
    expect(assume).toMatchObject({
      RoleArn: 'arn:aws:iam::123456789012:role/AWSopsActionExecutorRole',
      RoleSessionName: 'slack-U1', SourceIdentity: 'slack-U1', DurationSeconds: 900, Policy: JSON.stringify(policy),
    });
    expect(creds).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' });
  });
});

describe('reader', () => {
  const inst = (id: string, state: string, tagged: boolean, name = '') => ({
    InstanceId: id, State: { Name: state }, SecurityGroups: [{ GroupId: 'sg-1' }],
    Tags: [...(tagged ? [{ Key: 'awsops:control', Value: 'allow' }] : []), { Key: 'Name', Value: name }],
  });

  it('readerKeepsOnlyTaggedNonTerminatedInstances', async () => {
    const r = createEc2Reader(async () => ({ Reservations: [{ Instances: [
      inst('i-ok', 'running', true, 'web*`x'), inst('i-untagged', 'running', false),
      inst('i-dead', 'terminated', true), inst('i-dying', 'shutting-down', true),
    ] }] }));
    const list = await r.listTaggedInstances();
    expect(list.map(x => x.id)).toEqual(['i-ok']);
    expect(list[0]).toMatchObject({ name: 'webx', state: 'running', securityGroupIds: ['sg-1'] });
  });

  it('keeps ingress rules only, passes other protocols through, and counts ENIs', async () => {
    const r = createEc2Reader(async c => {
      const n = c.constructor.name;
      if (n === 'DescribeSecurityGroupRulesCommand') return { SecurityGroupRules: [
        { SecurityGroupRuleId: 'sgr-1', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: '1.2.3.4/32' },
        { SecurityGroupRuleId: 'sgr-2', IsEgress: true, IpProtocol: '-1' },
        { SecurityGroupRuleId: 'sgr-3', IsEgress: false, IpProtocol: 'icmp', FromPort: -1, ToPort: -1, ReferencedGroupInfo: { GroupId: 'sg-2' } },
      ] };
      if (n === 'DescribeNetworkInterfacesCommand') return { NetworkInterfaces: [{ Attachment: { InstanceId: 'i-1' } }, {}] };
      return { Reservations: [{ Instances: [inst('i-1', 'running', true, 'web')] }] };
    });
    expect((await r.listIngressRules('sg-1')).map(x => [x.ruleId, x.protocol, x.source])).toEqual([
      ['sgr-1', 'tcp', '1.2.3.4/32'], ['sgr-3', 'icmp', 'sg-2'],
    ]);
    expect(await r.listEniUsers('sg-1')).toEqual({ eniCount: 2, instances: [{ id: 'i-1', name: 'web' }] });
  });

  it('undoReAddsTheRuleWithTheRawDescription', async () => {
    const desc = ('team_*a*_~b|c&d ' + 'x'.repeat(200)).slice(0, 200);
    const r = createEc2Reader(async () => ({ SecurityGroupRules: [
      { SecurityGroupRuleId: 'sgr-1', IsEgress: false, IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIpv4: '10.0.0.0/8', Description: desc },
    ] }));
    const ingress = await r.listIngressRules('sg-1');
    expect(ingress[0].description).toBe(desc);

    const G = { type: 'security-group' as const, id: 'sg-1', name: 'web-sg' };
    const { changes } = computeChanges(
      [{ action: 'sg.ingress.remove', target: G, rule: { protocol: 'tcp', fromPort: 22, toPort: 22, source: '10.0.0.0/8' } }],
      { 'sg-1': { type: 'security-group', id: 'sg-1', name: 'web-sg', tags: {}, eniCount: 1, ingress } },
    );
    expect(changes[0].inverse?.rule?.description).toBe(desc);

    const sent: any[] = [];
    await createWriter(async c => { sent.push(c.input); return { SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-2' }] }; })
      .run(changes[0].inverse!, false);
    expect(sent[0].IpPermissions[0].IpRanges[0]).toEqual({ CidrIp: '10.0.0.0/8', Description: desc });
  });
});
