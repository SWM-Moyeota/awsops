'use client';

// Change detail — KST time, person, tool, IP, region, account, resource, console link and the other
// records for the same resource (fetched lazily over all time). Read-only: nothing here changes AWS.
// 변경 상세 — 시각(KST)·사람·도구·IP·리전·계정·리소스·콘솔 링크·같은 리소스의 다른 기록(전체 기간 지연 조회).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { ChangeRecord, ChangesResponse } from '@/lib/change-timeline/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { consoleUrl, kstDate, kstDateTime, kstTime, resourceTypeLabel, sentence, toolLabel } from './format';
import { KindTag, RoundIcon } from './ChangeRow';

interface ChangeDetailPanelProps {
  record: ChangeRecord;
  accountLabel: string;
  onSelect: (r: ChangeRecord) => void;
  onClose: () => void;
}

type Related = { status: 'loading' } | { status: 'error' } | { status: 'done'; records: ChangeRecord[] };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="flex-none text-[14px] text-[#6b7684]">{label}</dt>
      <dd className="min-w-0 break-all text-right text-[15px] text-[#f2f4f6]">{children}</dd>
    </div>
  );
}

export default function ChangeDetailPanel({ record: r, accountLabel, onSelect, onClose }: ChangeDetailPanelProps) {
  const { t } = useLanguage();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [related, setRelated] = useState<Related>({ status: 'loading' });
  const { who, rest } = sentence(r);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Same resource over all time, so a create shows its delete even outside the current filters.
  // 현재 필터와 상관없이 전체 기간에서 같은 리소스 기록을 찾는다.
  useEffect(() => {
    const ctrl = new AbortController();
    setRelated({ status: 'loading' });
    const qs = new URLSearchParams({ accountId: r.accountId, range: 'all', q: r.resourceId });
    fetch(`/api/changes?${qs}`, { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as ChangesResponse | null;
        if (!res.ok || !body || !Array.isArray(body.records)) throw new Error(`HTTP ${res.status}`);
        const same = body.records.filter((x) => x.id !== r.id && x.resourceId === r.resourceId && x.resourceType === r.resourceType);
        setRelated({ status: 'done', records: same });
      })
      .catch(() => { if (!ctrl.signal.aborted) setRelated({ status: 'error' }); });
    return () => ctrl.abort();
  }, [r.id, r.accountId, r.resourceId, r.resourceType]);

  const url = consoleUrl(r);
  const gone = r.kind === 'delete'
    || (related.status === 'done' && related.records.some((x) => x.kind === 'delete' && x.time > r.time));
  const actorNote = r.actor.kind === 'auto' ? t('changes.detail.actorAuto')
    : r.actor.kind === 'awsops' ? t('changes.detail.actorAwsops')
    : r.actor.kind === 'root' ? t('changes.detail.actorRoot')
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-stretch sm:justify-end" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('changes.detail.title')}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] w-full overflow-y-auto rounded-t-[24px] bg-[#0f1629] px-6 pb-8 pt-6 text-[#f2f4f6] shadow-2xl sm:max-h-none sm:max-w-[440px] sm:rounded-none sm:rounded-l-[24px]"
      >
        <div className="mb-5 flex items-start gap-[14px]">
          <RoundIcon record={r} />
          <div className="min-w-0 flex-1">
            <div className="text-[18px] font-semibold leading-[1.4]"><b className="font-bold">{who}</b>{rest}</div>
            <div className="mt-1 text-[13px] text-[#6b7684]"><KindTag kind={r.kind} />{resourceTypeLabel(r.resourceType)}</div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('changes.detail.close')}
            className="flex-none rounded-full p-2 text-[#6b7684] hover:bg-[#151d30] hover:text-[#f2f4f6] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4593fc]"
          >
            <X size={18} />
          </button>
        </div>

        <dl className="divide-y divide-[#1a2540] rounded-[24px] bg-[#151d30] px-5 py-1">
          <Field label={t('changes.detail.time')}>{kstDateTime(r.time)} (KST)</Field>
          <Field label={t('changes.detail.person')}>
            {r.actor.name}
            {actorNote && <span className="ml-1 text-[#6b7684]">· {actorNote}</span>}
          </Field>
          {r.actor.sourceIdentity && <Field label={t('changes.detail.sourceIdentity')}>{r.actor.sourceIdentity}</Field>}
          <Field label={t('changes.detail.tool')}>{toolLabel(r.tool, r.via)}</Field>
          <Field label={t('changes.detail.ip')}>{r.sourceIp || '–'}</Field>
          <Field label={t('changes.detail.region')}>{r.region}</Field>
          <Field label={t('changes.detail.account')}>{accountLabel}</Field>
          <Field label={t('changes.detail.resourceName')}>{r.resourceName || '–'}</Field>
          {r.resourceId !== r.resourceName && <Field label={t('changes.detail.resourceId')}>{r.resourceId}</Field>}
          <Field label={t('changes.detail.event')}>{r.eventName}</Field>
        </dl>

        {url && !gone && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 flex items-center justify-center gap-2 rounded-[14px] bg-[rgba(69,147,252,0.14)] px-4 py-[13px] text-[15px] font-semibold text-[#4593fc] hover:bg-[rgba(69,147,252,0.22)]"
          >
            {t('changes.detail.console')} <ExternalLink size={15} aria-hidden="true" />
          </a>
        )}
        {url && gone && <p className="mt-4 text-center text-[13px] text-[#6b7684]">{t('changes.detail.gone')}</p>}

        <h2 className="mb-1 mt-7 text-[13px] font-semibold text-[#6b7684]">{t('changes.detail.related')}</h2>
        {related.status === 'loading' && <p className="py-3 text-[14px] text-[#6b7684]">{t('changes.detail.relatedLoading')}</p>}
        {related.status === 'error' && <p className="py-3 text-[14px] text-[#ff5f6d]">{t('changes.detail.relatedFailed')}</p>}
        {related.status === 'done' && related.records.length === 0 && (
          <p className="py-3 text-[14px] text-[#6b7684]">{t('changes.detail.relatedNone')}</p>
        )}
        {related.status === 'done' && related.records.map((x) => {
          const s = sentence(x);
          return (
            <button
              key={x.id}
              type="button"
              onClick={() => onSelect(x)}
              className="-mx-3 flex w-[calc(100%+24px)] items-center gap-3 rounded-2xl px-3 py-[10px] text-left hover:bg-[#151d30] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4593fc]"
            >
              <RoundIcon record={x} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-semibold"><b className="font-bold">{s.who}</b>{s.rest}</div>
                <div className="mt-0.5 truncate text-[13px] text-[#6b7684]">
                  <KindTag kind={x.kind} />{kstDate(x.time)} {kstTime(x.time)} · {toolLabel(x.tool, x.via)}
                </div>
              </div>
              <span aria-hidden="true" className="flex-none text-[18px] text-[#6b7684]">›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
