// In-server health checks — each returns a CheckResult and never throws.
// 서버 안 헬스 점검 — 각 점검은 CheckResult를 반환하며 예외를 던지지 않는다.
// AWS SDK v3 clients only (no synchronous awsCli/execFileSync — it would block the server).
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { BedrockAgentCoreControlClient, GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getConfig, getBedrockModelId } from '@/lib/app-config';
import { pingSteampipe } from '@/lib/steampipe';
import type { CheckResult } from './types';

const REGION = 'ap-northeast-2';
const LAMBDA_CONCURRENCY = 4;
const LAMBDA_TIMEOUT_MS = 20_000;
const BEDROCK_TIMEOUT_MS = 30_000;
const AGENTCORE_TIMEOUT_MS = 15_000;
const ASSUME_ROLE_TIMEOUT_MS = 10_000;
const CROSS_ACCOUNT_ROLE = 'AWSopsReadOnlyRole';
const PROBE_PAYLOAD = '{"tool_name":"__healthcheck__"}';

/**
 * The 19 AgentCore tool Lambdas — explicit list, never a glob
 * (a glob would also match awsops-health-watchdog).
 */
export const TOOL_LAMBDAS: string[] = [
  'awsops-aws-knowledge',
  'awsops-cloudtrail-mcp',
  'awsops-cloudwatch-mcp',
  'awsops-core-mcp',
  'awsops-cost-mcp',
  'awsops-dynamodb-mcp',
  'awsops-ecs-mcp',
  'awsops-eks-mcp',
  'awsops-flow-monitor',
  'awsops-iac-mcp',
  'awsops-iam-mcp',
  'awsops-istio-mcp',
  'awsops-msk-mcp',
  'awsops-network-mcp',
  'awsops-rds-mcp',
  'awsops-reachability-analyzer',
  'awsops-steampipe-query',
  'awsops-terraform-mcp',
  'awsops-valkey-mcp',
];

/** errorTypes meaning the function code could not load/run at all. */
const FATAL_ERROR_TYPES = new Set([
  'Runtime.ImportModuleError',
  'Runtime.HandlerNotFound',
  'Runtime.UserCodeSyntaxError',
  'Runtime.ExitError',
]);

// Lazily created so tests can mock the SDK modules before first use.
let lambdaClient: LambdaClient | null = null;
let controlClient: BedrockAgentCoreControlClient | null = null;
let bedrockClient: BedrockRuntimeClient | null = null;

function clip(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
    return clip(`${name}${err.message || ''}`.trim() || 'unknown error');
  }
  return clip(String(err));
}

/**
 * Decide whether a `{"tool_name":"__healthcheck__"}` probe response means the Lambda is broken.
 * Only load/init failures and timeouts count; handler-level errors (400 Unknown tool, KeyError)
 * prove the code loaded, so they are ok.
 */
export function classifyLambdaProbe(functionError: string | undefined, payload: string): { ok: boolean; message: string } {
  if (!functionError) return { ok: true, message: 'ok' };
  let errorType = '';
  let errorMessage = '';
  try {
    const parsed = JSON.parse(payload) as { errorType?: unknown; errorMessage?: unknown };
    if (typeof parsed?.errorType === 'string') errorType = parsed.errorType;
    if (typeof parsed?.errorMessage === 'string') errorMessage = parsed.errorMessage;
  } catch {
    errorMessage = payload;
  }
  if (FATAL_ERROR_TYPES.has(errorType) || /timed out/i.test(errorMessage)) {
    return { ok: false, message: clip(`${errorType || functionError}: ${errorMessage}`) };
  }
  return { ok: true, message: `handler reached (${errorType || functionError})` };
}

export async function checkSteampipe(): Promise<CheckResult> {
  try {
    const r = await pingSteampipe();
    return { id: 'steampipe', ok: r.ok, message: r.message };
  } catch (err) {
    return { id: 'steampipe', ok: false, message: errText(err) };
  }
}

export async function checkBedrock(): Promise<CheckResult> {
  try {
    bedrockClient ??= new BedrockRuntimeClient({ region: REGION });
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    await bedrockClient.send(
      new InvokeModelCommand({
        modelId: getBedrockModelId(),
        contentType: 'application/json',
        accept: 'application/json',
        body: new TextEncoder().encode(body),
      }),
      { abortSignal: AbortSignal.timeout(BEDROCK_TIMEOUT_MS) },
    );
    return { id: 'bedrock', ok: true, message: 'ok' };
  } catch (err) {
    return { id: 'bedrock', ok: false, message: errText(err) };
  }
}

export async function checkAgentcoreRuntime(): Promise<CheckResult> {
  const arn = getConfig().agentRuntimeArn;
  const runtimeId = arn ? arn.split('/').pop() : '';
  if (!runtimeId) return { id: 'agentcore-runtime', ok: false, message: 'agentRuntimeArn not configured' };
  try {
    controlClient ??= new BedrockAgentCoreControlClient({ region: REGION });
    const out = await controlClient.send(
      new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }),
      { abortSignal: AbortSignal.timeout(AGENTCORE_TIMEOUT_MS) },
    );
    const status = out.status ?? 'UNKNOWN';
    if (status === 'READY') return { id: 'agentcore-runtime', ok: true, message: 'READY' };
    const reason = out.failureReason ? `: ${out.failureReason}` : '';
    return { id: 'agentcore-runtime', ok: false, message: clip(`status ${status}${reason}`) };
  } catch (err) {
    return { id: 'agentcore-runtime', ok: false, message: errText(err) };
  }
}

async function probeLambda(name: string): Promise<{ ok: boolean; message: string }> {
  try {
    lambdaClient ??= new LambdaClient({ region: REGION });
    const out = await lambdaClient.send(
      new InvokeCommand({ FunctionName: name, Payload: new TextEncoder().encode(PROBE_PAYLOAD) }),
      { abortSignal: AbortSignal.timeout(LAMBDA_TIMEOUT_MS) },
    );
    const payload = out.Payload ? new TextDecoder().decode(out.Payload) : '';
    return classifyLambdaProbe(out.FunctionError, payload);
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { ok: false, message: aborted ? `invoke timed out after ${LAMBDA_TIMEOUT_MS / 1000}s` : errText(err) };
  }
}

export async function checkLambdas(): Promise<CheckResult> {
  try {
    const results: Array<{ name: string; ok: boolean; message: string }> = [];
    let next = 0;
    const worker = async () => {
      while (next < TOOL_LAMBDAS.length) {
        const name = TOOL_LAMBDAS[next++];
        const r = await probeLambda(name);
        results.push({ name, ...r });
      }
    };
    await Promise.all(Array.from({ length: LAMBDA_CONCURRENCY }, worker));

    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      return { id: 'lambda', ok: true, message: `${TOOL_LAMBDAS.length}/${TOOL_LAMBDAS.length} ok` };
    }
    const detail = failed.map((f) => `${f.name} (${clip(f.message, 120)})`).join(', ');
    return { id: 'lambda', ok: false, message: clip(`${failed.length}/${TOOL_LAMBDAS.length} failed: ${detail}`, 600) };
  } catch (err) {
    return { id: 'lambda', ok: false, message: errText(err) };
  }
}

/**
 * Can this server still assume AWSopsReadOnlyRole in every connected target account?
 * Catches a deleted stack/role or a changed External ID, which otherwise just makes that
 * account look empty in the dashboard. Only the error name is reported (never the message,
 * which can echo ARNs/External ID).
 * 연결된 대상 계정마다 읽기 전용 역할을 빌릴 수 있는지 확인 — 역할 삭제·External ID 변경 감지.
 */
export async function checkCrossAccount(): Promise<CheckResult> {
  const config = getConfig();
  const targets = (config.accounts || []).filter((a) => !a.isHost);
  if (targets.length === 0) {
    return { id: 'cross-account', ok: true, message: 'no target accounts' };
  }
  const sts = new STSClient({ region: REGION });
  const failures: string[] = [];
  await Promise.all(targets.map(async (a) => {
    try {
      await sts.send(new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${a.accountId}:role/${CROSS_ACCOUNT_ROLE}`,
        RoleSessionName: 'awsops-health',
        DurationSeconds: 900,
        ...(config.crossAccountExternalId ? { ExternalId: config.crossAccountExternalId } : {}),
      }), { abortSignal: AbortSignal.timeout(ASSUME_ROLE_TIMEOUT_MS) });
    } catch (e) {
      failures.push(`${a.alias} (${a.accountId}): ${e instanceof Error ? e.name : 'Error'}`);
    }
  }));
  if (failures.length === 0) {
    return { id: 'cross-account', ok: true, message: `${targets.length}/${targets.length} accounts reachable` };
  }
  failures.sort();
  return { id: 'cross-account', ok: false, message: `${failures.length}/${targets.length} unreachable: ${failures.join(', ')}` };
}
