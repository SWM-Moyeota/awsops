'use client';

// Cost Radar donut — CSS conic-gradient ring with the monthly total and an optional week-over-week pill.
// 비용 레이더 도넛 — CSS conic-gradient 링 + 가운데 월 총액 + (있을 때만) 지난주 대비 배지.
import type { CategoryTotal, Trend } from '@/lib/cost-radar/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { DISPLAY_FONT, PALETTE, donutGradient, splitMoney, trendLabel } from './format';

interface CostDonutProps {
  categories: CategoryTotal[];
  monthly: number;
  trend: Trend | null;
}

export default function CostDonut({ categories, monthly, trend }: CostDonutProps) {
  const { t } = useLanguage();
  const { whole, cents } = splitMoney(monthly);
  const up = trend ? trend.changePercent > 0 : false;
  const down = trend ? trend.changePercent < 0 : false;

  return (
    <div
      className="relative mx-auto mt-2 aspect-square w-full max-w-[270px] rounded-full"
      style={{ background: donutGradient(categories) }}
      role="img"
      aria-label={`${t('costRadar.monthly')} ${whole}${cents}`}
    >
      <div className="absolute rounded-full" style={{ inset: '12.5%', background: PALETTE.card }} />
      <div className="absolute inset-0 z-[1] flex flex-col items-center justify-center">
        <div className="text-[13px]" style={{ color: PALETTE.muted }}>Total</div>
        <div className="text-[clamp(30px,9vw,44px)] leading-[1.1]" style={DISPLAY_FONT}>
          {whole}<span className="text-[0.5em]">{cents}</span>
        </div>
        {trend && (
          <span
            className="mt-1 inline-flex items-center gap-1 rounded-full px-2.5 py-[3px] text-xs font-bold"
            style={up
              ? { background: '#3a1a2b', color: PALETTE.pink }
              : down
              ? { background: '#2a3510', color: PALETTE.lime }
              : { background: PALETTE.line, color: PALETTE.muted }}
          >
            {up ? '▲' : down ? '▼' : '–'} {t('costRadar.trend', { percent: trendLabel(trend.changePercent) })}
          </span>
        )}
      </div>
    </div>
  );
}
