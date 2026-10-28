'use client';

// Resource search box with a results dropdown (op=search, 300 ms debounce). Optional type filter (e.g. vpc).
// 리소스 검색창 + 결과 목록 — 300ms 디바운스, 필요하면 종류(vpc 등)로만 거른다.
import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { GraphNode, NodeType } from '@/lib/dep-graph/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { typeColor } from './layout';
import { useGraph, type SearchBody } from './api';

const DEBOUNCE_MS = 300;
const MAX_Q = 100;

interface Props {
  placeholder: string;
  accountId: string;
  onPick: (node: GraphNode) => void;
  onlyType?: NodeType;
  reloadKey?: number;
}

export default function SearchBox({ placeholder, accountId, onPick, onlyType, reloadKey = 0 }: Props) {
  const { t } = useLanguage();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim().slice(0, MAX_Q)), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);

  const params = useMemo(() => (q ? { op: 'search', q, accountId } : null), [q, accountId]);
  const { data, loading, error } = useGraph<SearchBody>(params, reloadKey);
  const results = useMemo(
    () => (data?.results ?? []).filter((n) => !onlyType || n.type === onlyType),
    [data, onlyType],
  );

  const pick = (n: GraphNode) => { onPick(n); setOpen(false); setText(''); setQ(''); };

  return (
    <div className="relative w-full md:max-w-md">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
      <input
        type="text"
        value={text}
        maxLength={MAX_Q}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-navy-600 bg-navy-800 py-2 pl-8 pr-3 text-sm text-gray-200 placeholder-gray-600 focus:border-accent-cyan focus:outline-none"
      />
      {open && q && (
        <div className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-navy-600 bg-navy-800 shadow-xl">
          {loading && <div className="px-3 py-2 text-xs text-gray-500">{t('depGraph.loading')}</div>}
          {!loading && error && <div className="px-3 py-2 text-xs text-accent-red">{t('depGraph.error')}</div>}
          {!loading && !error && data && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-500">{t('depGraph.noResults')}</div>
          )}
          {results.map((n) => (
            <button
              key={n.arn}
              type="button"
              // mousedown fires before the input blur. / 입력창 blur보다 먼저 실행되도록 mousedown 사용
              onMouseDown={(e) => { e.preventDefault(); pick(n); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-navy-700"
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
  );
}
