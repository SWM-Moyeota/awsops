'use client';

// Cost Radar recommendation detail — reason, creator (lazy), tags, owner warning, copyable CLI (or a
// scheduling guide when there is no command), console link.
// Guidance only: there is deliberately no button that changes an AWS resource.
// 비용 레이더 추천 상세 — 이유, 만든 사람(지연 조회), 태그, 확인 안내, 복사용 CLI, 콘솔 링크.
// 안내만 한다: AWS 리소스를 바꾸는 버튼은 의도적으로 없다.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, User, X } from 'lucide-react';
import type { CreatorInfo, Recommendation } from '@/lib/cost-radar/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { DISPLAY_FONT, PALETTE, formatMoney, noteKey, reasonParams } from './format';
import { RULE_ICONS } from './SavingsCard';

export type CreatorState = { status: 'loading' } | { status: 'error' } | { status: 'done'; info: CreatorInfo };

interface RecommendationPanelProps {
  rec: Recommendation;
  creator: CreatorState | undefined;
  accountLabel: string;
  onClose: () => void;
}

const PRIORITY_TAGS = ['Name', 'Owner', 'Project', 'Team'];
const SCHEDULER_DOCS = 'https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html';

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export default function RecommendationPanel({ rec, creator, accountLabel, onClose }: RecommendationPanelProps) {
  const { t } = useLanguage();
  const [copy, setCopy] = useState<'idle' | 'ok' | 'fail'>('idle');
  const closeRef = useRef<HTMLButtonElement>(null);
  const Icon = RULE_ICONS[rec.rule];
  const note = noteKey(rec.note);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(rec.cliCommand);
      setCopy('ok');
    } catch {
      setCopy('fail');
    }
    setTimeout(() => setCopy('idle'), 2500);
  };

  const tagEntries = Object.entries(rec.tags || {}).sort(([a], [b]) => {
    const ia = PRIORITY_TAGS.indexOf(a), ib = PRIORITY_TAGS.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  let creatorText: string;
  if (!creator || creator.status === 'loading') creatorText = t('costRadar.creator.checking');
  else if (creator.status === 'error') creatorText = t('costRadar.creator.failed');
  else if (creator.info.status === 'found' && creator.info.user) {
    const when = fmtTime(creator.info.eventTime);
    creatorText = when ? `${creator.info.user} · ${when}` : creator.info.user;
  } else creatorText = t('costRadar.creator.unknown');

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t(`costRadar.rule.${rec.rule}.title`)}
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-[26px] p-5 sm:rounded-[26px] sm:p-6"
        style={{ background: PALETTE.card, color: PALETTE.text }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full" style={{ background: PALETTE.lime, color: '#111' }}>
            <Icon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg leading-tight" style={DISPLAY_FONT}>{t(`costRadar.rule.${rec.rule}.title`)}</h3>
            <p className="mt-1 break-all font-mono text-xs" style={{ color: PALETTE.muted }}>{rec.resourceId}</p>
            <p className="text-xs" style={{ color: PALETTE.muted }}>{accountLabel} · {rec.region}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t('costRadar.close')} className="rounded-full p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-baseline gap-2">
          <span className={`text-2xl ${rec.countedInTotal ? '' : 'line-through opacity-60'}`} style={{ ...DISPLAY_FONT, color: PALETTE.lime }}>
            {rec.monthlySaving > 0 ? '-' : ''}{formatMoney(rec.monthlySaving)}
          </span>
          <span className="text-xs" style={{ color: PALETTE.muted }}>{t('costRadar.perMonthSuffix')}</span>
          {!rec.countedInTotal && (
            <span className="rounded-md px-1.5 py-0.5 text-[10px] font-bold" style={{ background: PALETTE.line, color: PALETTE.muted }}>{t('costRadar.notCounted')}</span>
          )}
        </div>

        <section className="mt-4">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: PALETTE.muted }}>{t('costRadar.panel.reason')}</h4>
          <p className="text-sm">{t(`costRadar.rule.${rec.rule}.reason`, reasonParams(rec))}</p>
          {note && <p className="mt-1 text-sm" style={{ color: PALETTE.orange }}>{t(note)}</p>}
        </section>

        <section className="mt-4">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: PALETTE.muted }}>{t('costRadar.panel.creator')}</h4>
          <p className="flex items-center gap-2 text-sm" aria-live="polite">
            <User size={14} className="flex-none text-gray-400" />
            <span className={!creator || creator.status === 'loading' ? 'animate-pulse text-gray-400' : ''}>{creatorText}</span>
          </p>
        </section>

        {tagEntries.length > 0 && (
          <section className="mt-4">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: PALETTE.muted }}>{t('costRadar.panel.tags')}</h4>
            <div className="flex flex-wrap gap-1.5">
              {tagEntries.slice(0, 16).map(([k, v]) => (
                <span key={k} className="max-w-full truncate rounded-md px-2 py-0.5 text-[11px]" style={{ background: PALETTE.line }}>
                  <span style={{ color: PALETTE.muted }}>{k}</span>{v ? `: ${v}` : ''}
                </span>
              ))}
            </div>
          </section>
        )}

        <div className="mt-4 flex items-start gap-2 rounded-2xl px-3 py-2.5 text-sm" style={{ background: '#2b2110', color: PALETTE.orange }}>
          <AlertTriangle size={16} className="mt-0.5 flex-none" />
          <span>{t('costRadar.confirmOwner')}</span>
        </div>

        {!rec.cliCommand ? (
          <section className="mt-4 rounded-2xl p-3 text-sm" style={{ background: PALETTE.bg }}>
            <p className="text-gray-200">{t('costRadar.officeHoursGuide')}</p>
            <a
              href={SCHEDULER_DOCS}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold hover:underline"
              style={{ color: PALETTE.sky }}
            >
              EventBridge Scheduler <ExternalLink size={12} />
            </a>
          </section>
        ) : (
          <section className="mt-4">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide" style={{ color: PALETTE.muted }}>{t('costRadar.panel.cli')}</h4>
            <div className="rounded-2xl p-3" style={{ background: PALETTE.bg }}>
              <pre className="whitespace-pre-wrap break-all font-mono text-xs text-gray-200">{rec.cliCommand}</pre>
              <div className="mt-2 flex items-center justify-end gap-2">
                {copy === 'fail' && <span className="text-xs" style={{ color: PALETTE.pink }}>{t('costRadar.copyFailed')}</span>}
                <button
                  type="button"
                  onClick={doCopy}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold"
                  style={{ background: PALETTE.line, color: copy === 'ok' ? PALETTE.lime : PALETTE.text }}
                >
                  {copy === 'ok' ? <Check size={13} /> : <Copy size={13} />}
                  {copy === 'ok' ? t('costRadar.copied') : t('costRadar.copy')}
                </button>
              </div>
            </div>
          </section>
        )}

        <a
          href={rec.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold hover:underline"
          style={{ color: PALETTE.sky }}
        >
          {t('costRadar.openConsole')} <ExternalLink size={14} />
        </a>
      </div>
    </div>
  );
}
