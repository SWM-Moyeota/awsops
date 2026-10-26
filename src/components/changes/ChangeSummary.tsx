'use client';

// Change timeline header — summary sentence, description and the 3 stat cards (생성 · 삭제 · 작업한 사람).
// 변경 기록 머리 — 요약 문장, 설명, 숫자 카드 3개.
import type { ChangesResponse } from '@/lib/change-timeline/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';

interface ChangeSummaryProps {
  title: string | null;
  summary: ChangesResponse['summary'] | null;
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-2xl bg-[#151d30] p-4">
      <div className={`text-[24px] font-bold leading-tight ${tone ?? 'text-[#f2f4f6]'}`}>{value}</div>
      <div className="mt-0.5 text-[13px] text-[#6b7684]">{label}</div>
    </div>
  );
}

export default function ChangeSummary({ title, summary }: ChangeSummaryProps) {
  const { t } = useLanguage();
  return (
    <header>
      {title === null ? (
        <div className="mb-[6px] h-[70px] w-3/4 animate-pulse rounded-2xl bg-[#1a2540]" aria-hidden="true" />
      ) : (
        // Break after "생기고" like the mockup. / 시안처럼 "생기고" 뒤에서 줄바꿈.
        <h1 className="mb-[6px] whitespace-pre-line text-[26px] font-bold leading-[1.35]">
          {title.replace('생기고 ', '생기고\n')}
        </h1>
      )}
      <p className="mb-[22px] text-[15px] leading-[1.55] text-[#b0b8c1]">{t('changes.description')}</p>
      <div className="mb-[22px] flex gap-[10px]">
        <Stat value={summary ? String(summary.creates) : '–'} label={t('changes.statCreates')} tone="text-[#00d68f]" />
        <Stat value={summary ? String(summary.deletes) : '–'} label={t('changes.statDeletes')} tone="text-[#ff5f6d]" />
        <Stat value={summary ? t('changes.peopleCount', { n: summary.people }) : '–'} label={t('changes.statPeople')} />
      </div>
    </header>
  );
}
