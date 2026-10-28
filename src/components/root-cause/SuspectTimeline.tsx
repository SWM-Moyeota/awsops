'use client';

// Suspects on a time axis (−60..+5 min from the start) by score, with a vertical line at the start. Click a dot to jump.
// 용의자 타임라인 — 가로 시작 기준 −60~+5분, 세로 점수, 시작 시각 세로선. 점을 누르면 표의 그 줄로 이동.
import { useMemo } from 'react';
import { CartesianGrid, Cell, ReferenceLine, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { Suspect } from '@/lib/root-cause/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import SafeResponsiveContainer from '@/components/charts/SafeResponsiveContainer';
import { clampOffset, formatOffset, offsetMinutes, WINDOW_AFTER_MIN, WINDOW_BEFORE_MIN, type T } from './format';

interface Point { x: number; y: number; rank: number; eventId: string; eventName: string; actor: string; when: string }

interface Props {
  suspects: Suspect[];
  startedAt: string;
  onPick: (eventId: string) => void;
}

const TICKS = [-60, -45, -30, -15, 0, 5];

function PointTooltip({ active, payload, t }: { active?: boolean; payload?: Array<{ payload?: Point }>; t: T }) {
  const p = active ? payload?.[0]?.payload : undefined;
  if (!p) return null;
  return (
    <div className="rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-xs shadow-xl">
      <div className="font-semibold text-white">#{p.rank} {p.eventName}</div>
      <div className="text-gray-400">{p.when} · {p.actor}</div>
      <div className="font-mono text-gray-300">{t('rootCause.col.score')} {p.y.toFixed(2)}</div>
    </div>
  );
}

export default function SuspectTimeline({ suspects, startedAt, onPick }: Props) {
  const { t } = useLanguage();
  const points = useMemo<Point[]>(() => suspects.flatMap((s) => {
    const m = offsetMinutes(s.event.time, startedAt);
    if (Number.isNaN(m)) return [];
    return [{
      x: clampOffset(m), y: s.score, rank: s.rank, eventId: s.event.eventId, eventName: s.event.eventName,
      actor: s.event.actor.name, when: formatOffset(s.event.time, startedAt, t),
    }];
  }), [suspects, startedAt, t]);

  if (points.length === 0) return null;
  const yMax = Math.max(0.1, ...points.map((p) => p.y));

  return (
    <div className="h-56 w-full">
      <SafeResponsiveContainer>
        <ScatterChart margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="#1a2540" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="x"
            domain={[-WINDOW_BEFORE_MIN, WINDOW_AFTER_MIN]}
            ticks={TICKS}
            tickFormatter={(v: number) => (v === 0 ? t('rootCause.timeline.start') : v > 0 ? `+${v}` : String(v))}
            tick={{ fill: '#6b7280', fontSize: 11 }}
            axisLine={{ stroke: '#1a2540' }}
            tickLine={false}
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[0, Math.min(1, Math.ceil(yMax * 10) / 10)]}
            tick={{ fill: '#6b7280', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <ReferenceLine x={0} stroke="#ef4444" strokeDasharray="4 3" />
          <Tooltip cursor={false} content={<PointTooltip t={t} />} />
          <Scatter
            data={points}
            onClick={(d: unknown) => {
              const p = (d as { payload?: Point } | undefined)?.payload ?? (d as Point | undefined);
              if (p?.eventId) onPick(p.eventId);
            }}
            className="cursor-pointer"
          >
            {points.map((p) => <Cell key={p.eventId} fill={p.rank <= 3 ? '#f59e0b' : '#00d4ff'} />)}
          </Scatter>
        </ScatterChart>
      </SafeResponsiveContainer>
    </div>
  );
}
