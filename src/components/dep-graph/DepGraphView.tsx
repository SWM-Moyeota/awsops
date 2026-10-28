'use client';

// /dependency-graph page body: build line, search, tabs (relations canvas + panel / project cleanup preview).
// 의존성 그래프 본문 — 빌드 상태 줄, 검색, 탭(관계 보기: 캔버스+패널 / 프로젝트 정리 미리보기). 읽기 전용.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from '@/components/layout/Header';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useAccountContext } from '@/contexts/AccountContext';
import { TYPE_COLORS, layoutNeighborhood, typeColor } from './layout';
import { minutesSince, useGraph, type HubsBody, type NeighborhoodBody, type StatsBody, type WalkBody } from './api';
import SearchBox from './SearchBox';
import GraphCanvas from './GraphCanvas';
import ImpactPanel from './ImpactPanel';
import ProjectPreviewPanel from './ProjectPreviewPanel';

type Tab = 'relations' | 'project';
const DEPTHS = [1, 2, 3] as const;
const PANEL_DEPTH = '3';

export default function DepGraphView() {
  const { t } = useLanguage();
  const { currentAccountId } = useAccountContext();
  const [tab, setTab] = useState<Tab>('relations');
  const [center, setCenter] = useState<string | null>(null);
  const [depth, setDepth] = useState<number>(2);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [statsNonce, setStatsNonce] = useState(0);
  const refetchedFor = useRef('');

  // Keep "N분 전" fresh. / "N분 전"을 1분마다 갱신
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const stats = useGraph<StatsBody>(useMemo(() => ({ op: 'stats' }), []), `${reloadKey}:${statsNonce}`);
  const ready = !!stats.data;

  const hubs = useGraph<HubsBody>(
    useMemo(() => (ready && !center ? { op: 'hubs', accountId: currentAccountId } : null), [ready, center, currentAccountId]),
    reloadKey,
  );
  const nb = useGraph<NeighborhoodBody>(
    useMemo(() => (ready && center ? { op: 'neighborhood', arn: center, depth: String(depth) } : null), [ready, center, depth]),
    reloadKey,
  );
  const impact = useGraph<WalkBody>(
    useMemo(() => (ready && center ? { op: 'impact', arn: center, depth: PANEL_DEPTH } : null), [ready, center]),
    reloadKey,
  );
  const deps = useGraph<WalkBody>(
    useMemo(() => (ready && center ? { op: 'deps', arn: center, depth: PANEL_DEPTH } : null), [ready, center]),
    reloadKey,
  );

  // Hubs and walks differ per account. / 계정이 바뀌면 처음 화면으로
  useEffect(() => { setCenter(null); }, [currentAccountId]);

  // Newest builtAt seen: a later response can come from a newer build than stats.
  // 본 것 중 가장 새 builtAt — 통계보다 나중 응답이 더 새 빌드일 수 있다.
  const statsBuiltAt = stats.data?.stats.builtAt;
  const builtAt = [statsBuiltAt, hubs.data?.builtAt, nb.data?.builtAt, impact.data?.builtAt, deps.data?.builtAt]
    .filter((v): v is string => !!v && Number.isFinite(Date.parse(v)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  // Refetch stats once per newer build so the counts match. / 더 새 빌드를 보면 통계를 한 번 다시 불러 개수도 맞춘다.
  useEffect(() => {
    if (!builtAt || !statsBuiltAt || builtAt === statsBuiltAt || refetchedFor.current === builtAt) return;
    if (Date.parse(builtAt) <= Date.parse(statsBuiltAt)) return;
    refetchedFor.current = builtAt;
    setStatsNonce((n) => n + 1);
  }, [builtAt, statsBuiltAt]);

  const pick = useCallback((arn: string) => { setCenter(arn); setTab('relations'); }, []);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const s = stats.data?.stats;
  const nodeTotal = s ? Object.values(s.nodeCounts).reduce((a, b) => a + (b ?? 0), 0) : 0;
  const warnings = s?.warnings ?? [];
  const nbPositions = useMemo(() => (nb.data ? layoutNeighborhood({ nodes: nb.data.nodes }) : {}), [nb.data]);

  return (
    <div className="space-y-4 animate-fade-in">
      <Header title={t('depGraph.title')} subtitle={t('depGraph.subtitle')} onRefresh={refresh} />

      {/* Build line / 빌드 상태 줄 */}
      {s && (
        <p className="text-xs text-gray-400">
          {t('depGraph.builtAgo', { minutes: minutesSince(builtAt ?? s.builtAt, now), nodes: nodeTotal, edges: s.edgeCount })}
          {warnings.length > 0 && (
            <span className="ml-2 text-accent-orange">· {t('depGraph.warnings', { names: warnings.join(', ') })}</span>
          )}
        </p>
      )}
      {stats.building && (
        <div className="rounded-lg border border-accent-cyan/30 bg-accent-cyan/10 px-4 py-3 text-sm text-accent-cyan animate-pulse">
          {t('depGraph.building')}
        </div>
      )}
      {stats.error && (
        <div className="flex items-center gap-3 rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
          {t('depGraph.error')}
          <button type="button" onClick={refresh} className="rounded border border-accent-red/40 px-2 py-0.5 text-xs hover:bg-accent-red/20">
            {t('depGraph.retry')}
          </button>
        </div>
      )}
      {stats.loading && !s && <p className="text-sm text-gray-500">{t('depGraph.loading')}</p>}

      {ready && (
        <>
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="flex gap-1 rounded-lg border border-navy-600 bg-navy-800 p-1">
              {(['relations', 'project'] as Tab[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${tab === k ? 'bg-accent-cyan/10 text-accent-cyan' : 'text-gray-400 hover:text-white'}`}
                >
                  {t(k === 'relations' ? 'depGraph.tabRelations' : 'depGraph.tabProject')}
                </button>
              ))}
            </div>
            {tab === 'relations' && (
              <SearchBox placeholder={t('depGraph.searchPlaceholder')} accountId={currentAccountId} onPick={(n) => pick(n.arn)} reloadKey={reloadKey} />
            )}
          </div>

          {tab === 'project' && <ProjectPreviewPanel accountId={currentAccountId} reloadKey={reloadKey} onPick={pick} />}

          {tab === 'relations' && !center && (
            <section className="space-y-3">
              <div>
                <h2 className="text-base font-semibold text-white">{t('depGraph.hubs')}</h2>
                <p className="text-xs text-gray-500">{t('depGraph.hubsHint')}</p>
              </div>
              {hubs.loading && <p className="text-sm text-gray-500">{t('depGraph.loading')}</p>}
              {hubs.error && <p className="text-sm text-accent-red">{t('depGraph.error')}</p>}
              {hubs.data && hubs.data.hubs.length === 0 && <p className="text-sm text-gray-500">{t('depGraph.hubsEmpty')}</p>}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {hubs.data?.hubs.map((h) => (
                  <button
                    key={h.arn}
                    type="button"
                    onClick={() => pick(h.arn)}
                    title={h.arn}
                    className="rounded-lg border border-navy-600 bg-navy-800 p-4 text-left transition-colors hover:border-accent-cyan"
                    style={{ borderLeft: `3px solid ${typeColor(h.type)}` }}
                  >
                    <div className="text-[11px] font-medium" style={{ color: typeColor(h.type) }}>{t(`depGraph.type.${h.type}`)}</div>
                    <div className="mt-0.5 truncate text-sm font-semibold text-white">{h.name}</div>
                    <div className="mt-0.5 truncate text-[11px] text-gray-500">{h.id}</div>
                    <div className="mt-2 text-xs text-gray-300">{t('depGraph.dependents', { count: h.dependents })}</div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {tab === 'relations' && center && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <button type="button" onClick={() => setCenter(null)} className="rounded border border-navy-600 px-2 py-1 text-gray-400 hover:text-white">
                  ← {t('depGraph.back')}
                </button>
                <label className="flex items-center gap-1.5 text-gray-400" title={t('depGraph.depthHint')}>
                  {t('depGraph.depth')}
                  <select
                    value={depth}
                    onChange={(e) => setDepth(Number(e.target.value))}
                    className="rounded border border-navy-600 bg-navy-800 px-2 py-1 text-gray-200 focus:border-accent-cyan focus:outline-none"
                  >
                    {DEPTHS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
                <span className="text-gray-500">{t('depGraph.legendLeft')}</span>
                <span className="text-gray-500">{t('depGraph.legendRight')}</span>
                {nb.loading && <span className="text-accent-cyan animate-pulse">{t('depGraph.loading')}</span>}
                {nb.data?.truncated && <span className="text-accent-orange">{t('depGraph.truncated')}</span>}
              </div>

              <div className="flex flex-col gap-4 lg:flex-row">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-[460px] overflow-hidden rounded-lg border border-navy-600 bg-navy-900 lg:h-[calc(100vh-320px)] lg:min-h-[480px]">
                    {nb.data ? (
                      <GraphCanvas
                        nodes={nb.data.nodes}
                        edges={nb.data.edges}
                        positions={nbPositions}
                        centerArn={nb.data.center.arn}
                        onPick={pick}
                        frameKey={`${nb.data.center.arn}|${nb.data.nodes.length}`}
                      />
                    ) : nb.error ? (
                      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-accent-red">
                        {nb.error.status === 404 ? t('depGraph.notFound') : t('depGraph.error')}
                      </div>
                    ) : nb.building ? (
                      <div className="flex h-full items-center justify-center text-sm text-accent-cyan">{t('depGraph.building')}</div>
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-gray-500">{t('depGraph.loading')}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {(Object.keys(TYPE_COLORS) as Array<keyof typeof TYPE_COLORS>).map((type) => (
                      <span key={type} className="flex items-center gap-1.5 text-[11px] text-gray-400">
                        <span className="h-2.5 w-2.5 rounded-sm border" style={{ borderColor: TYPE_COLORS[type], background: `${TYPE_COLORS[type]}33` }} />
                        {t(`depGraph.type.${type}`)}
                      </span>
                    ))}
                  </div>
                  <p className="text-[11px] text-gray-500">{t('depGraph.clickHint')}</p>
                </div>
                <aside className="w-full lg:w-[360px] lg:flex-none">
                  {nb.data && <ImpactPanel center={nb.data.center} impact={impact} deps={deps} onPick={pick} />}
                </aside>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
