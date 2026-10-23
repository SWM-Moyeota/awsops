'use client';

// Cost Radar page body — monthly estimate donut + category breakdown (left), cleanup savings cards (right).
// Fetches GET /api/cost-radar; creators are fetched lazily when a recommendation panel opens.
// 비용 레이더 본문 — 왼쪽: 월 예상 도넛 + 항목별 금액, 오른쪽: 정리 추천 절약 카드.
// GET /api/cost-radar 조회, 만든 사람은 추천 상세를 열 때만 따로 조회한다.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Banknote, ChevronRight, Database, Globe, HardDrive, Info, MapPin, Plug, RefreshCw, Scale, Server, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CategoryId, PricedResource, RadarResponse, Recommendation } from '@/lib/cost-radar/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { PRICE_AS_OF } from '@/lib/cost-radar/price-as-of';
import { useAccountContext, ALL_ACCOUNTS } from '@/contexts/AccountContext';
import CostDonut from './CostDonut';
import SavingsCard from './SavingsCard';
import RecommendationPanel, { type CreatorState } from './RecommendationPanel';
import {
  CATEGORY_COLORS, DISPLAY_FONT, HAND_FONT, PALETTE, creatorKey, formatMoney, formatShort, hasSnapshots, minutesSince,
  splitTemplate, visibleRecommendations,
} from './format';

const CATEGORY_ICONS: Record<CategoryId, LucideIcon> = {
  ec2: Server,
  loadbalancer: Scale,
  nat: Globe,
  'vpc-endpoint': Plug,
  'public-ip': MapPin,
  storage: HardDrive,
  rds: Database,
  elasticache: Zap,
};
const VISIBLE_CARDS = 8;
// Two columns from a 1140px viewport: the app sidebar takes 240px, so the page itself is ~900px wide there.
// 2단 배치는 뷰포트 1140px부터 — 사이드바 240px을 빼면 페이지 폭이 약 900px.

type Account = { accountId: string; alias: string };

/** Render a translated template, replacing {key} with React nodes. / 번역 템플릿의 {key}를 노드로 치환. */
function Rich({ template, values }: { template: string; values: Record<string, ReactNode> }) {
  return (
    <>
      {splitTemplate(template).map((p, i) => (
        <Fragment key={i}>{'key' in p ? values[p.key] ?? `{${p.key}}` : p.text}</Fragment>
      ))}
    </>
  );
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[26px] p-[22px] ${className}`} style={{ background: PALETTE.card }}>{children}</div>;
}

function Skeleton() {
  const block = (cls: string) => <div className={`animate-pulse rounded-2xl ${cls}`} style={{ background: PALETTE.line }} />;
  return (
    <div className="grid grid-cols-1 gap-[22px] min-[1140px]:grid-cols-[1.05fr_1fr]" aria-busy="true">
      <Card>
        {block('h-5 w-32')}
        <div className="mx-auto mt-4 aspect-square w-full max-w-[270px] animate-pulse rounded-full" style={{ background: PALETTE.line }} />
        <div className="mt-5 space-y-3">{[0, 1, 2, 3].map(i => <Fragment key={i}>{block('h-10 w-full')}</Fragment>)}</div>
      </Card>
      <div className="space-y-3">
        {block('h-7 w-56')}
        {[0, 1, 2, 3].map(i => <Fragment key={i}>{block('h-[72px] w-full !rounded-[22px]')}</Fragment>)}
      </div>
    </div>
  );
}

export default function CostRadarView() {
  const { t } = useLanguage();
  const { currentAccountId, accounts: ctxAccounts } = useAccountContext();

  // Page-local account view (only when the global selector is "All"). / 전역 선택이 All일 때만 쓰는 페이지 내 계정 보기.
  const [viewAccount, setViewAccount] = useState<string>(ALL_ACCOUNTS);
  useEffect(() => { setViewAccount(ALL_ACCOUNTS); }, [currentAccountId]);
  const scope = currentAccountId === ALL_ACCOUNTS ? viewAccount : currentAccountId;

  const [data, setData] = useState<RadarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [knownAccounts, setKnownAccounts] = useState<Account[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<CategoryId | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [openRec, setOpenRec] = useState<Recommendation | null>(null);
  const [creators, setCreators] = useState<Record<string, CreatorState>>({});
  const creatorsRef = useRef(creators);
  creatorsRef.current = creators;

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setExpanded(null);
    setShowAll(false);
    (async () => {
      try {
        const res = await fetch(`/api/cost-radar?accountId=${encodeURIComponent(scope)}`, { signal: ctrl.signal, cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !body.estimate) {
          throw new Error((body && typeof body.error === 'string' && body.error) || `HTTP ${res.status}`);
        }
        const r = body as RadarResponse;
        setData(r);
        setLoadedAt(Date.now());
        setNow(Date.now());
        if (Array.isArray(r.accounts) && r.accounts.length > 0) {
          setKnownAccounts(prev => (r.accounts.length >= prev.length ? r.accounts : prev));
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [scope, reloadKey]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const accounts: Account[] = knownAccounts.length > 0
    ? knownAccounts
    : ctxAccounts.map(a => ({ accountId: a.accountId, alias: a.alias }));
  const aliasOf = (id: string) => accounts.find(a => a.accountId === id)?.alias || id;
  const multi = accounts.length > 1;

  let scopeLabel: string;
  if (scope !== ALL_ACCOUNTS) scopeLabel = `${aliasOf(scope)} (${scope})`;
  else if (accounts.length === 1) scopeLabel = `${accounts[0].alias} (${accounts[0].accountId})`;
  else scopeLabel = t('costRadar.allAccounts');

  const updatedText = loadedAt === null
    ? ''
    : minutesSince(loadedAt, now) === 0
    ? t('costRadar.updatedJustNow')
    : t('costRadar.updatedAgo', { min: minutesSince(loadedAt, now) });

  const openPanel = useCallback((rec: Recommendation) => {
    setOpenRec(rec);
    const key = creatorKey(rec);
    const cur = creatorsRef.current[key];
    if (cur && cur.status !== 'error') return; // cached or in flight / 캐시됨 또는 조회 중
    setCreators(prev => ({ ...prev, [key]: { status: 'loading' } }));
    fetch(`/api/cost-radar/creators?ids=${encodeURIComponent(key)}`, { cache: 'no-store' })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = await res.json();
        if (!Array.isArray(list)) throw new Error('bad response');
        const info = list.find((c: { resourceId?: string }) => c?.resourceId === rec.resourceId) ?? list[0]
          ?? { resourceId: rec.resourceId, user: null, eventTime: null, status: 'unknown' };
        setCreators(prev => ({ ...prev, [key]: { status: 'done', info } }));
      })
      .catch(() => setCreators(prev => ({ ...prev, [key]: { status: 'error' } })));
  }, []);
  const closePanel = useCallback(() => setOpenRec(null), []);

  const byCategory = useMemo(() => {
    const m = new Map<CategoryId, PricedResource[]>();
    for (const r of data?.estimate.resources ?? []) m.set(r.category, [...(m.get(r.category) ?? []), r]);
    m.forEach(list => list.sort((a, b) => (b.monthly ?? 0) - (a.monthly ?? 0)));
    return m;
  }, [data]);
  const visible = useMemo(() => visibleRecommendations(data?.recommendations ?? []), [data]);
  const unusedEips = (data?.recommendations ?? []).filter(r => r.rule === 'unused-eip').length;
  const firstStopped = visible.find(r => r.rule === 'long-stopped-ec2')?.id;

  const est = data?.estimate;
  const noCost = !!est && est.monthly === 0;
  // "Nothing bills you" only when every table answered. / 모든 조회가 성공했을 때만 "과금 리소스 없음".
  const showEmptyCopy = noCost && !!est && est.warnings.length === 0;
  // $0 recommendations (e.g. an empty target group) still get the right column. / 0원 추천도 오른쪽에 표시.
  const showSavings = !noCost || visible.length > 0;

  return (
    <div className="mx-auto max-w-[1100px] rounded-[28px] p-5 pb-0 md:p-7 md:pb-0" style={{ background: PALETTE.bg, color: PALETTE.text }}>
      {/* Header / 제목 */}
      <div className="mb-[18px] flex flex-col gap-3 min-[1140px]:flex-row min-[1140px]:items-end min-[1140px]:justify-between">
        <h1 className="text-[clamp(28px,6vw,38px)] leading-[1.05]" style={DISPLAY_FONT}>
          {t('costRadar.title')}{' '}
          <span className="text-[1.2em]" style={{ ...HAND_FONT, color: PALETTE.purple, letterSpacing: 0 }}>{t('costRadar.titleAccent')}</span>
        </h1>
        <div className="text-xs min-[1140px]:text-right" style={{ color: PALETTE.muted }}>
          <div>{scopeLabel}</div>
          <div>{t('costRadar.basis')}{updatedText ? ` · ${updatedText}` : ''}</div>
        </div>
      </div>

      {/* Page-local account pills (global = All only) / 페이지 내 계정 선택 */}
      {currentAccountId === ALL_ACCOUNTS && multi && (
        <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label={t('costRadar.accountTabs')}>
          {[{ accountId: ALL_ACCOUNTS, alias: t('costRadar.allAccounts') }, ...accounts].map(a => {
            const active = viewAccount === a.accountId;
            return (
              <button
                key={a.accountId}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setViewAccount(a.accountId)}
                className="rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors"
                style={active ? { background: PALETTE.lime, color: '#111' } : { background: PALETTE.card, color: PALETTE.muted }}
              >
                {a.alias}
              </button>
            );
          })}
        </div>
      )}

      {/* Warnings / 일부 조회 실패 */}
      {!loading && est && est.warnings.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-2xl px-4 py-3 text-sm" style={{ background: '#2b2110', color: PALETTE.orange }} role="status">
          <AlertTriangle size={16} className="mt-0.5 flex-none" />
          <div className="min-w-0">
            <p className="font-semibold">{t('costRadar.warning')}</p>
            <ul className="mt-1 space-y-0.5 text-xs opacity-90">
              {est.warnings.map((w, i) => (
                <li key={i} className="break-words">{t(`costRadar.category.${w.category}`)}: {w.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {loading && <Skeleton />}

      {!loading && error && (
        <Card className="text-center">
          <AlertTriangle size={28} className="mx-auto" style={{ color: PALETTE.pink }} />
          <p className="mt-3 text-base font-semibold">{t('costRadar.error')}</p>
          <p className="mt-1 break-words text-xs" style={{ color: PALETTE.muted }}>{error}</p>
          <button
            type="button"
            onClick={() => setReloadKey(k => k + 1)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-bold"
            style={{ background: PALETTE.lime, color: '#111' }}
          >
            <RefreshCw size={14} /> {t('costRadar.retry')}
          </button>
        </Card>
      )}

      {!loading && !error && est && data && (
        <div className={`grid grid-cols-1 gap-[22px] ${showSavings ? 'min-[1140px]:grid-cols-[1.05fr_1fr]' : ''}`}>
          {/* LEFT: donut + breakdown / 왼쪽: 도넛 + 항목 */}
          <Card className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="text-lg" style={DISPLAY_FONT}>{t('costRadar.monthly')}</div>
              <span className="text-xs" style={{ color: PALETTE.muted }}>
                <Rich template={t('costRadar.hourly')} values={{ amount: <b className="text-white">{formatMoney(est.hourly)}</b> }} />
              </span>
            </div>
            <CostDonut categories={est.categories} monthly={est.monthly} trend={data.trend} />

            {showEmptyCopy ? (
              <p className="mt-6 text-center text-sm" style={{ color: PALETTE.muted }}>{t('costRadar.empty')}</p>
            ) : (
              <div className="mt-4">
                {est.categories.map(c => {
                  const Icon = CATEGORY_ICONS[c.id] ?? HardDrive;
                  const list = byCategory.get(c.id) ?? [];
                  const label = t(`costRadar.category.${c.id}`);
                  const name = c.count === 1 && list[0] ? `${label} ${list[0].name}` : c.count > 1 ? `${label} ×${c.count}` : label;
                  const names = list.slice(0, 3).map(r => r.name).join(' · ') + (list.length > 3 ? ` +${list.length - 3}` : '');
                  const sub = c.id === 'nat' ? t('costRadar.hint.nat') : c.count === 1 && list[0] ? list[0].detail : names;
                  const open = expanded === c.id;
                  return (
                    <div key={c.id} className="border-b last:border-b-0" style={{ borderColor: PALETTE.line }}>
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : c.id)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-3 px-1 py-[11px] text-left hover:bg-white/[0.03]"
                      >
                        <span className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-full text-[#111]" style={{ background: CATEGORY_COLORS[c.id] }}>
                          <Icon size={17} />
                        </span>
                        <span className="min-w-0 flex-1 text-sm font-semibold">
                          <span className="block truncate">
                            {name}
                            {c.id === 'public-ip' && unusedEips > 0 && (
                              <span className="ml-1.5 inline-block rounded-md px-1.5 py-px align-middle text-[10px] font-bold text-[#111]" style={{ background: PALETTE.pink }}>
                                {t('costRadar.unusedTag', { count: unusedEips })}
                              </span>
                            )}
                          </span>
                          {sub && <span className="mt-px block truncate text-[11px] font-medium" style={{ color: PALETTE.muted }}>{sub}</span>}
                        </span>
                        <span className="min-w-[66px] whitespace-nowrap text-right text-sm font-bold">{formatMoney(c.monthly)}</span>
                        <span className="hidden w-10 text-right text-[13px] sm:block" style={{ color: PALETTE.muted }}>{c.percent}%</span>
                        <ChevronRight size={16} className={`flex-none text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} />
                      </button>
                      {c.id === 'storage' && hasSnapshots(list) && (
                        <p className="-mt-1.5 mb-2 ml-[50px] text-[11px]" style={{ color: PALETTE.muted }}>
                          <Info size={11} className="mr-1 inline-block align-[-1px]" />{t('costRadar.snapshotUpperBound')}
                        </p>
                      )}
                      {open && (
                        <ul className="mb-2 ml-[50px] space-y-1.5">
                          {list.map(r => (
                            <li key={`${r.accountId}:${r.id}`} className="flex items-baseline gap-2 text-xs">
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-gray-200">{r.name}</span>
                                <span className="block truncate font-mono text-[10px]" style={{ color: PALETTE.muted }}>
                                  {r.name !== r.id ? `${r.id} · ` : ''}{r.detail}{scope === ALL_ACCOUNTS && multi ? ` · ${aliasOf(r.accountId)}` : ''}
                                </span>
                              </span>
                              <span className="whitespace-nowrap font-semibold">{formatMoney(r.monthly)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* RIGHT: savings / 오른쪽: 아낄 수 있는 돈 */}
          {showSavings && (
            <div className="min-w-0">
              <div className="mb-3.5 mt-1 text-2xl" style={DISPLAY_FONT}>
                <Rich
                  template={t('costRadar.savingsTitle')}
                  values={{ amount: <span style={{ color: PALETTE.lime }}>{t('costRadar.perMonth', { amount: formatShort(data.savings.monthly) })}</span> }}
                />
              </div>

              {visible.length === 0 ? (
                <Card><p className="text-sm" style={{ color: PALETTE.muted }}>{t('costRadar.noSavings')}</p></Card>
              ) : (
                <>
                  {(showAll ? visible : visible.slice(0, VISIBLE_CARDS)).map((r, i) => (
                    <SavingsCard key={r.id} rec={r} index={i} sticker={r.id === firstStopped} onOpen={openPanel} />
                  ))}
                  {visible.length > VISIBLE_CARDS && (
                    <button
                      type="button"
                      onClick={() => setShowAll(s => !s)}
                      className="mb-3 w-full rounded-full py-2 text-xs font-bold"
                      style={{ background: PALETTE.card, color: PALETTE.muted }}
                    >
                      {showAll ? t('costRadar.showLess') : t('costRadar.showAll', { count: visible.length })}
                    </button>
                  )}
                </>
              )}

              {data.savings.monthly > 0 && (
                <div className="mt-1.5 flex items-center gap-3 rounded-[22px] px-[18px] py-4" style={{ background: PALETTE.card }}>
                  <Banknote size={26} className="flex-none" style={{ color: PALETTE.lime }} />
                  <div className="whitespace-pre-line text-[13px] text-zinc-300">
                    <Rich
                      template={t('costRadar.yearEnd')}
                      values={{
                        current: <b style={{ color: PALETTE.pink }}>{formatShort(data.savings.yearEndCurrent)}</b>,
                        after: <b style={{ color: PALETTE.lime }}>{formatShort(data.savings.yearEndAfter)}</b>,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Unpriced (collapsed) / 가격 정보 없음 (접힘) */}
      {!loading && !error && est && est.unpriced.length > 0 && (
        <details className="mt-[22px] rounded-[22px] px-[18px] py-3.5" style={{ background: PALETTE.card }}>
          <summary className="cursor-pointer text-sm font-semibold" style={{ color: PALETTE.muted }}>
            {t('costRadar.unpriced', { count: est.unpriced.length })}
          </summary>
          <ul className="mt-3 space-y-1.5">
            {est.unpriced.map(r => (
              <li key={`${r.accountId}:${r.id}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="text-gray-200">{r.name}</span>
                <span className="font-mono text-[10px]" style={{ color: PALETTE.muted }}>{r.detail}</span>
                {r.unpricedReason && <span style={{ color: PALETTE.orange }}>{t(`costRadar.unpricedReason.${r.unpricedReason}`)}</span>}
                {scope === ALL_ACCOUNTS && multi && <span style={{ color: PALETTE.muted }}>· {aliasOf(r.accountId)}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Always-visible disclaimer / 항상 보이는 추정 안내 */}
      <div
        className="sticky bottom-0 z-10 -mx-5 mt-[22px] flex items-start gap-2 rounded-b-[28px] px-5 py-3 text-[11px] md:-mx-7 md:px-7"
        style={{ background: PALETTE.bg, color: PALETTE.muted, borderTop: `1px solid ${PALETTE.line}` }}
      >
        <Info size={13} className="mt-px flex-none" />
        <span>{t('costRadar.disclaimer', { date: est?.priceAsOf || PRICE_AS_OF })}</span>
      </div>

      {openRec && (
        <RecommendationPanel
          rec={openRec}
          creator={creators[creatorKey(openRec)]}
          accountLabel={`${aliasOf(openRec.accountId)} (${openRec.accountId})`}
          onClose={closePanel}
        />
      )}
    </div>
  );
}
