// Change timeline in Slack: the rule-based "누가 만들었어?" answer and the 09:00 KST daily summary.
// Deliberately no LLM — a model must never guess who created or deleted a resource.
// 변경 기록 Slack 연동: 규칙 기반 "누가 만들었어?" 답변과 매일 09:00(KST) 요약. AI는 쓰지 않는다.
import { getConfig } from '@/lib/app-config';
import { getBotHandle } from '@/lib/slack-chatops/alert';
import type { MentionEvent } from '@/lib/slack-chatops/handle';
import { kstDate, kstTime, resourceEmoji, resourceTypeLabel, sentence, toolLabel, withSubject } from '@/components/changes/format';
import { searchByText } from './query';
import { readRecords, readState, writeState } from './store';
import type { ChangeRecord } from './types';

export interface WhoQuestion { kind: 'create' | 'delete' | 'any'; target: string }

const MAX_CANDIDATES = 5;
const KST_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
const NAME_TOKEN = /[A-Za-z0-9][A-Za-z0-9._:/-]{2,}/g;
// Service words people write next to the name ("EC2 i-0abc 누가…") — not resource names.
const SERVICE_WORDS = new Set(['ec2', 's3', 'rds', 'eks', 'ecs', 'ecr', 'vpc', 'iam', 'aws', 'nat', 'ebs', 'sg', 'alb', 'nlb', 'elb']);

export function detectWhoQuestion(text: string): WhoQuestion | null {
  const t = text.replace(/<@[^>]+>/g, ' ').trim();
  if (!/누가|누구/.test(t)) return null;
  const kind = /지웠|지운|삭제|없앴|제거/.test(t) ? 'delete' : /만들|만든|생성/.test(t) ? 'create' : 'any';
  const target = (t.match(NAME_TOKEN) ?? [])
    .map((s) => s.replace(/[._:/-]+$/, ''))
    .find((s) => s.length >= 3 && !SERVICE_WORDS.has(s.toLowerCase()));
  return target ? { kind, target } : null;
}

const subject = (r: ChangeRecord): string => (r.actor.kind === 'person' ? `${r.actor.name}님이` : withSubject(r.actor.name));
const when = (iso: string): string => `${kstDate(iso)} ${kstTime(iso)}`;

interface Group { create?: ChangeRecord; del?: ChangeRecord; latest: string }

function groupByResource(records: ChangeRecord[]): Group[] {
  const map = new Map<string, ChangeRecord[]>();
  for (const r of records) {
    const k = `${r.accountId}:${r.resourceType}:${r.resourceId}`;
    map.set(k, [...(map.get(k) ?? []), r]);
  }
  return Array.from(map.values()).map((rs) => {
    const sorted = [...rs].sort((a, b) => (a.time < b.time ? 1 : -1)); // newest first
    const create = sorted.find((r) => r.kind === 'create');
    const del = sorted.find((r) => r.kind === 'delete' && (!create || r.time > create.time));
    return { create, del, latest: sorted[0].time };
  }).sort((a, b) => (a.latest < b.latest ? 1 : -1));
}

export function answerWho(q: WhoQuestion, records: ChangeRecord[]): string {
  const groups = groupByResource(records);
  if (groups.length === 0) return `최근 90일 기록에서 \`${q.target}\`을(를) 찾지 못했어요`;

  const head = (g: Group): ChangeRecord => (q.kind === 'delete' ? g.del ?? g.create! : g.create ?? g.del!);
  const status = (g: Group): string => (g.del ? `${kstDate(g.del.time)} ${subject(g.del)} 지웠어요` : '아직 있어요');

  if (groups.length === 1) {
    const g = groups[0];
    const r = head(g);
    const { who, rest } = sentence(r);
    return [
      `${resourceEmoji(r.resourceType)} *${who}${rest}*`,
      `${r.resourceName} · ${resourceTypeLabel(r.resourceType)}`,
      `${when(r.time)} · ${toolLabel(r.tool, r.via)}`,
      status(g),
    ].join('\n');
  }

  const lines = [`\`${q.target}\`와(과) 비슷한 리소스가 ${groups.length}개 있어요`];
  for (const g of groups.slice(0, MAX_CANDIDATES)) {
    const r = head(g);
    const { who, rest } = sentence(r);
    lines.push(`• ${resourceEmoji(r.resourceType)} ${r.resourceName} · ${resourceTypeLabel(r.resourceType)} — ${who}${rest} (${kstDate(r.time)})`);
  }
  if (groups.length > MAX_CANDIDATES) lines.push(`…외 ${groups.length - MAX_CANDIDATES}개. 이름을 더 정확히 알려 주세요`);
  return lines.join('\n');
}

const kstDay = (d: Date): string => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);

export function buildDailySummary(records: ChangeRecord[], dayKst: string): string | null {
  const day = records.filter((r) => !r.failed && kstDay(new Date(r.time)) === dayKst);
  if (day.length === 0) return null;
  const c = day.filter((r) => r.kind === 'create').length;
  const d = day.length - c;
  const head = c > 0 && d > 0 ? `${c}개가 생기고 ${d}개가 사라졌어요` : c > 0 ? `${c}개가 생겼어요` : `${d}개가 사라졌어요`;
  const lines = [`☀️ *어제 ${head}*`];

  const people = day.filter((r) => r.actor.kind === 'person' || r.actor.kind === 'root');
  const parts: string[] = [];
  for (const [kind, label] of [['create', '생성'], ['delete', '삭제']] as const) {
    const counts = new Map<string, number>();
    for (const r of people.filter((p) => p.kind === kind)) counts.set(r.actor.name, (counts.get(r.actor.name) ?? 0) + 1);
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([name, n]) => parts.push(`${name} ${label} ${n}`));
  }
  if (parts.length) lines.push(parts.join(' · '));
  return lines.join('\n');
}

async function postViaBot(text: string): Promise<boolean> {
  const bot = getBotHandle();
  const channel = getConfig().slackAlertChannelId;
  if (!bot || !channel) return false;
  await bot.postMessage({ channel, text });
  return true;
}

/** At/after 09:00 KST, send yesterday's summary once. / 09:00(KST) 이후 어제 요약을 하루 한 번 보낸다. */
export async function maybeSendDailySummary(opts: { now?: Date; post?: (text: string) => Promise<boolean> } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const kst = new Date(now.getTime() + KST_MS);
  if (kst.getUTCHours() < 9) return;
  const today = kst.toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  if ((await readState()).lastSummaryDay === yesterday) return;

  const startUtc = new Date(Date.parse(`${yesterday}T00:00:00Z`) - KST_MS);
  const endUtc = new Date(startUtc.getTime() + DAY_MS - 1);
  const text = buildDailySummary(await readRecords(startUtc, endUtc), yesterday);
  if (text) {
    let sent = false;
    try {
      sent = await (opts.post ?? postViaBot)(text);
    } catch (e) {
      console.warn(`[change-timeline] summary post failed (${e instanceof Error ? e.name : 'Error'})`);
    }
    if (!sent) return; // no bot / channel / failure — try again next tick
  }
  await writeState({ ...(await readState()), lastSummaryDay: yesterday });
}

/** Slack hook: answer "X 누가 만들었어?" from the records; true = handled, skip the AI. / true면 AI로 보내지 않는다. */
export async function maybeHandleChangeQuestion(event: MentionEvent, deps: { reply: (text: string) => Promise<void> }): Promise<boolean> {
  const q = detectWhoQuestion(event.text);
  if (!q) return false;
  try {
    await deps.reply(answerWho(q, await searchByText(q.target)));
  } catch (e) {
    console.warn(`[change-timeline] who-question failed (${e instanceof Error ? e.name : 'Error'})`);
    await deps.reply('변경 기록을 읽지 못했어요. 잠시 후 다시 물어봐 주세요.').catch(() => {});
  }
  return true;
}
