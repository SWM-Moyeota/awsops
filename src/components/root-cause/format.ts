// Pure display helpers for /root-cause: time offsets, signal and distance labels, local datetime input.
// 장애 원인 분석 화면용 순수 함수 — 시작 기준 시간 차이, 신호·거리 이름, 로컬 시각 입력.
import type { Distance, Incident, SignalKind, Suspect } from '@/lib/root-cause/types';

export type T = (key: string, params?: Record<string, string | number>) => string;

// Timeline window around the start, in minutes. / 타임라인 범위(시작 기준 분).
export const WINDOW_BEFORE_MIN = 60;
export const WINDOW_AFTER_MIN = 5;
const SIGNALS: SignalKind[] = ['alb-5xx', 'tg-unhealthy', 'ec2-status', 'alarm'];

/** Signed minutes from `startIso` to `eventIso` (NaN on bad input). / 시작에서 이벤트까지의 분(음수 = 전). */
export function offsetMinutes(eventIso: string, startIso: string): number {
  const e = Date.parse(eventIso);
  const s = Date.parse(startIso);
  if (!Number.isFinite(e) || !Number.isFinite(s)) return NaN;
  return (e - s) / 60_000;
}

/** Keep a point inside −60..+5 minutes. / 타임라인 범위 안으로 자른다. */
export function clampOffset(min: number): number {
  return Math.min(WINDOW_AFTER_MIN, Math.max(-WINDOW_BEFORE_MIN, min));
}

/** "12분 전" / "2분 후" / "시작 무렵" ('' on bad input). / 시작 기준 몇 분 전·후. */
export function formatOffset(eventIso: string, startIso: string, t: T): string {
  const m = offsetMinutes(eventIso, startIso);
  if (Number.isNaN(m)) return '';
  const n = Math.round(Math.abs(m));
  if (n === 0) return t('rootCause.atStart');
  return m < 0 ? t('rootCause.minBefore', { n }) : t('rootCause.minAfter', { n });
}

/** Beginner-friendly signal name. / 신호 이름. */
export function signalLabel(kind: SignalKind, t: T): string {
  return SIGNALS.includes(kind) ? t(`rootCause.signal.${kind}`) : String(kind);
}

/** Graph distance as words. / 그래프 거리를 말로. */
export function distanceLabel(d: Distance, t: T): string {
  if (typeof d === 'number') return d === 0 ? t('rootCause.distance.same') : t('rootCause.distance.hops', { n: d });
  return t(`rootCause.distance.${d}`);
}

/** "mo(lb) → tg-a(tg)". / 경로를 화살표로 잇는다. */
export function pathLabel(path: string[]): string {
  return path.join(' → ');
}

/** The suspect's resource: last path node, else the first ref, else a dash. / 용의자 리소스 이름. */
export function resourceLabel(s: Suspect): string {
  const p = s.proximity.path;
  if (p.length > 0) return p[p.length - 1];
  const ref = s.event.refs[0];
  return ref?.id || ref?.arn || '—';
}

/** DOM id for a suspect row (event ids can hold any character). / 용의자 줄의 DOM id. */
export function anchorId(eventId: string): string {
  return `rc-suspect-${eventId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Date -> "YYYY-MM-DDTHH:mm" in local time for <input type="datetime-local">. / 로컬 시각 입력값. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local "YYYY-MM-DDTHH:mm" -> ISO, or null. / 로컬 입력값을 ISO로 (잘못되면 null). */
export function fromLocalInput(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) return null;
  return date.toISOString();
}

/** Local "MM/DD HH:mm". / 로컬 "월/일 시:분". */
export function localDateTime(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local "HH:mm". / 로컬 "시:분". */
export function localTime(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Short ARN tail for a resource without a name. / 이름 없는 리소스는 ARN 끝부분. */
export function arnTail(arn: string): string {
  const tail = arn.split(/[:/]/).filter(Boolean).pop();
  return tail || arn;
}

/** Incident title: resource name, ARN tail, alarm name, else "whole account". / 사건 제목. */
export function incidentName(inc: Pick<Incident, 'resourceName' | 'resourceArn' | 'signals'>, wholeAccount: string): string {
  if (inc.resourceName) return inc.resourceName;
  if (inc.resourceArn) return arnTail(inc.resourceArn);
  return inc.signals[0]?.alarmName || wholeAccount;
}
