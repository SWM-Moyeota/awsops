import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  anchorId, clampOffset, distanceLabel, formatOffset, fromLocalInput, incidentName, offsetMinutes, pathLabel, resourceLabel,
  signalLabel, toLocalInput,
} from '../format';
import type { Suspect } from '@/lib/root-cause/types';

const dir = path.resolve(__dirname, '../../../lib/i18n/translations');
const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Record<string, string>;
const ko = load('ko.json');
const en = load('en.json');
const zh = load('zh.json');

// Same interpolation as LanguageContext. / LanguageContext와 같은 보간.
const tOf = (dict: Record<string, string>) => (key: string, params?: Record<string, string | number>) => {
  let text = dict[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  return text;
};
const t = tOf(ko);
const tEn = tOf(en);

const START = '2026-10-29T06:00:00.000Z';

describe('formatOffset', () => {
  it('says N분 전 before the start', () => {
    expect(formatOffset('2026-10-29T05:48:00.000Z', START, t)).toBe('12분 전');
    expect(formatOffset('2026-10-29T05:00:00.000Z', START, t)).toBe('60분 전');
  });
  it('says N분 후 after the start', () => {
    expect(formatOffset('2026-10-29T06:02:00.000Z', START, t)).toBe('2분 후');
  });
  it('rounds to whole minutes and treats under 30 s as the start', () => {
    expect(formatOffset('2026-10-29T05:47:31.000Z', START, t)).toBe('12분 전');
    expect(formatOffset('2026-10-29T05:59:45.000Z', START, t)).toBe('시작 무렵');
    expect(formatOffset(START, START, t)).toBe('시작 무렵');
  });
  it('works in English too', () => {
    expect(formatOffset('2026-10-29T05:48:00.000Z', START, tEn)).toBe('12 min before');
    expect(formatOffset('2026-10-29T06:02:00.000Z', START, tEn)).toBe('2 min after');
  });
  it('returns an empty string for bad times', () => {
    expect(formatOffset('nope', START, t)).toBe('');
    expect(formatOffset(START, '', t)).toBe('');
  });
});

describe('offsetMinutes / clampOffset', () => {
  it('gives signed minutes from the start', () => {
    expect(offsetMinutes('2026-10-29T05:48:00.000Z', START)).toBe(-12);
    expect(offsetMinutes('2026-10-29T06:01:30.000Z', START)).toBe(1.5);
    expect(Number.isNaN(offsetMinutes('x', START))).toBe(true);
  });
  it('clamps to the -60..+5 window', () => {
    expect(clampOffset(-75)).toBe(-60);
    expect(clampOffset(9)).toBe(5);
    expect(clampOffset(-3)).toBe(-3);
  });
});

describe('signalLabel', () => {
  it('names each of the four signals', () => {
    expect(signalLabel('alb-5xx', t)).toBe('로드밸런서 5xx 급증');
    expect(signalLabel('tg-unhealthy', t)).toBe('대상 그룹 비정상');
    expect(signalLabel('ec2-status', t)).toBe('서버 상태 검사 실패');
    expect(signalLabel('alarm', t)).toBe('CloudWatch 알람');
  });
  it('falls back to the raw kind', () => {
    expect(signalLabel('weird' as never, t)).toBe('weird');
  });
});

describe('distanceLabel', () => {
  it('labels hops and the special cases', () => {
    expect(distanceLabel(0, t)).toBe('바로 그 리소스');
    expect(distanceLabel(2, t)).toBe('2단계');
    expect(distanceLabel('unconnected', t)).toBe('연결 안 됨');
    expect(distanceLabel('not-in-graph', t)).toBe('그래프에 없음');
    expect(distanceLabel('no-target', t)).toBe('모름');
    expect(distanceLabel(3, tEn)).toBe('3 hops');
  });
});

describe('local datetime input', () => {
  it('round-trips a minute-precision time', () => {
    const d = new Date('2026-10-29T06:07:00.000Z');
    const s = toLocalInput(d);
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(s)).toBe('2026-10-29T06:07:00.000Z');
  });
  it('returns null for empty or bad input', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('2026-13-99T99:99')).toBeNull();
  });
});

const suspect = (over: Partial<Suspect['proximity']> = {}, refs: Suspect['event']['refs'] = []): Suspect => ({
  event: {
    eventId: 'ab/c:1', eventName: 'RevokeSecurityGroupIngress', eventSource: 'ec2.amazonaws.com', time: START,
    accountId: '111111111111', region: 'ap-northeast-2', actor: { kind: 'person', name: 'kim' }, tool: 'console', refs, params: '{}',
  },
  proximity: { distance: 2, path: ['mo(lb)', 'tg-a(tg)', 'sg-c(sg)'], matchedArn: 'arn:aws:ec2:x:1:security-group/sg-c', ...over },
  weights: { time: 1, graph: 0.65, kind: 1 }, score: 0.65, rank: 1,
});

describe('pathLabel / resourceLabel / anchorId', () => {
  it('joins the path with arrows', () => {
    expect(pathLabel(['mo(lb)', 'tg-a(tg)'])).toBe('mo(lb) → tg-a(tg)');
    expect(pathLabel([])).toBe('');
  });
  it('uses the last path node, then the first ref, then a dash', () => {
    expect(resourceLabel(suspect())).toBe('sg-c(sg)');
    expect(resourceLabel(suspect({ path: [], matchedArn: null }, [{ type: 'sg', id: 'sg-9' }]))).toBe('sg-9');
    expect(resourceLabel(suspect({ path: [], matchedArn: null }, [{ type: null, arn: 'arn:aws:s3:::b' }]))).toBe('arn:aws:s3:::b');
    expect(resourceLabel(suspect({ path: [], matchedArn: null }))).toBe('—');
  });
  it('makes a DOM-safe anchor id', () => {
    expect(anchorId('ab/c:1')).toBe('rc-suspect-ab-c-1');
  });
});

describe('incidentName', () => {
  const sig = { kind: 'alarm' as const, accountId: '111111111111', region: 'ap-northeast-2', resourceArn: null, alarmName: 'high-cpu', startedAt: START, detail: '알람 high-cpu' };
  it('prefers the name, then the ARN tail, then the alarm name, then the fallback', () => {
    expect(incidentName({ resourceName: 'mo', resourceArn: 'arn:aws:x', signals: [] }, '계정 전체')).toBe('mo');
    expect(incidentName({ resourceName: null, resourceArn: 'arn:aws:ec2:ap-northeast-2:1:instance/i-0abc', signals: [] }, '계정 전체')).toBe('i-0abc');
    expect(incidentName({ resourceName: null, resourceArn: null, signals: [sig] }, '계정 전체')).toBe('high-cpu');
    expect(incidentName({ resourceName: null, resourceArn: null, signals: [] }, '계정 전체')).toBe('계정 전체');
  });
});

describe('rootCause i18n parity', () => {
  const keys = Object.keys(ko).filter((k) => k.startsWith('rootCause.') || k === 'sidebar.rootCause');
  it('has rootCause keys in ko.json', () => {
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain('sidebar.rootCause');
    expect(keys).toContain('rootCause.rankCaveat');
  });
  it('every ko key exists in en and zh, and no extra keys there', () => {
    for (const k of keys) {
      expect(en[k], `en ${k}`).toBeTruthy();
      expect(zh[k], `zh ${k}`).toBeTruthy();
    }
    const extra = (d: Record<string, string>) => Object.keys(d).filter((k) => (k.startsWith('rootCause.') || k === 'sidebar.rootCause') && !(k in ko));
    expect(extra(en)).toEqual([]);
    expect(extra(zh)).toEqual([]);
  });
  it('uses the agreed wording', () => {
    expect(ko['rootCause.running']).toBe('분석이 오래 걸려요. 잠시 뒤 목록에 나타나요.');
    expect(ko['rootCause.rankCaveat']).toBe('점수는 시간·그래프 거리·변경 종류로 계산한 참고 순위예요. 1위가 꼭 원인은 아니에요 — 상위 3개를 함께 보세요.');
    expect(ko['sidebar.rootCause']).toBe('장애 원인 분석');
  });
  it('labels every tool id', () => {
    for (const tool of ['console', 'cli', 'terraform', 'sdk', 'cloudformation', 'autoscaling', 'other']) {
      expect(ko[`rootCause.tool.${tool}`], tool).toBeTruthy();
    }
  });
});
