// Change timeline — CloudTrail event → ChangeRecord rows. Never throws on odd payloads.
// CloudTrail 이벤트를 변경 기록으로 바꾼다. 이상한 입력이 와도 예외를 던지지 않는다.
import { findTracked } from './catalog';
import type { Actor, ChangeRecord, ResourceType, ToolId, TrackedEvent } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function get(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const p of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}
const getStr = (root: unknown, ...paths: string[]): string | undefined => {
  for (const p of paths) { const s = str(get(root, p)); if (s) return s; }
  return undefined;
};

// ---------- actor / tool ----------

const VIA_NAMES: Record<string, string> = {
  'cloudformation.amazonaws.com': 'CloudFormation',
  'autoscaling.amazonaws.com': 'Auto Scaling',
};
const AUTO_NAMES: Record<string, string> = {
  AWSServiceRoleForAutoScaling: 'Auto Scaling',
  AWSServiceRoleForECS: 'ECS',
  AWSServiceRoleForElasticLoadBalancing: 'Elastic Load Balancing',
  AWSServiceRoleForRDS: 'RDS',
  AWSServiceRoleForAmazonEKS: 'EKS',
  AWSServiceRoleForAmazonElastiCache: 'ElastiCache',
};
const AWSOPS_ROLES = new Set(['awsops-ec2-role', 'AWSopsLambdaNetworkRole', 'AWSopsSlackControlRole', 'AWSopsAgentCoreRole']);

function friendlyService(host: string): string {
  return VIA_NAMES[host] ?? (host.split('.')[0] || host);
}

export function classifyActor(userIdentity: unknown): { actor: Actor; via?: string } {
  const ui = isObj(userIdentity) ? userIdentity : {};
  const type = str(ui.type);
  const invokedBy = str(ui.invokedBy);

  if (type === 'Root') return { actor: { kind: 'root', name: '루트 계정' } };
  if (type === 'IAMUser') {
    const name = str(ui.userName) ?? getStr(ui, 'arn')?.split('/').pop() ?? 'unknown';
    return invokedBy ? { actor: { kind: 'person', name }, via: friendlyService(invokedBy) } : { actor: { kind: 'person', name } };
  }

  const issuer = getStr(ui, 'sessionContext.sessionIssuer.userName');
  const arn = str(ui.arn);
  const session = arn ? arn.split('/').pop() : undefined;

  if (type === 'AWSService' && !issuer) {
    return { actor: { kind: 'auto', name: invokedBy ? friendlyService(invokedBy) : 'AWS' } };
  }
  if (issuer) {
    if (/^AWSServiceRoleFor/.test(issuer)) {
      return { actor: { kind: 'auto', name: AUTO_NAMES[issuer] ?? issuer.replace(/^AWSServiceRoleFor(Amazon)?/, '') } };
    }
    if (/^cdk-.*-cfn-exec-role-/.test(issuer)) return { actor: { kind: 'auto', name: 'CloudFormation (CDK)' } };
    if (AWSOPS_ROLES.has(issuer)) {
      const sourceIdentity = getStr(ui, 'sessionContext.sourceIdentity');
      return { actor: sourceIdentity ? { kind: 'awsops', name: 'AWSops', sourceIdentity } : { kind: 'awsops', name: 'AWSops' } };
    }
    if (/^AWSReservedSSO_/.test(issuer)) return { actor: { kind: 'person', name: session ?? issuer } };
    return { actor: { kind: 'auto', name: session ? `${issuer}(${session})` : issuer } };
  }
  if (type === 'AWSService') return { actor: { kind: 'auto', name: 'AWS' } };
  return { actor: { kind: 'auto', name: session ?? type ?? 'unknown' } };
}

export function detectTool(userAgent: string | undefined, invokedBy: string | undefined): ToolId {
  if (invokedBy === 'cloudformation.amazonaws.com') return 'cloudformation';
  if (invokedBy === 'autoscaling.amazonaws.com') return 'autoscaling';
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (/console\.amazonaws\.com|signin\.amazonaws\.com|AWS Internal/.test(ua)) return 'console';
  if (ua.includes('aws-cli/')) return 'cli';
  if (/Terraform|terraform-provider/.test(ua)) return 'terraform';
  if (/Boto3|aws-sdk-/.test(ua)) return 'sdk'; // aws-sdk-js is covered by aws-sdk-
  // Console actions carry the operator's browser UA. 콘솔은 브라우저 UA로 기록된다.
  if (ua.startsWith('Mozilla/') || ua.startsWith('[Mozilla/')) return 'console';
  return 'other';
}

// ---------- resource extraction ----------

interface Res { id: string; name: string }
const tail = (s: string): string => s.split('/').pop() || s;

function nameTag(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const t of items) {
    if (isObj(t) && t.key === 'Name' && str(t.value)) return t.value as string;
  }
  return undefined;
}
function requestNameTag(req: unknown): string | undefined {
  const sets = get(req, 'tagSpecificationSet.items');
  if (!Array.isArray(sets)) return undefined;
  for (const s of sets) { const n = isObj(s) ? nameTag(s.tags) : undefined; if (n) return n; }
  return undefined;
}
function elbName(arn: string): string {
  const parts = arn.split(':').pop()?.split('/') ?? [];
  // loadbalancer/app/<name>/<hash>, targetgroup/<name>/<hash>
  if (parts[0] === 'loadbalancer' && parts.length >= 4) return parts[2];
  if (parts[0] === 'targetgroup' && parts.length >= 3) return parts[1];
  return tail(arn);
}
const fnName = (s: string): string => (s.includes(':function:') ? s.split(':function:')[1].split(':')[0] : s);

type Extractor = (req: unknown, resp: unknown, kind: 'create' | 'delete') => Res[];

const one = (id: string | undefined, name?: string): Res[] => (id ? [{ id, name: name ?? id }] : []);

const EXTRACT: Partial<Record<ResourceType, Extractor>> = {
  's3-bucket': (req) => one(getStr(req, 'bucketName')),
  'ec2-instance': (req, resp, kind) => {
    if (kind === 'delete') {
      const items = get(req, 'instancesSet.items');
      return Array.isArray(items) ? items.flatMap((i) => one(getStr(i, 'instanceId'))) : [];
    }
    const items = get(resp, 'instancesSet.items');
    if (!Array.isArray(items)) return [];
    const fallback = requestNameTag(req);
    return items.flatMap((i) => one(getStr(i, 'instanceId'), nameTag(isObj(i) ? get(i, 'tagSet.items') : undefined) ?? fallback));
  },
  'ebs-volume': (req, resp, k) => one(k === 'create' ? getStr(resp, 'volumeId') : getStr(req, 'volumeId'), requestNameTag(req)),
  'ebs-snapshot': (req, resp, k) => one(k === 'create' ? getStr(resp, 'snapshotId') : getStr(req, 'snapshotId'), requestNameTag(req)),
  'security-group': (req, resp, k) =>
    k === 'create' ? one(getStr(resp, 'groupId') ?? getStr(req, 'groupName'), getStr(req, 'groupName'))
      : one(getStr(req, 'groupId') ?? getStr(req, 'groupName'), getStr(req, 'groupName')),
  'elastic-ip': (req, resp, k) =>
    k === 'create' ? one(getStr(resp, 'allocationId'), getStr(resp, 'publicIp')) : one(getStr(req, 'allocationId') ?? getStr(req, 'publicIp'), getStr(req, 'publicIp')),
  'nat-gateway': (req, resp, k) => one(k === 'create' ? getStr(resp, 'natGateway.natGatewayId') : getStr(req, 'natGatewayId'), requestNameTag(req)),
  'vpc': (req, resp, k) => one(k === 'create' ? getStr(resp, 'vpc.vpcId') : getStr(req, 'vpcId'), requestNameTag(req)),
  'subnet': (req, resp, k) => one(k === 'create' ? getStr(resp, 'subnet.subnetId') : getStr(req, 'subnetId'), requestNameTag(req)),
  'load-balancer': (req, resp, k) => {
    const arn = k === 'create' ? getStr(resp, 'loadBalancers.0.loadBalancerArn') : getStr(req, 'loadBalancerArn');
    return one(arn ?? getStr(req, 'name'), getStr(req, 'name') ?? (arn ? elbName(arn) : undefined));
  },
  'target-group': (req, resp, k) => {
    const arn = k === 'create' ? getStr(resp, 'targetGroups.0.targetGroupArn') : getStr(req, 'targetGroupArn');
    return one(arn ?? getStr(req, 'name'), getStr(req, 'name') ?? (arn ? elbName(arn) : undefined));
  },
  'rds-instance': (req) => one(getStr(req, 'dBInstanceIdentifier')),
  'rds-cluster': (req) => one(getStr(req, 'dBClusterIdentifier')),
  'elasticache-cluster': (req) => one(getStr(req, 'cacheClusterId')),
  'elasticache-replication-group': (req) => one(getStr(req, 'replicationGroupId')),
  'elasticache-serverless': (req) => one(getStr(req, 'serverlessCacheName')),
  'lambda-function': (req, resp) => {
    const n = getStr(req, 'functionName') ?? getStr(resp, 'functionName');
    return one(n ? fnName(n) : undefined);
  },
  'ecr-repository': (req) => one(getStr(req, 'repositoryName')),
  'ecs-cluster': (req) => { const c = getStr(req, 'clusterName', 'cluster'); return one(c ? tail(c) : undefined); },
  'ecs-service': (req) => { const s = getStr(req, 'serviceName', 'service'); return one(s ? tail(s) : undefined); },
  'eks-cluster': (req) => one(getStr(req, 'name')),
  'dynamodb-table': (req) => one(getStr(req, 'tableName')),
  'iam-user': (req) => one(getStr(req, 'userName')),
  'iam-role': (req) => one(getStr(req, 'roleName')),
};

function fallbackResource(raw: Obj): Res[] {
  const first = Array.isArray(raw.resources) ? raw.resources[0] : undefined;
  const id = getStr(first, 'ARN', 'resourceName');
  return id ? [{ id, name: tail(id) }] : [];
}

function safeExtract(t: TrackedEvent, raw: Obj): Res[] {
  const req = isObj(raw.requestParameters) ? raw.requestParameters : {};
  const resp = isObj(raw.responseElements) ? raw.responseElements : {};
  let found: Res[] = [];
  try { found = EXTRACT[t.resourceType]?.(req, resp, t.kind) ?? []; } catch { found = []; }
  if (found.length === 0) { try { found = fallbackResource(raw); } catch { found = []; } }
  return found;
}

export function toRecords(raw: unknown, accountId: string): ChangeRecord[] {
  try {
    if (!isObj(raw)) return [];
    const eventName = str(raw.eventName);
    const eventSource = str(raw.eventSource);
    if (!eventName || !eventSource) return [];
    const t = findTracked(eventName, eventSource);
    if (!t) return [];
    const eventId = str(raw.eventID);
    const time = str(raw.eventTime);
    if (!eventId || !time) return [];

    const resources = safeExtract(t, raw);
    if (resources.length === 0) return [];

    const { actor, via } = classifyActor(raw.userIdentity);
    const invokedBy = getStr(raw.userIdentity, 'invokedBy');
    const tool = detectTool(str(raw.userAgent), invokedBy);
    const sourceIp = str(raw.sourceIPAddress);
    const failed = str(raw.errorCode) ? true : undefined;
    const region = str(raw.awsRegion) ?? t.region;

    return resources.map((r, i): ChangeRecord => {
      const rec: ChangeRecord = {
        id: resources.length > 1 ? `${eventId}:${i}` : eventId,
        eventId, eventName, accountId, region, time,
        kind: t.kind, resourceType: t.resourceType, resourceId: r.id, resourceName: r.name,
        actor, tool,
      };
      if (via) rec.via = via;
      if (sourceIp) rec.sourceIp = sourceIp;
      if (failed) rec.failed = true;
      return rec;
    });
  } catch {
    return [];
  }
}
