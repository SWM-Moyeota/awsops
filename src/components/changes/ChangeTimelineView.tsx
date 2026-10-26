'use client';

// Change timeline page body (Toss-style, dark) — summary sentence + stat cards, pill filters, search,
// day-grouped rows, status line and the detail panel. Fetches GET /api/changes for the selected account.
// 변경 기록 본문 — 요약 문장·숫자 카드, 칩 필터, 검색, 날짜별 목록, 상태 줄, 상세 패널. 선택 계정 기준으로 조회.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeRecord, ChangesResponse, RangeId, ResourceType } from '@/lib/change-timeline/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useAccountContext } from '@/contexts/AccountContext';
import ChangeSummary from './ChangeSummary';
import ChangeFilters, { type KindFilter } from './ChangeFilters';
import ChangeRow from './ChangeRow';
import ChangeDetailPanel from './ChangeDetailPanel';
import { groupByKstDay, kstDate, kstTime, summarySentence } from './format';

const SEARCH_DEBOUNCE_MS = 300;
const BACKFILL_POLL_MS = 30_000;

function SkeletonRows() {
  return (
    <div aria-busy="true">
      <div className="mb-1 mt-[18px] h-4 w-28 animate-pulse rounded-lg bg-[#1a2540]" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-[14px] py-[13px]">
          <div className="h-[42px] w-[42px] flex-none animate-pulse rounded-full bg-[#1a2540]" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-2/3 animate-pulse rounded-lg bg-[#1a2540]" />
            <div className="h-3 w-1/2 animate-pulse rounded-lg bg-[#1a2540]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ChangeTimelineView() {
  const { t } = useLanguage();
  const { currentAccountId, accounts } = useAccountContext();

  const [range, setRange] = useState<RangeId>('7d');
  const [kind, setKind] = useState<KindFilter | null>(null);
  const [actor, setActor] = useState<string | null>(null);
  const [type, setType] = useState<ResourceType | null>(null);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<ChangeRecord | null>(null);

  // Person/type facets belong to one account. / 사람·서비스 필터는 계정마다 다르다.
  useEffect(() => { setActor(null); setType(null); setSelected(null); }, [currentAccountId]);

  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ accountId: currentAccountId, range });
    if (kind) qs.set('kind', kind);
    if (actor) qs.set('actor', actor);
    if (type) qs.set('type', type);
    if (q) qs.set('q', q);
    (async () => {
      try {
        const res = await fetch(`/api/changes?${qs}`, { signal: ctrl.signal, cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || !Array.isArray(body.records)) {
          throw new Error((body && typeof body.error === 'string' && body.error) || `HTTP ${res.status}`);
        }
        setData(body as ChangesResponse);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [currentAccountId, range, kind, actor, type, q, reloadKey]);

  // While the first 90-day backfill runs, refresh now and then. / 처음 90일 수집 중에는 가끔 다시 조회.
  const backfilling = !!data?.status.backfilling;
  useEffect(() => {
    if (!backfilling) return;
    const id = setInterval(() => setReloadKey((k) => k + 1), BACKFILL_POLL_MS);
    return () => clearInterval(id);
  }, [backfilling]);

  const aliasOf = useCallback(
    (id: string) => accounts.find((a) => a.accountId === id)?.alias || id,
    [accounts],
  );
  const groups = useMemo(() => groupByKstDay(data?.records ?? [], new Date()), [data]);
  const closePanel = useCallback(() => setSelected(null), []);

  const filtered = !!(kind || actor || type || q);
  const neutralEmpty = kind === 'state' || kind === 'modify';
  const status = data?.status;
  const emptyReason = !status ? '' : neutralEmpty ? t('changes.emptyNoMatch') : filtered ? t('changes.emptyFiltered')
    : status.backfilling ? t('changes.emptyBackfilling')
    : !status.lastIngestAt ? t('changes.emptyNotStarted')
    : t('changes.emptyNoChanges');

  return (
    <div className="font-[family-name:var(--font-pretendard)] tracking-[-0.02em] text-[#f2f4f6] antialiased">
      <section className="mx-auto max-w-[880px] rounded-[24px] bg-[#0f1629] px-6 py-7">
        <ChangeSummary title={data ? summarySentence(data.summary, range) : null} summary={data?.summary ?? null} />
        <ChangeFilters
          range={range}
          kind={kind}
          actor={actor}
          type={type}
          people={data?.facets.people ?? []}
          types={data?.facets.resourceTypes ?? []}
          search={search}
          onRange={setRange}
          onKind={setKind}
          onActor={setActor}
          onType={setType}
          onSearch={setSearch}
        />

        {status && (status.backfilling || status.lastIngestAt || status.failedAccounts.length > 0) && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[#6b7684]" role="status">
            {status.backfilling && (
              <span className="inline-flex items-center gap-1.5 text-[#4593fc]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#4593fc]" aria-hidden="true" />
                {t('changes.statusBackfilling')}
              </span>
            )}
            {status.lastIngestAt && <span>{t('changes.statusLastIngest', { time: `${kstDate(status.lastIngestAt)} ${kstTime(status.lastIngestAt)}` })}</span>}
            {status.failedAccounts.length > 0 && (
              <span className="text-[#ff5f6d]">
                {t('changes.statusFailed', { alias: status.failedAccounts.map(aliasOf).join(', ') })}
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="my-6 rounded-[24px] bg-[#151d30] px-5 py-6 text-center">
            <p className="text-[16px] font-semibold">{t('changes.loadFailed')}</p>
            <p className="mt-1 text-[13px] text-[#6b7684]">{error}</p>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-4 rounded-[14px] bg-[#4593fc] px-4 py-[10px] text-[14px] font-semibold text-white hover:bg-[#3a85ea]"
            >
              {t('changes.retry')}
            </button>
          </div>
        )}

        {!error && !data && loading && <SkeletonRows />}

        {!error && data && (
          <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}>
            {groups.length === 0 ? (
              <div className="py-14 text-center">
                <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-[#1a2540] text-[24px]" aria-hidden="true">🗂️</div>
                <p className="text-[18px] font-bold">{t('changes.emptyTitle')}</p>
                <p className="mx-auto mt-1 max-w-[360px] text-[14px] leading-[1.55] text-[#b0b8c1]">{emptyReason}</p>
              </div>
            ) : (
              groups.map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <h2 className="mb-1 mt-[18px] text-[13px] font-semibold text-[#6b7684]">{g.label}</h2>
                  {g.records.map((r) => <ChangeRow key={r.id} record={r} onOpen={setSelected} />)}
                </section>
              ))
            )}
            {data.truncated && (
              <p className="mt-4 text-center text-[13px] text-[#6b7684]">{t('changes.truncated', { n: data.records.length })}</p>
            )}
          </div>
        )}
      </section>

      {selected && (
        <ChangeDetailPanel
          record={selected}
          accountLabel={`${aliasOf(selected.accountId)} (${selected.accountId})`}
          onSelect={setSelected}
          onClose={closePanel}
        />
      )}
    </div>
  );
}
