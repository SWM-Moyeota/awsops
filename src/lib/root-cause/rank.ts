// Rank CloudTrail write events into suspects: parse, window, resolve, distance, score, sort.
// CloudTrail 쓰기 이벤트를 용의자 순위로 — 파싱·창 필터·리소스 찾기·거리·점수·정렬.
import type { GraphData } from '@/lib/dep-graph/types';
import { toWriteEvent } from './events';
import { proximity, resolveRefs } from './graph';
import { graphWeight, kindWeight, timeWeight } from './score';
import type { Suspect, WriteEvent } from './types';

const MAX_SUSPECTS = 50;
const BEFORE_MS = 60 * 60_000;
const AFTER_MS = 5 * 60_000;

export function rankSuspects(input: { accountId: string; targetArn: string | null; startedAt: Date; rawEvents: unknown[]; graph: GraphData }): { suspects: Suspect[]; eventsSeen: number } {
  const { accountId, targetArn, startedAt, rawEvents, graph } = input;
  const start = startedAt.getTime();
  const events: WriteEvent[] = [];
  let eventsSeen = 0;
  for (const raw of rawEvents) {
    const ev = toWriteEvent(raw, accountId);
    if (!ev) continue;
    eventsSeen++;
    const t = Date.parse(ev.time);
    if (t < start - BEFORE_MS || t > start + AFTER_MS) continue; // outside window / 창 밖
    events.push(ev);
  }
  const scored = events.map((event) => {
    const nodes = resolveRefs(event.refs, accountId, graph);
    const prox = proximity(targetArn, nodes, event.refs.length, graph);
    const weights = { time: timeWeight(new Date(event.time), startedAt), graph: graphWeight(prox.distance), kind: kindWeight(event.eventName) };
    const score = Math.round(weights.time * weights.graph * weights.kind * 10000) / 10000;
    return { event, proximity: prox, weights, score, dt: Math.abs(Date.parse(event.time) - start) };
  });
  scored.sort((a, b) => b.score - a.score || a.dt - b.dt || (a.event.eventId < b.event.eventId ? -1 : a.event.eventId > b.event.eventId ? 1 : 0));
  const suspects: Suspect[] = scored.slice(0, MAX_SUSPECTS).map(({ event, proximity: p, weights, score }, i) => ({ event, proximity: p, weights, score, rank: i + 1 }));
  return { suspects, eventsSeen };
}
