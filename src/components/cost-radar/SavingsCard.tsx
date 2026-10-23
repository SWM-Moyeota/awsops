'use client';

// Cost Radar savings card — one pill card per recommendation; click opens the detail panel (guidance only).
// 비용 레이더 절약 카드 — 추천 1건당 알약 카드, 누르면 상세 패널을 연다 (안내만, 실행 없음).
import { AlarmClock, Camera, HardDrive, MapPin, Moon, Scale, Sparkles, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Recommendation, RuleId } from '@/lib/cost-radar/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { CARD_COLORS, DISPLAY_FONT, HAND_FONT, displayName, formatShort, reasonParams } from './format';

export const RULE_ICONS: Record<RuleId, LucideIcon> = {
  'office-hours': AlarmClock,
  'unused-eip': MapPin,
  'empty-tg': Trash2,
  'empty-lb': Scale,
  'long-stopped-ec2': Moon,
  'unattached-ebs': HardDrive,
  'old-snapshot': Camera,
  'gp2-to-gp3': Sparkles,
};

interface SavingsCardProps {
  rec: Recommendation;
  index: number;
  sticker?: boolean;
  onOpen: (rec: Recommendation) => void;
}

export default function SavingsCard({ rec, index, sticker, onOpen }: SavingsCardProps) {
  const { t } = useLanguage();
  const Icon = RULE_ICONS[rec.rule] ?? Sparkles;
  const bg = CARD_COLORS[index % CARD_COLORS.length];
  const reason = rec.note ? t('costRadar.note.maybeScaledToZero') : t(`costRadar.rule.${rec.rule}.reason`, reasonParams(rec));

  return (
    <button
      type="button"
      onClick={() => onOpen(rec)}
      className="relative mb-3 flex w-full items-center gap-3.5 overflow-hidden rounded-[22px] px-[18px] py-4 text-left text-[#111] transition-transform hover:scale-[1.01] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      style={{ background: bg }}
    >
      <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[#111] text-white">
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block truncate text-base">{t(`costRadar.rule.${rec.rule}.title`)}</b>
        <small className="mt-0.5 block truncate text-xs opacity-75">{reason} · {displayName(rec)}</small>
      </span>
      <span className="ml-auto flex flex-none flex-col items-end">
        <span
          className={`whitespace-nowrap text-[22px] ${rec.countedInTotal ? '' : 'line-through opacity-60'}`}
          style={DISPLAY_FONT}
        >
          {rec.monthlySaving > 0 ? `-${formatShort(rec.monthlySaving)}` : '$0'}
        </span>
        {!rec.countedInTotal && (
          <span className="mt-0.5 rounded-md bg-black/15 px-1.5 text-[10px] font-bold">{t('costRadar.notCounted')}</span>
        )}
      </span>
      {sticker && (
        <span
          className="pointer-events-none absolute right-24 top-1 hidden -rotate-[8deg] text-xl text-[#111] min-[1140px]:block"
          style={HAND_FONT}
          aria-hidden
        >
          {t('costRadar.sticker')}
        </span>
      )}
    </button>
  );
}
