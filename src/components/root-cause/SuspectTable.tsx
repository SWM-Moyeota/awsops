'use client';

// Ranked suspects: rank, offset from the start, event, actor (tool), resource, graph path, score with three bars.
// 용의자 표 — 순위, 시작 기준 시각, 이벤트, 누가(도구), 리소스, 그래프 경로, 점수와 세 값 막대.
import type { Suspect } from '@/lib/root-cause/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { anchorId, distanceLabel, formatOffset, pathLabel, resourceLabel } from './format';

const BARS = [
  { key: 'time', color: '#00d4ff' },
  { key: 'graph', color: '#a855f7' },
  { key: 'kind', color: '#f59e0b' },
] as const;

interface Props {
  suspects: Suspect[];
  startedAt: string;
  highlightId: string | null;
}

export default function SuspectTable({ suspects, startedAt, highlightId }: Props) {
  const { t } = useLanguage();

  if (suspects.length === 0) {
    return <p className="rounded-lg border border-navy-600 bg-navy-900 px-4 py-6 text-center text-sm text-gray-500">{t('rootCause.suspects.empty')}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-navy-600">
      <table className="w-full min-w-[860px] text-left text-xs">
        <thead className="bg-navy-700 text-[11px] text-gray-400">
          <tr>
            <th className="px-3 py-2 font-medium">{t('rootCause.col.rank')}</th>
            <th className="px-3 py-2 font-medium">{t('rootCause.col.time')}</th>
            <th className="px-3 py-2 font-medium">{t('rootCause.col.event')}</th>
            <th className="px-3 py-2 font-medium">{t('rootCause.col.actor')}</th>
            <th className="px-3 py-2 font-medium">{t('rootCause.col.resource')}</th>
            <th className="px-3 py-2 font-medium">{t('rootCause.col.path')}</th>
            <th className="px-3 py-2 font-medium">{t('rootCause.col.score')}</th>
          </tr>
        </thead>
        <tbody>
          {suspects.map((s) => {
            const lit = highlightId === s.event.eventId;
            const top3 = s.rank <= 3;
            return (
              <tr
                key={s.event.eventId}
                id={anchorId(s.event.eventId)}
                className={`border-t border-navy-600 align-top transition-colors ${lit ? 'bg-accent-cyan/10' : 'bg-navy-800'}`}
              >
                <td className="px-3 py-2">
                  <span className={`inline-grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold ${top3 ? 'bg-accent-orange/20 text-accent-orange' : 'bg-navy-600 text-gray-300'}`}>
                    {s.rank}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-gray-300">{formatOffset(s.event.time, startedAt, t)}</td>
                <td className="px-3 py-2">
                  <div className="font-mono text-gray-100">{s.event.eventName}</div>
                  <div className="text-[10px] text-gray-500">{s.event.eventSource.replace('.amazonaws.com', '')} · {s.event.region}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="text-gray-200">{s.event.actor.name}</div>
                  <div className="text-[10px] text-gray-500">{t(`rootCause.tool.${s.event.tool}`)}</div>
                </td>
                <td className="max-w-[180px] break-all px-3 py-2 text-gray-300">{resourceLabel(s)}</td>
                <td className="max-w-[240px] px-3 py-2">
                  <div className="text-gray-300">{distanceLabel(s.proximity.distance, t)}</div>
                  {s.proximity.path.length > 1 && <div className="break-all text-[10px] text-gray-500">{pathLabel(s.proximity.path)}</div>}
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono text-sm font-semibold text-white">{s.score.toFixed(2)}</div>
                  <div className="mt-1 space-y-0.5">
                    {BARS.map((b) => {
                      const v = s.weights[b.key];
                      return (
                        <div key={b.key} className="flex items-center gap-1.5" title={`${t(`rootCause.weight.${b.key}`)} ${v.toFixed(2)}`}>
                          <span className="w-8 text-[10px] text-gray-500">{t(`rootCause.weight.${b.key}`)}</span>
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-navy-600">
                            <span className="block h-full rounded-full" style={{ width: `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`, background: b.color }} />
                          </span>
                          <span className="w-7 text-right font-mono text-[10px] text-gray-400">{v.toFixed(2)}</span>
                        </div>
                      );
                    })}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
