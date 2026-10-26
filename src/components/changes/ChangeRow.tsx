'use client';

// One change as a Toss-style row: round service icon, "**name**님이 … 만들었어요", sub line, chevron.
// 변경 한 건 — 동그란 서비스 아이콘, 문장, 아래 줄(태그 · 이름 · 도구 · 시각), 오른쪽 ›.
import type { ChangeRecord } from '@/lib/change-timeline/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { kstTime, resourceEmoji, sentence, toolLabel } from './format';

/** Icon background: grey for auto/AWSops, else green (create) or red (delete). / 자동은 회색, 생성 초록, 삭제 빨강. */
export function iconTone(r: ChangeRecord): string {
  if (r.actor.kind === 'auto' || r.actor.kind === 'awsops') return 'bg-[#1a2540]';
  return r.kind === 'delete' ? 'bg-[rgba(255,95,109,0.14)]' : 'bg-[rgba(0,214,143,0.14)]';
}

export function KindTag({ kind }: { kind: ChangeRecord['kind'] }) {
  const { t } = useLanguage();
  return (
    <span
      className={`mr-1 inline-block rounded-[6px] px-[7px] py-[3px] text-[12px] font-bold leading-none ${
        kind === 'delete' ? 'bg-[rgba(255,95,109,0.14)] text-[#ff5f6d]' : 'bg-[rgba(0,214,143,0.14)] text-[#00d68f]'
      }`}
    >
      {t(kind === 'delete' ? 'changes.kindDelete' : 'changes.kindCreate')}
    </span>
  );
}

export function RoundIcon({ record, size = 42 }: { record: ChangeRecord; size?: 42 | 36 }) {
  return (
    <div
      aria-hidden="true"
      className={`grid flex-none place-items-center rounded-full ${iconTone(record)} ${
        size === 42 ? 'h-[42px] w-[42px] text-[19px]' : 'h-9 w-9 text-[16px]'
      }`}
    >
      {resourceEmoji(record.resourceType)}
    </div>
  );
}

export default function ChangeRow({ record, onOpen }: { record: ChangeRecord; onOpen: (r: ChangeRecord) => void }) {
  const { t } = useLanguage();
  const { who, rest } = sentence(record);
  const sub = [record.resourceName || record.resourceId, toolLabel(record.tool, record.via), kstTime(record.time)]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      onClick={() => onOpen(record)}
      aria-label={`${who}${rest} — ${t('changes.openDetail')}`}
      className="-mx-3 flex w-[calc(100%+24px)] items-center gap-[14px] rounded-2xl px-3 py-[13px] text-left transition-colors hover:bg-[#151d30] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4593fc]"
    >
      <RoundIcon record={record} />
      <div className="min-w-0 flex-1">
        <div className="text-[16px] font-semibold leading-[1.4] text-[#f2f4f6]">
          <b className="font-bold">{who}</b>{rest}
        </div>
        <div className="mt-0.5 truncate text-[13px] text-[#6b7684]">
          <KindTag kind={record.kind} />{sub}
        </div>
      </div>
      <span aria-hidden="true" className="flex-none text-[18px] text-[#6b7684]">›</span>
    </button>
  );
}
