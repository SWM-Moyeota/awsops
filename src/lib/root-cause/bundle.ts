// Evidence bundle: packs top suspects into a capped Korean text for the AI.
// 근거 묶음 — 상위 용의자를 상한이 있는 한국어 텍스트로 묶어 AI에 넘긴다.
import type { Signal, Suspect } from './types';

const SECRET_KEY = /password|secret|token|credential|privatekey/i;
const DROP_KEY = /^(sourceipaddress|useragent)$/i;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g;

// Scrub secrets, IPs, user agents, access keys from a params string. / 파라미터 문자열에서 비밀·IP·UA·키 제거.
function scrubValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (DROP_KEY.test(k)) continue;
      out[k] = SECRET_KEY.test(k) ? '[숨김]' : scrubValue(val);
    }
    return out;
  }
  if (typeof v === 'string') return v.replace(ACCESS_KEY, '[숨김]');
  return v;
}
// Fallback for invalid/truncated JSON: regex-mask pairs. / 잘리거나 깨진 JSON용 정규식 대체 처리.
const VAL = '("(?:[^"\\\\]|\\\\.)*"?|[^,}\\s]*)';
const DROP_PAIR = new RegExp('"?(?:useragent|sourceipaddress)"?\\s*[:=]\\s*' + VAL + '\\s*,?', 'gi');
const SECRET_PAIR = new RegExp('("?[\\w-]*(?:password|secret|token|credential|privatekey)[\\w-]*"?)\\s*[:=]\\s*' + VAL, 'gi');
function scrubText(t: string): string {
  return t.replace(DROP_PAIR, '').replace(SECRET_PAIR, '$1:"[숨김]"').replace(ACCESS_KEY, '[숨김]');
}
export function scrubParams(params: string): string {
  let s: string;
  try { s = JSON.stringify(scrubValue(JSON.parse(params))); } catch { s = scrubText(params); }
  return s.replace(IPV4, '[IP]').replace(/useragent|sourceipaddress/gi, '[숨김]');
}

function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }

function minutes(startedAt: string, time: string): string {
  const d = Math.round((new Date(startedAt).getTime() - new Date(time).getTime()) / 60000);
  return d >= 0 ? `시작 ${d}분 전` : `시작 ${-d}분 후`;
}

function suspectBlock(s: Suspect, startedAt: string, paramsMax: number): string {
  const e = s.event;
  const refs = e.refs.map(r => r.id || r.arn || '?').join(', ') || '-';
  const path = s.proximity.path.length ? s.proximity.path.join(' → ') : String(s.proximity.distance);
  const w = s.weights;
  return [
    `[${e.eventId}] ${minutes(startedAt, e.time)} ${e.eventName}`,
    `  행위자: ${e.actor.name} (${e.tool})`,
    `  리소스: ${refs}`,
    `  경로: ${path}`,
    `  점수: 시간 ${w.time.toFixed(2)} / 그래프 ${w.graph.toFixed(2)} / 종류 ${w.kind.toFixed(2)} = ${s.score.toFixed(2)}`,
    `  파라미터: ${clip(scrubParams(e.params), paramsMax)}`,
  ].join('\n');
}

export function buildBundle(
  ctx: { signals: Signal[]; resourceName: string | null; startedAt: string; graph: { from: string | null; to: string | null } },
  suspects: Suspect[],
  opts: { top?: number; maxChars?: number } = {},
): { text: string; eventIds: string[] } {
  const max = opts.maxChars ?? 24000;
  let list = suspects.slice(0, opts.top ?? 8);
  const head = [
    '## 사건',
    `리소스: ${ctx.resourceName ?? '(알 수 없음)'}`,
    `시작: ${ctx.startedAt}`,
    `신호: ${ctx.signals.map(s => `${s.kind} ${s.detail}`).join(' | ') || '-'}`,
    `그래프 기준: ${ctx.graph.from ?? '-'} ~ ${ctx.graph.to ?? '-'}`,
    '## 용의자',
  ].join('\n');
  const render = (n: number, lim: number[]) => head + '\n' + list.slice(0, n).map((s, i) => suspectBlock(s, ctx.startedAt, lim[i])).join('\n');
  const lim = list.map(() => 600);
  let n = list.length;
  // shorten params bottom-up to 120 / 아래 순위부터 파라미터를 120자로 줄임
  for (let i = list.length - 1; i >= 0 && render(n, lim).length > max; i--) lim[i] = 120;
  // then drop suspects from the bottom / 그래도 넘치면 아래 용의자부터 뺀다
  while (n > 0 && render(n, lim).length > max) n--;
  list = list.slice(0, n);
  const text = n === 0 ? '' : render(n, lim);
  return { text, eventIds: list.map(s => s.event.eventId) };
}
