'use client';

// Incident detail: summary card, cited AI explanation (only when verified), suspect table, timeline.
// 사건 상세 — 사건 카드, 인용 검증된 AI 설명(검증된 경우만), 용의자 표, 타임라인.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Incident } from '@/lib/root-cause/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import SuspectTable from './SuspectTable';
import SuspectTimeline from './SuspectTimeline';
import { anchorId, formatOffset, incidentName, localDateTime, localTime, signalLabel } from './format';

const HIGHLIGHT_MS = 2500;
const CONF_COLOR = { high: 'text-accent-red', medium: 'text-accent-orange', low: 'text-gray-400' } as const;

interface Props {
  incident: Incident;
  accountLabel: string;
}

export default function IncidentDetail({ incident, accountLabel }: Props) {
  const { t } = useLanguage();
  const [highlight, setHighlight] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { setHighlight(null); }, [incident.id]);

  // Scroll to the cited suspect row and flash it. / 인용한 용의자 줄로 이동하고 잠깐 강조한다.
  const jump = useCallback((eventId: string) => {
    setHighlight(eventId);
    document.getElementById(anchorId(eventId))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  }, []);

  const a = incident.analysis;
  const ai = a?.ai;
  const bySuspect = new Map((a?.suspects ?? []).map((s) => [s.event.eventId, s]));

  return (
    <div className="space-y-4">
      {/* Incident card / 사건 카드 */}
      <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-white">{incidentName(incident, t('rootCause.detail.wholeAccount'))}</h2>
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${incident.status === 'open' ? 'bg-accent-orange/15 text-accent-orange' : 'bg-accent-green/10 text-accent-green'}`}>
            {t(incident.status === 'open' ? 'rootCause.status.open' : 'rootCause.status.resolved')}
          </span>
          <span className="rounded bg-navy-600 px-1.5 py-0.5 text-[10px] text-gray-300">{t(`rootCause.source.${incident.source}`)}</span>
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-gray-500">{t('rootCause.detail.signals')}</dt>
            <dd className="mt-0.5 space-y-0.5 text-gray-200">
              {incident.signals.length === 0 && <div>{t('rootCause.detail.manualSignal')}</div>}
              {incident.signals.map((s, i) => (
                <div key={`${s.kind}-${s.resourceArn ?? s.alarmArn ?? i}`}>
                  {signalLabel(s.kind, t)} <span className="text-gray-500">· {s.detail} · {localTime(s.startedAt)}</span>
                </div>
              ))}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">{t('rootCause.detail.startedAt')}</dt>
            <dd className="mt-0.5 text-gray-200">{localDateTime(incident.startedAt)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-gray-500">{t('rootCause.detail.resource')}</dt>
            <dd className="mt-0.5 break-all font-mono text-[11px] text-gray-300">{incident.resourceArn ?? t('rootCause.detail.wholeAccount')}</dd>
          </div>
          <div>
            <dt className="text-gray-500">{t('rootCause.detail.account')}</dt>
            <dd className="mt-0.5 text-gray-200">{accountLabel} · {incident.region}</dd>
          </div>
        </dl>
        {a && (
          <div className="mt-3 space-y-0.5 border-t border-navy-600 pt-3 text-[11px] text-gray-400">
            <p>
              {a.graph.from && a.graph.to
                ? t('rootCause.graphBasis', { from: localTime(a.graph.from), to: localTime(a.graph.to), count: a.graph.count })
                : t('rootCause.graphBasisCurrent')}
            </p>
            <p>{t('rootCause.detail.window', { from: localTime(a.windowFrom), to: localTime(a.windowTo), n: a.eventsSeen })}</p>
            {a.truncated && <p className="text-accent-orange">{t('rootCause.detail.truncated')}</p>}
            {a.failedRegions.length > 0 && <p className="text-accent-orange">{t('rootCause.detail.failedRegions', { regions: a.failedRegions.join(', ') })}</p>}
          </div>
        )}
      </section>

      {!a && (
        <p className="rounded-lg border border-accent-cyan/30 bg-accent-cyan/10 px-4 py-3 text-sm text-accent-cyan">{t('rootCause.detail.pending')}</p>
      )}

      {/* AI explanation — verified only / AI 설명 — 검증된 경우만 */}
      {ai?.status === 'ok' && (
        <section className="rounded-lg border border-accent-purple/30 bg-navy-800 p-4">
          <h3 className="text-sm font-semibold text-white">{t('rootCause.ai.title')}</h3>
          {ai.summary && <p className="mt-2 text-sm leading-relaxed text-gray-200">{ai.summary}</p>}
          {(ai.causes ?? []).length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] text-gray-500">{t('rootCause.ai.causes')}</div>
              <ul className="mt-1 space-y-2">
                {(ai.causes ?? []).map((c) => {
                  const s = bySuspect.get(c.eventId);
                  return (
                    <li key={c.eventId} className="text-xs text-gray-300">
                      <button
                        type="button"
                        onClick={() => jump(c.eventId)}
                        title={t('rootCause.ai.jump')}
                        className="mr-2 inline-flex items-center gap-1 rounded-full border border-accent-cyan/40 bg-accent-cyan/10 px-2 py-0.5 font-mono text-[11px] text-accent-cyan hover:bg-accent-cyan/20"
                      >
                        {s ? `#${s.rank} ${s.event.eventName}` : c.eventId.slice(0, 12)}
                        {s && <span className="text-accent-cyan/70">· {formatOffset(s.event.time, incident.startedAt, t)}</span>}
                      </button>
                      <span className={`mr-1 text-[10px] ${CONF_COLOR[c.confidence] ?? 'text-gray-400'}`}>{t(`rootCause.ai.confidence.${c.confidence}`)}</span>
                      {c.reason}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {(ai.checks ?? []).length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] text-gray-500">{t('rootCause.ai.checks')}</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-gray-300">
                {(ai.checks ?? []).map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-500">
            <ShieldCheck size={12} className="text-accent-green" />
            {t('rootCause.ai.grounded')}
            {ai.droppedCitations > 0 && <span className="text-accent-orange">· {t('rootCause.ai.dropped', { n: ai.droppedCitations })}</span>}
          </p>
        </section>
      )}
      {(ai?.status === 'unverified' || ai?.status === 'failed') && (
        <p className="rounded-lg border border-navy-600 bg-navy-900 px-4 py-3 text-xs text-gray-500">{t('rootCause.aiHidden')}</p>
      )}
      {ai?.status === 'skipped' && (
        <p className="rounded-lg border border-navy-600 bg-navy-900 px-4 py-3 text-xs text-gray-500">{t('rootCause.aiSkipped')}</p>
      )}

      {/* Suspects / 용의자 */}
      {a && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-white">{t('rootCause.suspects.title')}</h3>
          <SuspectTable suspects={a.suspects} startedAt={incident.startedAt} highlightId={highlight} />
          <p className="text-[11px] text-gray-500">{t('rootCause.rankCaveat')}</p>
        </section>
      )}

      {a && a.suspects.length > 0 && (
        <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
          <h3 className="text-sm font-semibold text-white">{t('rootCause.timeline.title')}</h3>
          <p className="mb-2 text-[11px] text-gray-500">{t('rootCause.timeline.hint')}</p>
          <SuspectTimeline suspects={a.suspects} startedAt={incident.startedAt} onPick={jump} />
        </section>
      )}
    </div>
  );
}
