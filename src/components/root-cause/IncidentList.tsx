'use client';

// Incident list: signal icon, resource, start time, status, top suspect in one line.
// 사건 목록 — 신호 아이콘, 리소스, 시작 시각, 상태, 1위 용의자 한 줄.
import { AlertTriangle, Bell, HeartPulse, Search, Server, type LucideIcon } from 'lucide-react';
import type { Incident, SignalKind } from '@/lib/root-cause/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { formatOffset, incidentName, localDateTime, signalLabel } from './format';

const ICONS: Record<SignalKind, LucideIcon> = { 'alb-5xx': AlertTriangle, 'tg-unhealthy': HeartPulse, 'ec2-status': Server, alarm: Bell };

interface Props {
  incidents: Incident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function IncidentList({ incidents, selectedId, onSelect }: Props) {
  const { t } = useLanguage();

  if (incidents.length === 0) {
    return (
      <div className="rounded-lg border border-navy-600 bg-navy-800 px-4 py-10 text-center">
        <p className="text-sm font-semibold text-white">{t('rootCause.list.empty')}</p>
        <p className="mt-1 text-xs text-gray-500">{t('rootCause.list.emptyHint')}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2" aria-label={t('rootCause.list.title')}>
      {incidents.map((inc) => {
        const kind = inc.signals[0]?.kind;
        const Icon = kind ? ICONS[kind] ?? Search : Search;
        const top = inc.analysis?.suspects[0];
        const selected = inc.id === selectedId;
        const open = inc.status === 'open';
        return (
          <li key={inc.id}>
            <button
              type="button"
              onClick={() => onSelect(inc.id)}
              aria-current={selected ? 'true' : undefined}
              className={`w-full rounded-lg border bg-navy-800 p-3 text-left transition-colors ${selected ? 'border-accent-cyan' : 'border-navy-600 hover:border-navy-500'}`}
            >
              <div className="flex items-start gap-2.5">
                <span className={`mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-full ${open && inc.source === 'auto' ? 'bg-accent-red/15 text-accent-red' : 'bg-navy-600 text-gray-300'}`}>
                  <Icon size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-white">{incidentName(inc, t('rootCause.detail.wholeAccount'))}</span>
                    <span className={`flex-none rounded px-1.5 py-0.5 text-[10px] ${open ? 'bg-accent-orange/15 text-accent-orange' : 'bg-accent-green/10 text-accent-green'}`}>
                      {t(open ? 'rootCause.status.open' : 'rootCause.status.resolved')}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-gray-400">
                    {kind ? signalLabel(kind, t) : t('rootCause.source.manual')}
                    {inc.signals.length > 1 ? ` +${inc.signals.length - 1}` : ''} · {localDateTime(inc.startedAt)}
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-gray-500">
                    {!inc.analysis
                      ? t('rootCause.list.pending')
                      : top
                        ? `${t('rootCause.list.top')} · ${formatOffset(top.event.time, inc.startedAt, t)} ${top.event.eventName} · ${top.event.actor.name}`
                        : t('rootCause.list.noSuspect')}
                  </span>
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
