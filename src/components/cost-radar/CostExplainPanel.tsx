'use client';

// Cost Detective ("돈 탐정") panel — why the monthly estimate changed, with ranked causes (who / when).
// Fetches GET /api/cost-radar/explain?accountId=&days=; period chips 어제 / 7일 / 30일 (default 7일).
// Never invents an actor: causes without a matching change record say "누가 했는지 기록 없음". Guidance only.
// 돈 탐정 패널 — 월 예상 비용이 왜 바뀌었는지, 원인 순위(누가·언제). 사람을 지어내지 않는다. 안내만 한다.
import { useEffect, useState } from 'react';
import { AlertTriangle, Info, RefreshCw, Search } from 'lucide-react';
import type { ExplainDays, ExplainResponse } from '@/lib/cost-radar/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useAccountContext } from '@/contexts/AccountContext';
import { DISPLAY_FONT, HAND_FONT, PALETTE } from './format';
import { causeDate, causeSentence, comparedDay, headline, money } from './explain-format';

const PERIODS: ExplainDays[] = [1, 7, 30];

interface CostExplainPanelProps {
  /** Account scope; defaults to the global account picker. / 계정 범위, 없으면 전역 계정 선택. */
  accountId?: string;
  /** Account label for rows when several accounts are shown together. / 여러 계정을 함께 볼 때 행에 붙일 계정 이름. */
  accountLabel?: (accountId: string) => string | null;
}

const isExplain = (b: unknown): b is ExplainResponse =>
  !!b && typeof b === 'object'
  && ((b as ExplainResponse).mode === 'snapshot' || (b as ExplainResponse).mode === 'timeline-only')
  && Array.isArray((b as ExplainResponse).causes);

const amountColor = (n: number | null) => (n === null || Math.round(n * 100) === 0 ? PALETTE.muted : n > 0 ? PALETTE.pink : PALETTE.lime);

export default function CostExplainPanel({ accountId, accountLabel }: CostExplainPanelProps) {
  const { t } = useLanguage();
  const { currentAccountId } = useAccountContext();
  const scope = accountId ?? currentAccountId;

  const [days, setDays] = useState<ExplainDays>(7);
  const [data, setData] = useState<ExplainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/cost-radar/explain?accountId=${encodeURIComponent(scope)}&days=${days}`,
          { signal: ctrl.signal, cache: 'no-store' },
        );
        const body = await res.json().catch(() => null);
        if (!res.ok || !isExplain(body)) {
          throw new Error((body && typeof body.error === 'string' && body.error) || `HTTP ${res.status}`);
        }
        setData(body);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [scope, days, reloadKey]);

  const showUnexplained = !!data && data.unexplained !== null && Number.isFinite(data.unexplained) && Math.abs(data.unexplained) >= 0.01;
  const block = (cls: string) => <div className={`animate-pulse rounded-2xl ${cls}`} style={{ background: PALETTE.line }} />;

  return (
    <section className="mt-[22px] min-w-0 rounded-[26px] p-[22px]" style={{ background: PALETTE.card }} aria-labelledby="cost-explain-title">
      {/* Title + period chips / 제목 + 기간 칩 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-full text-[#111]" style={{ background: PALETTE.purple }}>
            <Search size={17} />
          </span>
          <div className="min-w-0">
            <h2 id="cost-explain-title" className="text-[26px] leading-none" style={{ ...HAND_FONT, color: PALETTE.purple }}>
              {t('costRadar.explain.title')}
            </h2>
            <p className="mt-1 text-[11px]" style={{ color: PALETTE.muted }}>{t('costRadar.explain.subtitle')}</p>
          </div>
        </div>
        <div className="flex gap-2" role="tablist" aria-label={t('costRadar.explain.periods')}>
          {PERIODS.map(d => {
            const active = d === days;
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setDays(d)}
                className="rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors"
                style={active ? { background: PALETTE.lime, color: '#111' } : { background: PALETTE.line, color: PALETTE.muted }}
              >
                {t(`costRadar.explain.period.${d}`)}
              </button>
            );
          })}
        </div>
      </div>

      {loading && (
        <div className="mt-5 space-y-3" aria-busy="true">
          {block('h-8 w-3/4')}
          {[0, 1, 2].map(i => <div key={i}>{block('h-11 w-full')}</div>)}
        </div>
      )}

      {!loading && error && (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3" style={{ background: PALETTE.bg }} role="alert">
          <AlertTriangle size={18} className="flex-none" style={{ color: PALETTE.pink }} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t('costRadar.explain.error')}</p>
            <p className="break-words text-[11px]" style={{ color: PALETTE.muted }}>{error}</p>
          </div>
          <button
            type="button"
            onClick={() => setReloadKey(k => k + 1)}
            className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold"
            style={{ background: PALETTE.lime, color: '#111' }}
          >
            <RefreshCw size={13} /> {t('costRadar.retry')}
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* Headline / 제목 문장 */}
          <p className="mt-5 text-[clamp(20px,3.6vw,26px)] leading-snug" style={DISPLAY_FONT}>{headline(data)}</p>
          {/* The day actually compared (later than fromDay when adjusted). / 실제 비교한 기준일 */}
          {data.mode === 'snapshot' && data.baseMonthly !== null && (
            <p className="mt-1.5 text-xs" style={{ color: PALETTE.muted }}>
              {t('costRadar.explain.range', { from: comparedDay(data), base: money(data.baseMonthly, false), current: money(data.currentMonthly, false) })}
            </p>
          )}

          {/* Causes / 원인 목록 */}
          {data.causes.length === 0 ? (
            <p className="mt-5 text-sm" style={{ color: PALETTE.muted }}>{t('costRadar.explain.empty')}</p>
          ) : (
            <ul className="mt-4">
              {data.causes.map((c, i) => {
                const date = causeDate(c.time);
                const acct = accountLabel?.(c.accountId);
                const sub = [date, acct].filter(Boolean).join(' · ');
                return (
                  <li
                    key={`${c.accountId}:${c.resourceId}:${c.kind}:${i}`}
                    className="flex items-center gap-3 border-b px-1 py-[11px] last:border-b-0"
                    style={{ borderColor: PALETTE.line }}
                  >
                    <span
                      className={`min-w-[84px] flex-none whitespace-nowrap text-right ${c.impact === null ? 'text-[11px] font-semibold' : 'text-base'}`}
                      style={c.impact === null ? { color: PALETTE.muted } : { ...DISPLAY_FONT, color: amountColor(c.impact), letterSpacing: 0 }}
                    >
                      {money(c.impact, true)}
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-semibold">
                      <span className="block break-words">{causeSentence(c)}</span>
                      {(c.detailBefore || c.detailAfter) && c.detailBefore !== c.detailAfter && (
                        <span className="mt-px block truncate font-mono text-[10px]" style={{ color: PALETTE.muted }}>
                          {c.detailBefore || '—'} → {c.detailAfter || '—'}
                        </span>
                      )}
                      {sub && <span className="mt-px block text-[11px] font-medium sm:hidden" style={{ color: PALETTE.muted }}>{sub}</span>}
                    </span>
                    {sub && <span className="hidden flex-none whitespace-nowrap text-right text-xs sm:block" style={{ color: PALETTE.muted }}>{sub}</span>}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Unexplained remainder — always shown when non-zero / 설명되지 않은 나머지 */}
          {showUnexplained && (
            <p className="mt-3 rounded-2xl px-4 py-2.5 text-[13px] font-semibold" style={{ background: PALETTE.bg, color: PALETTE.text }}>
              {t('costRadar.explain.unexplained', { amount: money(data.unexplained, true) })}
            </p>
          )}

          {/* Notes / 안내 */}
          {data.notes.length > 0 && (
            <ul className="mt-3 space-y-1">
              {data.notes.map((n, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px]" style={{ color: PALETTE.muted }}>
                  <Info size={11} className="mt-[2px] flex-none" />
                  <span className="break-words">{n}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
