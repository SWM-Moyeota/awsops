// EC2 reads (dashboard role) and approved writes (dedicated AWSopsSlackControlRole, assumed per execution).
// The role's IAM policy only allows Start/Stop/Reboot on instances tagged awsops:control=allow, so even a bug
// here cannot touch other teams' servers. SourceIdentity records the Slack approver in CloudTrail.
// 조회는 대시보드 역할로, 승인된 실행은 전용 역할로. IAM이 태그 붙은 인스턴스만 허용하므로 코드 버그로도 다른 팀 서버를 못 건드린다.
import {
  EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand, RebootInstancesCommand,
  type Instance,
} from '@aws-sdk/client-ec2';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { ControlAction, ControllableInstance } from './types';

export const CONTROL_TAG_KEY = 'awsops:control';
export const CONTROL_TAG_VALUE = 'allow';
export const CONTROL_ROLE_NAME = 'AWSopsSlackControlRole';
const REGION = 'ap-northeast-2';
const TIMEOUT_MS = 15_000;

/** States from which each action makes sense. / 작업별로 실행 가능한 현재 상태 */
export const ALLOWED_FROM: Record<ControlAction, string[]> = {
  start: ['stopped'],
  stop: ['running', 'pending'],
  reboot: ['running'],
};

/** Name tags are user-controlled — strip Slack formatting characters so a name can't fake card lines. */
export function safeName(raw: string): string {
  return raw.replace(/[`<>&*_~|\r\n]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
}

function toControllable(i: Instance): ControllableInstance | null {
  if (!i.InstanceId) return null;
  const tags = i.Tags ?? [];
  if (!tags.some(t => t.Key === CONTROL_TAG_KEY && t.Value === CONTROL_TAG_VALUE)) return null;
  return {
    id: i.InstanceId,
    name: safeName(tags.find(t => t.Key === 'Name')?.Value ?? ''),
    state: i.State?.Name ?? 'unknown',
  };
}

async function describe(filters: { Name: string; Values: string[] }[], ids?: string[]): Promise<ControllableInstance[]> {
  const ec2 = new EC2Client({ region: REGION });
  const out: ControllableInstance[] = [];
  let token: string | undefined;
  do {
    const r = await ec2.send(
      new DescribeInstancesCommand({ Filters: filters, InstanceIds: ids, NextToken: token }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    for (const res of r.Reservations ?? []) {
      for (const i of res.Instances ?? []) {
        const c = toControllable(i);
        if (c) out.push(c);
      }
    }
    token = r.NextToken;
  } while (token);
  return out;
}

/** Instances that opted in with the control tag (terminated ones excluded). */
export function listControllableInstances(): Promise<ControllableInstance[]> {
  return describe([
    { Name: `tag:${CONTROL_TAG_KEY}`, Values: [CONTROL_TAG_VALUE] },
    { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
  ]);
}

/** Fresh read right before execution; null when gone or no longer tagged. */
export async function describeControllable(id: string): Promise<ControllableInstance | null> {
  try {
    const found = await describe([], [id]);
    return found[0] ?? null;
  } catch {
    return null;
  }
}

let cachedAccountId: string | null = null;

async function accountId(): Promise<string> {
  if (cachedAccountId) return cachedAccountId;
  const sts = new STSClient({ region: REGION });
  const r = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
  cachedAccountId = r.Account ?? '';
  return cachedAccountId;
}

/** SourceIdentity / session names allow only [\w+=,.@-], 2–64 chars. */
export function sessionLabel(slackUserId: string): string {
  return `slack-${slackUserId.replace(/[^\w+=,.@-]/g, '')}`.slice(0, 64);
}

/** Assume the control role as the approver, then run exactly one EC2 action. */
export async function executeControl(
  action: ControlAction, instanceId: string, approverId: string,
): Promise<{ previous: string; current: string }> {
  const sts = new STSClient({ region: REGION });
  const label = sessionLabel(approverId);
  const assumed = await sts.send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${await accountId()}:role/${CONTROL_ROLE_NAME}`,
    RoleSessionName: label,
    SourceIdentity: label,
    DurationSeconds: 900,
  }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('AssumeRole returned no credentials');
  const ec2 = new EC2Client({
    region: REGION,
    credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
  });
  const signal = { abortSignal: AbortSignal.timeout(TIMEOUT_MS) };
  if (action === 'start') {
    const r = await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }), signal);
    const s = r.StartingInstances?.[0];
    return { previous: s?.PreviousState?.Name ?? '?', current: s?.CurrentState?.Name ?? '?' };
  }
  if (action === 'stop') {
    const r = await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }), signal);
    const s = r.StoppingInstances?.[0];
    return { previous: s?.PreviousState?.Name ?? '?', current: s?.CurrentState?.Name ?? '?' };
  }
  await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }), signal);
  return { previous: 'running', current: 'rebooting' };
}
