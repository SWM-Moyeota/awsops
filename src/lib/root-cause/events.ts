// CloudTrail write events → WriteEvent with resource refs; secrets and network details are stripped.
// CloudTrail 쓰기 이벤트를 리소스 참조가 붙은 WriteEvent로 바꾼다 — 비밀·네트워크 정보는 버린다.
import { classifyActor, detectTool } from '@/lib/change-timeline/parse';
import type { NodeType } from '@/lib/dep-graph/types';
import type { ResourceRef, WriteEvent } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

// Noisy events that are never a cause (spec §2). / 원인이 될 수 없는 잡음 이벤트 목록(스펙 §2).
export const NOISE_EVENTS: ReadonlySet<string> = new Set([
  'UpdateInstanceInformation', 'CreateLogStream', 'PutLogEvents', 'CreateLogGroup', 'Token_POST',
  'CognitoAuthentication', 'InitiateAuth', 'RespondToAuthChallenge', 'AssumeRole', 'AssumeRoleWithWebIdentity',
  'GetSessionToken', 'ConsoleLogin', 'StartSession', 'ResumeSession', 'TerminateSession', 'SendCommand',
  'PutMetricData', 'CreateGrant', 'RetireGrant', 'GenerateDataKey', 'Decrypt', 'Encrypt',
]);

// Lambda event names carry an API-version suffix (e.g. 20150331v2). / Lambda 이벤트 이름 끝의 API 버전 접미사.
const normalizeName = (n: string): string => n.replace(/\d{8}(v\d+)?$/, '');

// ---------- params / 파라미터 ----------

const SECRET_KEY = /password|secret|token|credential|privatekey/i;
const MAX_PARAMS = 600;

// Request parameters as short JSON with secret-like values hidden. / 비밀처럼 보이는 값을 가린 짧은 JSON.
export function sanitizeParams(req: unknown): string {
  if (req === null || req === undefined) return '';
  try {
    const json = JSON.stringify(req, (k, v) => (k && SECRET_KEY.test(k) ? '[숨김]' : v));
    if (!json) return '';
    return json.length > MAX_PARAMS ? `${json.slice(0, MAX_PARAMS - 1)}…` : json;
  } catch {
    return '';
  }
}

// ---------- refs / 리소스 참조 ----------

// ALB listener/rule ARN → its load balancer ARN. / 리스너·룰 ARN에서 로드밸런서 ARN을 만든다.
function lbFromListener(arn: string): string | undefined {
  const m = /^(arn:[^:]*:elasticloadbalancing:[^:]*:[^:]*:)listener(?:-rule)?\/(app|net|gwy)\/([^/]+)\/([^/]+)/.exec(arn);
  return m ? `${m[1]}loadbalancer/${m[2]}/${m[3]}/${m[4]}` : undefined;
}
// Lambda name or ARN → short name. / Lambda 이름 또는 ARN에서 짧은 이름.
function lambdaName(v: string): string {
  const m = /:function:([^:]+)/.exec(v);
  return m ? m[1] : v.split(':')[0];
}

type Add = (r: ResourceRef) => void;

// Handle one string value found under `key`. / 키 아래에서 찾은 문자열 값 하나를 처리한다.
function fromString(key: string, v: string, source: string | undefined, add: Add): void {
  const simple: Record<string, NodeType> = {
    instanceId: 'instance', networkInterfaceId: 'eni', subnetId: 'subnet', subnetIds: 'subnet', vpcId: 'vpc',
    allocationId: 'eip', natGatewayId: 'nat', volumeId: 'ebs', dBInstanceIdentifier: 'rds', bucketName: 's3',
    roleName: 'role',
  };
  if (key === 'groupId' || key === 'groupIds' || key === 'securityGroupIds' || key === 'securityGroups') {
    if (v.startsWith('sg-')) add({ type: 'sg', id: v });
  } else if (simple[key]) {
    add({ type: simple[key], id: v });
  } else if (key === 'loadBalancerArn') {
    add({ type: 'lb', arn: v });
  } else if (key === 'listenerArn' || key === 'ruleArn') {
    const arn = lbFromListener(v);
    if (arn) add({ type: 'lb', arn });
  } else if (key === 'targetGroupArn') {
    add({ type: 'tg', arn: v });
  } else if (key === 'functionName') {
    add(v.startsWith('arn:') ? { type: 'lambda', id: lambdaName(v), arn: v } : { type: 'lambda', id: lambdaName(v) });
  } else if (key === 'roleArn') {
    add({ type: 'role', id: v.split('/').pop() || v, arn: v });
  } else if ((key === 'id' || key === 'distributionId') && source === 'cloudfront.amazonaws.com') {
    add({ type: 'cloudfront', id: v });
  }
}

function walk(node: unknown, key: string, source: string | undefined, add: Add, depth: number): void {
  if (depth > 12) return;
  if (typeof node === 'string') { fromString(key, node, source, add); return; }
  if (Array.isArray(node)) { for (const x of node) walk(x, key, source, add, depth + 1); return; }
  if (isObj(node)) for (const [k, v] of Object.entries(node)) walk(v, k, source, add, depth + 1);
}

// Resource refs named anywhere in the request, response and resources[]. / 요청·응답·resources[] 어디서든 리소스 참조를 모은다.
export function extractRefs(raw: Record<string, unknown>): ResourceRef[] {
  const out: ResourceRef[] = [];
  const seen = new Set<string>();
  const add: Add = (r) => {
    const k = `${r.type ?? ''}|${r.id ?? ''}|${r.arn ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  try {
    const source = str(raw.eventSource);
    walk(raw.requestParameters, '', source, add, 0);
    walk(raw.responseElements, '', source, add, 0);
    if (Array.isArray(raw.resources)) {
      for (const r of raw.resources) {
        const arn = isObj(r) ? str(r.ARN) : undefined;
        if (arn) add({ type: null, arn });
      }
    }
  } catch { /* odd payload: return what we have / 이상한 입력은 모은 것까지만 */ }
  return out;
}

// ---------- event / 이벤트 ----------

// Raw CloudTrail record → WriteEvent, or null when it is noise, failed, read-only or malformed. / 잡음·실패·읽기·불량이면 null.
export function toWriteEvent(raw: unknown, accountId: string): WriteEvent | null {
  try {
    if (!isObj(raw)) return null;
    const rawName = str(raw.eventName);
    const eventSource = str(raw.eventSource);
    const eventId = str(raw.eventID);
    const timeStr = str(raw.eventTime);
    if (!rawName || !eventId || !timeStr) return null;
    const eventName = normalizeName(rawName);
    if (NOISE_EVENTS.has(rawName) || NOISE_EVENTS.has(eventName)) return null;
    if (raw.errorCode) return null;
    if (raw.readOnly === true || raw.readOnly === 'true') return null;
    const ms = Date.parse(timeStr);
    if (Number.isNaN(ms)) return null;

    const { actor } = classifyActor(raw.userIdentity);
    const invokedBy = isObj(raw.userIdentity) ? str(raw.userIdentity.invokedBy) : undefined;
    return {
      eventId,
      eventName,
      eventSource: eventSource ?? '',
      time: new Date(ms).toISOString(),
      accountId,
      region: str(raw.awsRegion) ?? '',
      actor,
      tool: detectTool(str(raw.userAgent), invokedBy),
      refs: extractRefs(raw),
      params: sanitizeParams(raw.requestParameters),
    };
  } catch {
    return null;
  }
}
