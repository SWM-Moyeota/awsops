// Incident grouping (pure): dedupe by key, join related signals within 2 hops, resolve quiet ones.
// 사건 묶기(순수 함수) — 같은 키 중복 제거, 2단계 안 관련 신호 합치기, 조용한 사건 닫기.
import type { GraphData } from '@/lib/dep-graph/types';
import { proximity } from './graph';
import type { Incident, Signal } from './types';

const GROUP_MS = 60 * 60_000;
const RESOLVE_MS = 30 * 60_000;
const RELATED_HOPS = 2;
export const MAX_INCIDENTS = 200;

/** `${accountId}|${resourceArn ?? 'alarm:' + alarmArn}|${kind}`. / 사건 키. */
export function incidentKey(s: Signal): string {
  return `${s.accountId}|${s.resourceArn ?? 'alarm:' + s.alarmArn}|${s.kind}`;
}

/** rc- + 10 random base36 chars. / rc- + 무작위 base36 10글자. */
export function newIncidentId(): string {
  let s = '';
  while (s.length < 10) s += Math.random().toString(36).slice(2);
  return 'rc-' + s.slice(0, 10);
}

// Open auto incident seen within the grouping window. / 묶기 창 안에서 본 열린 자동 사건.
function groupable(inc: Incident, accountId: string, now: number): boolean {
  return inc.source === 'auto' && inc.status === 'open' && inc.accountId === accountId && now - Date.parse(inc.lastSeenAt) <= GROUP_MS;
}

// Signal's resource within 2 hops of the incident's resource (Task 3 BFS rules). / 사건 리소스에서 2단계 안인가.
function related(inc: Incident, s: Signal, graph: GraphData | null): boolean {
  if (!inc.resourceArn || !s.resourceArn || !graph) return false;
  const cand = graph.nodes.find((n) => n.arn === s.resourceArn);
  if (!cand) return false;
  const d = proximity(inc.resourceArn, [cand], 1, graph).distance;
  return typeof d === 'number' && d <= RELATED_HOPS;
}

export function applySignals(list: Incident[], signals: Signal[], graphFor: (accountId: string) => GraphData | null, now: Date): { list: Incident[]; created: Incident[] } {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const out: Incident[] = list.map((i) => ({ ...i, signals: [...i.signals] }));
  const created: Incident[] = [];
  for (const s of signals) {
    const key = incidentKey(s);
    const open = out.filter((i) => groupable(i, s.accountId, nowMs));
    // Same key (the incident's own or a joined signal's) -> bump. / 같은 키면 lastSeenAt만 늘린다.
    const same = open.find((i) => i.key === key || i.signals.some((x) => incidentKey(x) === key));
    if (same) { same.lastSeenAt = nowIso; continue; }
    const graph = graphFor(s.accountId);
    const near = open.find((i) => related(i, s, graph));
    if (near) {
      near.signals.push(s);
      near.lastSeenAt = nowIso;
      // Not analyzed yet (created this call): start at the earliest signal. / 이번에 만든 사건은 가장 이른 신호로 시작 시각 보정.
      if (created.includes(near) && Date.parse(s.startedAt) < Date.parse(near.startedAt)) near.startedAt = s.startedAt;
      continue;
    }
    const node = s.resourceArn && graph ? graph.nodes.find((n) => n.arn === s.resourceArn) : undefined;
    const inc: Incident = {
      id: newIncidentId(), key, accountId: s.accountId, region: s.region, resourceArn: s.resourceArn, resourceName: node?.name ?? null,
      signals: [s], startedAt: s.startedAt, firstSeenAt: nowIso, lastSeenAt: nowIso, status: 'open', source: 'auto',
    };
    out.push(inc);
    created.push(inc);
  }
  for (const i of out) if (i.status === 'open' && nowMs - Date.parse(i.lastSeenAt) > RESOLVE_MS) i.status = 'resolved';
  out.sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt) || b.startedAt.localeCompare(a.startedAt));
  const kept = out.slice(0, MAX_INCIDENTS);
  return { list: kept, created: created.filter((c) => kept.includes(c)) };
}
