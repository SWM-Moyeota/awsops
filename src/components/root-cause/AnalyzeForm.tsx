'use client';

// "Analyze it yourself": resource search (graph op=search, 250 ms debounce, arrow keys + Enter), local time, analyze button.
// 직접 분석 — 리소스 검색(그래프 검색 재사용, 250ms 디바운스, 화살표·Enter 선택), 로컬 시각, 분석 버튼.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { GraphNode } from '@/lib/dep-graph/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useGraph, type SearchBody } from '@/components/dep-graph/api';
import { typeColor } from '@/components/dep-graph/layout';
import { analyze, RootCauseError, type AnalyzeResult } from './api';
import { fromLocalInput, toLocalInput } from './format';
import { isFresh, searchKeyAction } from './selection';

const DEBOUNCE_MS = 250;
const MAX_Q = 100;
const MAX_AGE_MS = 7 * 86_400_000;

export type AnalyzeOutcome = AnalyzeResult | { kind: 'error'; status: number };

interface Props {
  accountId: string;
  onResult: (r: AnalyzeOutcome) => void;
}

export default function AnalyzeForm({ accountId, onResult }: Props) {
  const { t } = useLanguage();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<GraphNode | null>(null);
  const [atText, setAtText] = useState(() => toLocalInput(new Date()));
  const [touched, setTouched] = useState(false);
  const [running, setRunning] = useState(false);
  const [dataQ, setDataQ] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;

  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim().slice(0, MAX_Q)), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => () => ctrlRef.current?.abort(), []);
  // A pick and a running analysis belong to one account: drop both on switch. / 계정이 바뀌면 고른 리소스와 진행 중 분석을 버린다.
  useEffect(() => {
    setPicked(null);
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    setRunning(false);
  }, [accountId]);

  const params = useMemo(() => (q ? { op: 'search', q, accountId } : null), [q, accountId]);
  const search = useGraph<SearchBody>(params);
  // Remember which query the shown results are for. / 보이는 결과가 어떤 검색어의 것인지 기억한다.
  useEffect(() => { setActive(0); if (search.data) setDataQ(q); }, [search.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => (dataQ === q ? search.data?.results ?? [] : []), [dataQ, q, search.data]);
  const fresh = isFresh({ text, q, dataQ, loading: search.loading, maxQ: MAX_Q });

  const pick = (n: GraphNode) => { setPicked(n); setOpen(false); setText(''); setQ(''); };

  const onKey = (e: React.KeyboardEvent) => {
    const onOption = (e.target as HTMLElement).getAttribute?.('role') === 'option';
    const act = searchKeyAction(e.key, { open, count: results.length, active, fresh, onOption });
    if (!act) return;
    if (act.type === 'close') { setOpen(false); return; }
    e.preventDefault();
    if (act.type === 'move') {
      setActive(act.index);
      // Keep focus with the highlight when moving between option buttons. / 결과 버튼 사이를 움직이면 포커스도 따라간다.
      if (onOption) document.getElementById(`rc-opt-${act.index}`)?.focus();
      return;
    }
    const n = results[act.index];
    if (n) pick(n);
  };

  const now = new Date();
  const minAt = toLocalInput(new Date(now.getTime() - MAX_AGE_MS));
  const maxAt = toLocalInput(now);

  const submit = async () => {
    if (!picked || running) return;
    // Untouched time means "now" on the server. / 시각을 안 건드렸으면 서버가 지금으로 잡는다.
    const at = touched ? fromLocalInput(atText) : null;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const startedFor = accountId;
    // Ignore a result that lands after an account switch, even before the abort effect runs.
    // 계정이 바뀐 뒤 도착한 결과는 버린다(abort 효과가 돌기 전이라도).
    const gone = () => ctrl.signal.aborted || accountRef.current !== startedFor;
    setRunning(true);
    try {
      const r = await analyze({ accountId: picked.accountId, resourceArn: picked.arn, ...(at ? { at } : {}) }, ctrl.signal);
      if (!gone()) onResult(r);
    } catch (e) {
      if (gone()) return;
      onResult({ kind: 'error', status: e instanceof RootCauseError ? e.status : 0 });
    } finally {
      if (!gone()) setRunning(false);
    }
  };

  return (
    <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
      <h2 className="text-sm font-semibold text-white">{t('rootCause.analyze.title')}</h2>
      <p className="mt-0.5 text-xs text-gray-500">{t('rootCause.analyze.hint')}</p>

      <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-end">
        {/* Resource / 리소스 */}
        <div className="min-w-0 flex-1">
          <label className="mb-1 block text-[11px] text-gray-400">{t('rootCause.detail.resource')}</label>
          {picked ? (
            <div className="flex items-center gap-2 rounded-lg border border-accent-cyan/40 bg-navy-900 px-3 py-2">
              <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: typeColor(picked.type) }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-gray-200">{picked.name}</span>
                <span className="block truncate text-[11px] text-gray-500">{t(`depGraph.type.${picked.type}`)} · {picked.id}</span>
              </span>
              <button
                type="button"
                onClick={() => setPicked(null)}
                aria-label={t('rootCause.analyze.clear')}
                title={t('rootCause.analyze.clear')}
                className="rounded p-1 text-gray-500 hover:bg-navy-700 hover:text-white"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div
              className="relative"
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
              onKeyDown={onKey}
            >
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                value={text}
                maxLength={MAX_Q}
                onChange={(e) => { setText(e.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)}
                placeholder={t('rootCause.analyze.search')}
                aria-label={t('rootCause.analyze.search')}
                role="combobox"
                aria-expanded={open && !!q}
                aria-controls="rc-search-results"
                aria-activedescendant={open && results[active] ? `rc-opt-${active}` : undefined}
                className="w-full rounded-lg border border-navy-600 bg-navy-900 py-2 pl-8 pr-3 text-sm text-gray-200 placeholder-gray-600 focus:border-accent-cyan focus:outline-none"
              />
              {open && q && (
                <div id="rc-search-results" role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-navy-600 bg-navy-800 shadow-xl">
                  {!fresh && !search.error && !search.building && <div className="px-3 py-2 text-xs text-gray-500">{t('rootCause.analyze.searching')}</div>}
                  {search.building && <div className="px-3 py-2 text-xs text-accent-cyan">{t('rootCause.analyze.graphBuilding')}</div>}
                  {!search.loading && search.error && <div className="px-3 py-2 text-xs text-accent-red">{t('rootCause.analyze.searchError')}</div>}
                  {fresh && results.length === 0 && (
                    <div className="px-3 py-2 text-xs text-gray-500">{t('rootCause.analyze.noResults')}</div>
                  )}
                  {results.map((n, i) => (
                    <button
                      key={n.arn}
                      id={`rc-opt-${i}`}
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      // Keep input focus on mouse; click picks so Tab + Enter also work.
                      // 마우스로 눌러도 입력창 포커스 유지, 선택은 click이라 Tab+Enter로도 된다.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      onClick={() => pick(n)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left ${i === active ? 'bg-navy-700' : 'hover:bg-navy-700'}`}
                    >
                      <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: typeColor(n.type) }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-gray-200">{n.name}</span>
                        <span className="block truncate text-[11px] text-gray-500">{t(`depGraph.type.${n.type}`)} · {n.id}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Time / 시각 */}
        <div>
          <label htmlFor="rc-at" className="mb-1 block text-[11px] text-gray-400">{t('rootCause.analyze.time')}</label>
          <div className="flex items-center gap-2">
            <input
              id="rc-at"
              type="datetime-local"
              value={atText}
              min={minAt}
              max={maxAt}
              onChange={(e) => { setAtText(e.target.value); setTouched(true); }}
              title={t('rootCause.analyze.timeHint')}
              className="rounded-lg border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-gray-200 [color-scheme:dark] focus:border-accent-cyan focus:outline-none"
            />
            <button
              type="button"
              onClick={() => { setAtText(toLocalInput(new Date())); setTouched(false); }}
              className="rounded-lg border border-navy-600 px-3 py-2 text-xs text-gray-400 hover:text-white"
            >
              {t('rootCause.analyze.now')}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => { void submit(); }}
          disabled={!picked || running}
          title={!picked ? t('rootCause.analyze.pickFirst') : undefined}
          className="rounded-lg bg-accent-cyan px-5 py-2 text-sm font-semibold text-navy-900 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? t('rootCause.analyze.running') : t('rootCause.analyze.button')}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">{t('rootCause.analyze.timeHint')} · {t('rootCause.readOnly')}</p>
    </section>
  );
}
