// Deterministic suspect score parts: time x graph distance x change kind (spec §2).
// 용의자 점수의 세 요소 — 시간 근접도 × 그래프 거리 × 변경 종류(스펙 §2).
import type { Distance } from './types';

const TAG_EVENTS: ReadonlySet<string> = new Set(['CreateTags', 'DeleteTags', 'TagResource', 'UntagResource', 'AddTags', 'RemoveTags', 'TagRole', 'UntagRole']);
const PREFIXES: ReadonlyArray<readonly [number, readonly string[]]> = [
  [1.0, ['Revoke', 'Delete', 'Detach', 'Disassociate', 'Deregister', 'Remove', 'Replace', 'Stop', 'Terminate', 'Reboot']],
  [0.8, ['Modify', 'Update', 'Put', 'Set', 'Change', 'Attach', 'Associate', 'Register', 'Authorize', 'Apply', 'Enable', 'Disable', 'Reset']],
  [0.5, ['Create', 'Run', 'Start', 'Import', 'Copy']],
];

/** exp(-minutes before start / 20); after start 0.3. / 시작 전 지수 감쇠, 시작 뒤 0.3. */
export function timeWeight(eventTime: Date, startedAt: Date): number {
  const deltaMin = (startedAt.getTime() - eventTime.getTime()) / 60_000;
  if (deltaMin < 0) return 0.3;
  return Math.exp(-deltaMin / 20);
}

/** Hop count to weight; non-numeric reasons have fixed weights. / 홉 수별 가중치, 숫자가 아니면 고정값. */
export function graphWeight(d: Distance): number {
  if (typeof d === 'number') return [1.0, 0.85, 0.65, 0.45, 0.3][d] ?? 0.3;
  if (d === 'unconnected') return 0.08;
  if (d === 'not-in-graph') return 0.12;
  return 0.5;
}

/** Tag list first, then name prefixes, else 0.6. / 태그 이름 먼저, 그다음 접두사, 그 밖은 0.6. */
export function kindWeight(eventName: string): number {
  if (TAG_EVENTS.has(eventName)) return 0.1;
  for (const [w, list] of PREFIXES) if (list.some((p) => eventName.startsWith(p))) return w;
  return 0.6;
}
