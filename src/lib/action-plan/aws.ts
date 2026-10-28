// Real AWS side of safe AI actions: EC2 reads (dashboard role) and an STS-assumed, session-policy-scoped writer.
// Tests inject `send` / client factories, so nothing here needs the network to be verified.
// 실제 AWS 연동: 조회는 대시보드 역할, 쓰기는 세션 정책으로 좁힌 AWSopsActionExecutorRole.
import {
  EC2Client, DescribeInstancesCommand, DescribeSecurityGroupsCommand, DescribeSecurityGroupRulesCommand,
  DescribeNetworkInterfacesCommand, StartInstancesCommand, StopInstancesCommand, CreateTagsCommand, DeleteTagsCommand,
  AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand,
  type Instance, type SecurityGroup, type Tag,
} from '@aws-sdk/client-ec2';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CONTROL_TAG_KEY, CONTROL_TAG_VALUE, safeName } from '@/lib/slack-control/ec2';
import type { Ec2Reader, Ec2Writer, IngressRule, Resource, ResolvedStep, SnapshotRule, WriterFactory } from './types';

export const EXECUTOR_ROLE_NAME = 'AWSopsActionExecutorRole';
const REGION = 'ap-northeast-2';
const TIMEOUT_MS = 15_000;

/** Sends one SDK command. Injected in tests; the default adds a 15 s abort. */
export type Send = (command: any) => Promise<any>;

const clientSend = (client: { send: (c: any, o?: any) => Promise<any> }): Send =>
  command => client.send(command, { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });

const toTags = (tags?: Tag[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const t of tags ?? []) if (t.Key) out[t.Key] = t.Value ?? '';
  return out;
};
const isAllowed = (tags: Record<string, string>) => tags[CONTROL_TAG_KEY] === CONTROL_TAG_VALUE;
const notFound = (e: unknown) => /NotFound/.test((e as { name?: string; Code?: string })?.name ?? (e as { Code?: string })?.Code ?? '');

function toInstance(i: Instance): Resource | null {
  const state = i.State?.Name ?? 'unknown';
  if (!i.InstanceId || state === 'terminated' || state === 'shutting-down') return null;
  const tags = toTags(i.Tags);
  if (!isAllowed(tags)) return null;
  return {
    type: 'instance', id: i.InstanceId, name: safeName(tags.Name ?? ''), tags, state,
    securityGroupIds: (i.SecurityGroups ?? []).map(g => g.GroupId).filter((x): x is string => !!x),
  };
}

function toGroup(g: SecurityGroup): Resource | null {
  if (!g.GroupId) return null;
  const tags = toTags(g.Tags);
  if (!isAllowed(tags)) return null;
  return { type: 'security-group', id: g.GroupId, name: safeName(tags.Name ?? g.GroupName ?? ''), groupName: safeName(g.GroupName ?? ''), tags };
}

export function createEc2Reader(send: Send = clientSend(new EC2Client({ region: REGION }))): Ec2Reader {
  async function instances(input: Record<string, unknown>): Promise<Resource[]> {
    const out: Resource[] = [];
    let token: string | undefined;
    do {
      const r = await send(new DescribeInstancesCommand({ ...input, NextToken: token }));
      for (const res of r.Reservations ?? []) for (const i of res.Instances ?? []) { const x = toInstance(i); if (x) out.push(x); }
      token = r.NextToken;
    } while (token);
    return out;
  }
  async function groups(input: Record<string, unknown>): Promise<Resource[]> {
    const out: Resource[] = [];
    let token: string | undefined;
    do {
      const r = await send(new DescribeSecurityGroupsCommand({ ...input, NextToken: token }));
      for (const g of r.SecurityGroups ?? []) { const x = toGroup(g); if (x) out.push(x); }
      token = r.NextToken;
    } while (token);
    return out;
  }
  const tagFilter = { Name: `tag:${CONTROL_TAG_KEY}`, Values: [CONTROL_TAG_VALUE] };

  return {
    listTaggedInstances: () => instances({
      Filters: [tagFilter, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }],
    }),
    listTaggedSecurityGroups: () => groups({ Filters: [tagFilter] }),
    async describeInstance(id) {
      try { return (await instances({ InstanceIds: [id] }))[0] ?? null; } catch (e) { if (notFound(e)) return null; throw e; }
    },
    async describeSecurityGroup(id) {
      try { return (await groups({ GroupIds: [id] }))[0] ?? null; } catch (e) { if (notFound(e)) return null; throw e; }
    },
    async listIngressRules(sgId) {
      const out: SnapshotRule[] = [];
      let token: string | undefined;
      do {
        const r = await send(new DescribeSecurityGroupRulesCommand({ Filters: [{ Name: 'group-id', Values: [sgId] }], NextToken: token }));
        for (const x of r.SecurityGroupRules ?? []) {
          if (x.IsEgress || !x.SecurityGroupRuleId) continue; // ingress only
          // Non tcp/udp rules (icmp, -1, prefix lists) are kept with protocol as-is so existence checks still work;
          // SnapshotRule.protocol is typed 'tcp'|'udp', so widen it locally with a cast.
          out.push({
            ruleId: x.SecurityGroupRuleId,
            protocol: (x.IpProtocol ?? '') as IngressRule['protocol'],
            fromPort: x.FromPort ?? -1,
            toPort: x.ToPort ?? -1,
            source: x.CidrIpv4 ?? x.CidrIpv6 ?? x.ReferencedGroupInfo?.GroupId ?? x.PrefixListId ?? '',
            // Raw, not safeName'd: undo re-adds the rule with exactly this description (spec §3.11).
            // Cards sanitize at display time. 되돌리기에서 원래 설명 그대로 다시 넣으므로 원문을 보관한다.
            description: x.Description ? x.Description : undefined,
          });
        }
        token = r.NextToken;
      } while (token);
      return out;
    },
    async listEniUsers(sgId) {
      let eniCount = 0;
      const ids = new Set<string>();
      let token: string | undefined;
      do {
        const r = await send(new DescribeNetworkInterfacesCommand({ Filters: [{ Name: 'group-id', Values: [sgId] }], NextToken: token }));
        for (const n of r.NetworkInterfaces ?? []) {
          eniCount++;
          if (n.Attachment?.InstanceId) ids.add(n.Attachment.InstanceId);
        }
        token = r.NextToken;
      } while (token);
      const names: Record<string, string> = {};
      if (ids.size) {
        const r = await send(new DescribeInstancesCommand({ InstanceIds: Array.from(ids) }));
        for (const res of r.Reservations ?? []) for (const i of res.Instances ?? []) {
          if (i.InstanceId) names[i.InstanceId] = safeName(toTags(i.Tags).Name ?? '');
        }
      }
      return { eniCount, instances: Array.from(ids).map(id => ({ id, name: names[id] || id })) };
    },
  };
}

function permissionOf(rule: IngressRule) {
  const base = { IpProtocol: rule.protocol, FromPort: rule.fromPort, ToPort: rule.toPort };
  const d = rule.description ? { Description: rule.description } : {};
  if (rule.source.startsWith('sg-')) return { ...base, UserIdGroupPairs: [{ GroupId: rule.source, ...d }] };
  if (rule.source.includes(':')) return { ...base, Ipv6Ranges: [{ CidrIpv6: rule.source, ...d }] };
  return { ...base, IpRanges: [{ CidrIp: rule.source, ...d }] };
}

function commandFor(step: ResolvedStep, dryRun: boolean): any {
  const DryRun = dryRun;
  const id = step.target.id;
  switch (step.action) {
    case 'ec2.start': return new StartInstancesCommand({ InstanceIds: [id], DryRun });
    case 'ec2.stop': return new StopInstancesCommand({ InstanceIds: [id], DryRun });
    case 'tag.set': return new CreateTagsCommand({ Resources: [id], Tags: [{ Key: step.key, Value: step.value ?? '' }], DryRun });
    case 'tag.remove': return new DeleteTagsCommand({ Resources: [id], Tags: [{ Key: step.key }], DryRun });
    case 'sg.ingress.add':
      if (!step.rule) throw new Error('MissingRule');
      return new AuthorizeSecurityGroupIngressCommand({ GroupId: id, IpPermissions: [permissionOf(step.rule)], DryRun });
    case 'sg.ingress.remove':
      if (!step.ruleId) throw new Error('MissingRuleId');
      return new RevokeSecurityGroupIngressCommand({ GroupId: id, SecurityGroupRuleIds: [step.ruleId], DryRun });
  }
}

export function createWriter(send: Send): Ec2Writer {
  return {
    async run(step, dryRun) {
      try {
        const r = await send(commandFor(step, dryRun));
        return {
          requestId: r?.$metadata?.requestId,
          ruleId: step.action === 'sg.ingress.add' ? r?.SecurityGroupRules?.[0]?.SecurityGroupRuleId : undefined,
        };
      } catch (e) {
        if (dryRun && ((e as { name?: string }).name === 'DryRunOperation' || (e as { Code?: string }).Code === 'DryRunOperation')) return {};
        throw e;
      }
    },
  };
}

export interface WriterDeps {
  stsSend?: Send;
  /** Builds the send function for the assumed credentials. */
  ec2SendFor?: (creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }) => Send;
}

let cachedAccountId: string | null = null;

export function createWriterFactory(deps: WriterDeps = {}): WriterFactory {
  const stsSend = deps.stsSend ?? clientSend(new STSClient({ region: REGION }));
  const ec2SendFor = deps.ec2SendFor ?? (creds => clientSend(new EC2Client({ region: REGION, credentials: creds })));
  return async (label, sessionPolicy) => {
    if (!cachedAccountId) cachedAccountId = (await stsSend(new GetCallerIdentityCommand({}))).Account ?? '';
    const assumed = await stsSend(new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${cachedAccountId}:role/${EXECUTOR_ROLE_NAME}`,
      RoleSessionName: label,
      SourceIdentity: label,
      DurationSeconds: 900,
      Policy: JSON.stringify(sessionPolicy),
    }));
    const c = assumed.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('AssumeRole returned no credentials');
    return createWriter(ec2SendFor({ accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken }));
  };
}
