// Shared CloudTrail access: per account+region pacing and cross-account AssumeRole credentials.
// CloudTrail 공용 접근: 계정+리전별 속도 제한과 교차 계정 AssumeRole 자격증명.
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getConfig } from '@/lib/app-config';

export const CLOUDTRAIL_MIN_INTERVAL_MS = 600;
const ROLE = 'AWSopsReadOnlyRole';
const STS_REGION = 'ap-northeast-2';

export type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

type State = { last: Map<string, number>; creds: Map<string, { creds: Creds; expires: number }> };
// Route bundles and instrumentation have separate module state, so share via globalThis.
// 번들마다 모듈 상태가 달라 globalThis로 공유한다.
type G = typeof globalThis & { __awsopsCloudTrailPacer?: State };

function state(): State {
  const g = globalThis as G;
  return (g.__awsopsCloudTrailPacer ??= { last: new Map(), creds: new Map() });
}

/**
 * Resolve once >= 600 ms has passed since the previous slot for this account+region.
 * Slots are claimed synchronously, so concurrent callers queue up in order.
 * 같은 계정+리전의 이전 호출로부터 600ms가 지나면 resolve. 동시 호출은 순서대로 대기.
 */
export async function cloudTrailSlot(accountId: string, region: string): Promise<void> {
  const s = state();
  const key = `${accountId}:${region}`;
  const now = Date.now();
  const at = Math.max(now, (s.last.get(key) ?? -Infinity) + CLOUDTRAIL_MIN_INTERVAL_MS);
  s.last.set(key, at);
  const wait = at - now;
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
}

/** AssumeRole credentials for a non-host account, cached until 1 min before expiry; undefined = default chain. */
export async function accountCredentials(accountId: string, sessionName: string): Promise<Creds | undefined> {
  const cfg = getConfig();
  const acct = cfg.accounts?.find((a) => a.accountId === accountId);
  if (!acct || acct.isHost) return undefined;
  const cache = state().creds;
  const hit = cache.get(accountId);
  if (hit && hit.expires - 60_000 > Date.now()) return hit.creds;
  const res = await new STSClient({ region: STS_REGION }).send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${accountId}:role/${ROLE}`,
    RoleSessionName: sessionName,
    DurationSeconds: 900,
    ...(cfg.crossAccountExternalId ? { ExternalId: cfg.crossAccountExternalId } : {}),
  }));
  const c = res.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('NoCredentials');
  const creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  cache.set(accountId, { creds, expires: c.Expiration ? new Date(c.Expiration).getTime() : Date.now() + 900_000 });
  return creds;
}

/** Test hook: clear shared state. / 테스트용 초기화. */
export function resetCloudTrailAccess(): void {
  const s = state();
  s.last.clear();
  s.creds.clear();
}
