// Root-cause in Slack: one alert per new incident, and the rule-based "왜 고장났어 <리소스>" answer (no LLM picks the resource).
// Slack 연동 — 새 사건마다 알림 한 번, 규칙 기반 "왜 고장났어 <리소스>" 답변(리소스는 AI가 고르지 않는다).
import { getConfig } from '@/lib/app-config';
import { toolLabel } from '@/components/changes/format';
import { getCurrentStore } from '@/lib/dep-graph/store';
import type { GraphNode } from '@/lib/dep-graph/types';
import { postAlertViaBot } from '@/lib/slack-chatops/alert';
import type { MentionEvent } from '@/lib/slack-chatops/handle';
import { extractCandidates } from '@/lib/change-timeline/slack';
import { getWebhookUrl, postSlack } from '@/lib/health/slack';
import { manualAnalyze } from './analyze';
import type { Incident } from './types';

const errName = (e: unknown) => (e instanceof Error ? e.name : 'Error');
const CAUSE_WORDS = /왜\s*고장|원인|뭐가\s*바뀌|무슨\s*변경|why.*(down|broken|fail)|root\s*cause/i;
// Cost questions belong to the cost handler ("nat-0abc 비용 증가 원인"). / 비용 질문은 비용 처리기 몫.
const COST_WORDS = /비용|요금|청구|\bcosts?\b|\bbill(ing)?\b/i;
const ID_TOKEN = /\b(?:sg|i|eni)-[0-9a-z]+|arn:aws:\S+/i;
// Words that are never a resource name. / 리소스 이름이 아닌 단어들.
const STOP_WORDS = new Set(['why', 'down', 'broken', 'fail', 'failed', 'the', 'is', 'are', 'was', 'what', 'root', 'cause', 'causes', 'did', 'does', 'and', 'for', 'with', 'this', 'that', 'awsops', 'ec2', 'aws', 'cost', 'costs', 'report', 'rds', 'lambda', 'alb', 'nlb', 'elb', 's3', 'iam', 'vpc', 'eks', 'ecs', 'sg', 'ebs', 'nat', 'tg', 'slack', 'bot', 'dashboard']);

// Escape Slack control chars. / Slack 제어 문자 이스케이프.
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Ids and ARNs may match by search; plain words need an exact name/id hit. / ID·ARN이 아닌 단어는 이름·ID가 정확히 같아야 한다.
const isIdQuery = (q: string): boolean => /^(?:(?:sg|i|eni|subnet|vpc|nat|eipalloc|vol|tg)-[0-9a-z]+|arn:aws:)/i.test(q);

// KST HH:mm. / 한국 시각 HH:mm.
const kstHm = (iso: string): string => new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(11, 16);

// Short resource type label from an ARN. / ARN에서 뽑은 짧은 종류 이름.
function typeLabel(arn: string | null): string {
  if (!arn) return '계정';
  if (arn.includes(':loadbalancer/')) return 'ALB';
  if (arn.includes(':targetgroup/')) return '대상 그룹';
  if (arn.includes(':instance/')) return 'EC2';
  if (arn.includes(':db:')) return 'RDS';
  if (arn.includes(':function:')) return 'Lambda';
  return '리소스';
}

/** Alert text for one analyzed incident. / 분석된 사건 하나의 알림 문장. */
export function formatIncidentAlert(inc: Incident, appUrl?: string): string {
  const name = esc(inc.resourceName ?? inc.signals[0]?.alarmName ?? '계정 전체');
  const detail = esc(inc.signals[0]?.detail ?? '이상 감지');
  const extra = inc.signals.length > 1 ? ` 외 신호 ${inc.signals.length - 1}개` : '';
  const lines = [`🔎 장애 감지: ${name}(${typeLabel(inc.resourceArn)}) ${detail}${extra} (${kstHm(inc.startedAt)}부터)`];
  const a = inc.analysis;
  const top = a?.suspects[0];
  if (top) {
    const res = top.event.refs.find((r) => r.id)?.id ?? top.event.refs[0]?.arn ?? '';
    lines.push(`의심 1위: ${kstHm(top.event.time)} ${esc(top.event.actor.name)}님이 ${esc(res)} ${esc(top.event.eventName)} (${toolLabel(top.event.tool)})`.replace(/ {2,}/g, ' '));
  }
  if (!a) lines.push('분석 결과가 아직 없어요');
  else {
    const partial = a.failedRegions.length > 0 || a.truncated;
    if (partial) lines.push('일부 기록을 못 읽었어요');
    else if (!top) lines.push('직전 60분에 관련 변경이 없어요');
  }
  if (a?.ai.status === 'ok' && a.ai.summary) lines.push(esc(a.ai.summary));
  if (appUrl) lines.push(`자세히: ${appUrl.replace(/\/+$/, '')}/root-cause?id=${inc.id}`);
  return lines.join('\n');
}

export interface NotifyDeps { viaBot?: typeof postAlertViaBot; webhook?: () => Promise<string | null>; post?: typeof postSlack }

/** Send the alert: bot channel first (no AI button), webhook as fallback; true when delivered. / 봇 우선(버튼 없음), 웹훅 폴백, 전달되면 true. */
export async function notifyIncident(inc: Incident, deps: NotifyDeps = {}): Promise<boolean> {
  if (getConfig().rootCause?.slackAlerts === false) return false;
  const text = formatIncidentAlert(inc, getConfig().appUrl);
  try {
    const bot = await (deps.viaBot ?? postAlertViaBot)(text, { button: false });
    if (bot.ok) return true;
    if (bot.error) { console.warn('[root-cause] slack bot alert failed'); return false; }
    const url = await (deps.webhook ?? getWebhookUrl)();
    if (!url) return false;
    return (await (deps.post ?? postSlack)(url, { text })).ok;
  } catch (e) {
    console.error('[root-cause] slack alert failed:', errName(e));
    return false;
  }
}

/** Rule-based detection of "왜 고장났어 <리소스>"; null when no cause word or no resource token. / 규칙 기반 질문 감지. */
export function detectRcaQuestion(text: string): { query: string } | null {
  const t = text.replace(/<@[^>]+>/g, ' ').trim();
  if (!CAUSE_WORDS.test(t) || COST_WORDS.test(t)) return null;
  const id = t.match(ID_TOKEN)?.[0];
  if (id) return { query: id.replace(/[?.,!>)]+$/, '') };
  const word = extractCandidates(t).find((w) => !STOP_WORDS.has(w.toLowerCase()));
  return word ? { query: word } : null;
}

export interface RcaHandlerDeps { reply: (text: string) => Promise<void>; analyze?: typeof manualAnalyze; search?: (q: string) => Promise<GraphNode[]> }

async function defaultSearch(q: string): Promise<GraphNode[]> {
  const store = getCurrentStore();
  if (!store) return [];
  if (/^arn:aws:/i.test(q)) { const n = await store.node(q); if (n) return [n]; }
  return store.search(q, { limit: 1 });
}

/** Answer a cause question; false hands the mention on (no match / resource not in graph). / 질문이 아니거나 리소스를 못 찾으면 false. */
export async function maybeHandleRcaQuestion(event: MentionEvent, deps: RcaHandlerDeps): Promise<boolean> {
  const q = detectRcaQuestion(event.text);
  if (!q) return false;
  let node: GraphNode | undefined;
  try {
    const hits = await (deps.search ?? defaultSearch)(q.query);
    const lc = q.query.toLowerCase();
    node = isIdQuery(q.query) ? hits[0] : hits.find((h) => h.name.toLowerCase() === lc || h.id.toLowerCase() === lc);
  } catch (e) { console.error('[root-cause] slack search failed:', errName(e)); return false; }
  if (!node) return false;
  await deps.reply('분석 중이에요…');
  try {
    const inc = await (deps.analyze ?? manualAnalyze)({ accountId: node.accountId, resourceArn: node.arn, userId: event.user });
    await deps.reply(formatIncidentAlert(inc, getConfig().appUrl));
  } catch (e) {
    const n = errName(e);
    console.error('[root-cause] slack analysis failed:', n);
    await deps.reply(n === 'RateLimited' ? '방금 분석했어요. 30초 뒤에 다시 물어봐 주세요.'
      : n === 'Timeout' ? '분석이 오래 걸려요. 끝나면 /root-cause 화면에서 볼 수 있어요.'
      : '분석하지 못했어요. 잠시 뒤 /root-cause 화면에서 다시 해 보세요.');
  }
  return true;
}
