// Slack message formatting and delivery for health alerts.
// 헬스 알림용 Slack 메시지 포맷 및 전송. 웹훅 URL은 절대 로그/에러에 포함하지 않는다.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { CheckId, Transition } from './types';

export const CHECK_TITLES: Record<CheckId, string> = {
  steampipe: 'Steampipe 데이터베이스',
  bedrock: 'Bedrock 모델 호출',
  'agentcore-runtime': 'AgentCore 런타임',
  'agentcore-invoke': 'AgentCore 에이전트 호출',
  lambda: 'Lambda 도구',
};

export const REMEDIATION: Record<CheckId, string> = {
  steampipe: 'SSM 접속 후 `sudo su - ec2-user -c "cd ~/awsops && bash scripts/09-start-all.sh"`',
  bedrock: 'Bedrock 모델 접근 권한·config.json의 bedrockModelId 확인',
  'agentcore-runtime': 'AgentCore 콘솔에서 런타임 상태 확인, 필요 시 scripts/06g-redeploy-agent.sh',
  'agentcore-invoke': '/tmp/awsops-server.log의 [AgentCore Error] 확인',
  lambda: '실패한 함수의 CloudWatch 로그 확인 후 scripts/06c-setup-agentcore-tools.sh 재실행',
};

const WEBHOOK_PARAM = '/ops/awsops/slack-webhook-url';
const SSM_REGION = 'ap-northeast-2';
const CACHE_TTL_MS = 5 * 60 * 1000;
const POST_TIMEOUT_MS = 10_000;
const SSM_TIMEOUT_MS = 10_000;

/** Format a Date as `YYYY-MM-DD HH:mm KST` (UTC+9, no DST). */
function formatKst(d: Date): string {
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())} KST`;
}

export function formatSlackMessage(
  transitions: Transition[],
  opts: { dashboardUrl: string; now: Date },
): { text: string } {
  const lines: string[] = [];
  for (const t of transitions) {
    const title = CHECK_TITLES[t.id] ?? t.id;
    if (t.to === 'fail') {
      lines.push(`🔴 [AWSops] ${title} 장애`);
      lines.push(`• 원인: ${t.message}`);
      lines.push(`• 조치: ${REMEDIATION[t.id] ?? '로그 확인'}`);
    } else {
      lines.push(`🟢 [AWSops] ${title} 복구`);
    }
    lines.push('');
  }
  lines.push(`🕐 ${formatKst(opts.now)}`);
  lines.push(`🔗 대시보드: ${opts.dashboardUrl}`);
  return { text: lines.join('\n') };
}

export async function postSlack(
  webhookUrl: string,
  payload: { text: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      return { ok: false, error: `Slack responded ${res.status}${body ? `: ${body}` : ''}` };
    }
    return { ok: true };
  } catch (e) {
    // Error text may embed the URL (e.g. undici) — report only the error name.
    const name = e instanceof Error ? e.name : 'Error';
    return { ok: false, error: `Slack request failed (${name})` };
  }
}

let cached: { url: string | null; at: number } | null = null;

export async function getWebhookUrl(): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.url;
  try {
    const client = new SSMClient({ region: SSM_REGION });
    // Bounded: a stuck SSM call must never stall the Slack chain. / SSM 조회가 멈춰도 10초 후 중단
    const out = await client.send(
      new GetParameterCommand({ Name: WEBHOOK_PARAM, WithDecryption: true }),
      { abortSignal: AbortSignal.timeout(SSM_TIMEOUT_MS) },
    );
    const url = out.Parameter?.Value?.trim() || null;
    cached = { url, at: Date.now() };
    return url;
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    if (name === 'ParameterNotFound') {
      cached = { url: null, at: Date.now() };
      return null;
    }
    console.warn(`[health] SSM webhook lookup failed (${name})`);
    return null;
  }
}

export async function sendTestMessage(): Promise<{ ok: boolean; error?: string }> {
  const url = await getWebhookUrl();
  if (!url) return { ok: false, error: 'webhook not configured' };
  return postSlack(url, { text: '✅ [AWSops] 테스트 알림 — Slack 연결 정상' });
}
