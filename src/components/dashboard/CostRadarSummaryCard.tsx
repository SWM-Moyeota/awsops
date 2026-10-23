'use client';

// Home summary card for Cost Radar — monthly estimate + possible monthly saving (navy dashboard style).
// When some tables failed the number is marked partial (≥) with a muted line instead of the saving.
// 홈 비용 레이더 요약 카드 — 이번 달 예상 + 아낄 수 있는 돈 (기존 대시보드 네이비 스타일).
// 일부 조회 실패 시 금액 앞에 ≥ 표시 + 흐린 안내 한 줄.
import { useEffect, useState } from 'react';
import { Radar } from 'lucide-react';
import StatsCard from './StatsCard';
import type { RadarResponse } from '@/lib/cost-radar/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useAccountContext } from '@/contexts/AccountContext';

const usd = (n: number) => `$${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export default function CostRadarSummaryCard() {
  const { t } = useLanguage();
  const { currentAccountId } = useAccountContext();
  const [state, setState] = useState<{ monthly: number; saving: number; partial: boolean } | 'loading' | 'error'>('loading');

  useEffect(() => {
    const ctrl = new AbortController();
    setState('loading');
    fetch(`/api/cost-radar?accountId=${encodeURIComponent(currentAccountId)}`, { signal: ctrl.signal })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as RadarResponse;
        if (!d?.estimate) throw new Error('bad response');
        setState({
          monthly: Number(d.estimate.monthly) || 0,
          saving: Number(d.savings?.monthly) || 0,
          partial: Array.isArray(d.estimate.warnings) && d.estimate.warnings.length > 0,
        });
      })
      .catch(() => { if (!ctrl.signal.aborted) setState('error'); });
    return () => ctrl.abort();
  }, [currentAccountId]);

  const value = typeof state === 'object' ? `${state.partial ? '≥ ' : ''}${usd(state.monthly)}` : '$--';
  const change = state === 'error'
    ? t('dashboard.costRadarUnavailable')
    : typeof state === 'object'
    ? state.partial ? t('dashboard.costRadarPartial') : t('dashboard.costRadarChange', { saving: usd(state.saving) })
    : undefined;

  return <StatsCard label={t('dashboard.costRadarLabel')} value={value} icon={Radar} color="green" change={change} />;
}
