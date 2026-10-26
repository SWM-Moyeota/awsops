'use client';

// Change timeline filters — pill chips (range · 전체/생성/삭제 · people · types), scrolled sideways, plus the search box.
// 변경 기록 필터 — 둥근 칩(기간 · 종류 · 사람 · 서비스, 가로 스크롤)과 검색칸.
import { Search, X } from 'lucide-react';
import type { ChangeKind, RangeId, ResourceType } from '@/lib/change-timeline/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { resourceTypeLabel } from './format';

/** Kind chips: `state` = stop OR start (API `kind=state`). / `state`는 켜기·끄기. */
export type KindFilter = ChangeKind | 'state';
export const RANGES: RangeId[] = ['24h', '7d', '30d', '90d', 'all'];

interface ChangeFiltersProps {
  range: RangeId;
  kind: KindFilter | null;
  actor: string | null;
  type: ResourceType | null;
  people: string[];
  types: ResourceType[];
  search: string;
  onRange: (r: RangeId) => void;
  onKind: (k: KindFilter | null) => void;
  onActor: (a: string | null) => void;
  onType: (t: ResourceType | null) => void;
  onSearch: (q: string) => void;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex-none whitespace-nowrap rounded-full px-[14px] py-[9px] text-[14px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4593fc] ${
        on ? 'bg-[#f2f4f6] text-[#0a0e1a]' : 'bg-[#1a2540] text-[#b0b8c1] hover:text-[#f2f4f6]'
      }`}
    >
      {children}
    </button>
  );
}

const Divider = () => <span aria-hidden="true" className="my-2 w-px flex-none bg-[#6b7684]/30" />;

/** Keep the selected value visible even when the current facets no longer list it. / 선택값은 목록에 없어도 보인다. */
function withSelected<T>(list: T[], selected: T | null): T[] {
  return selected !== null && !list.includes(selected) ? [selected, ...list] : list;
}

export default function ChangeFilters(p: ChangeFiltersProps) {
  const { t } = useLanguage();
  const people = withSelected(p.people, p.actor);
  const types = withSelected(p.types, p.type);
  return (
    <div>
      <div className="mb-[18px] flex gap-2 overflow-x-auto pb-[2px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="toolbar" aria-label={t('changes.filters')}>
        {RANGES.map((r) => (
          <Chip key={r} on={p.range === r} onClick={() => p.onRange(r)}>{t(`changes.range.${r}`)}</Chip>
        ))}
        <Divider />
        <Chip on={p.kind === null} onClick={() => p.onKind(null)}>{t('changes.kindAll')}</Chip>
        <Chip on={p.kind === 'create'} onClick={() => p.onKind('create')}>{t('changes.kindCreate')}</Chip>
        <Chip on={p.kind === 'delete'} onClick={() => p.onKind('delete')}>{t('changes.kindDelete')}</Chip>
        <Chip on={p.kind === 'state'} onClick={() => p.onKind('state')}>{t('changes.kindState')}</Chip>
        <Chip on={p.kind === 'modify'} onClick={() => p.onKind('modify')}>{t('changes.kindModify')}</Chip>
        {people.length > 0 && <Divider />}
        {people.map((name) => (
          <Chip key={`p:${name}`} on={p.actor === name} onClick={() => p.onActor(p.actor === name ? null : name)}>{name}</Chip>
        ))}
        {types.length > 0 && <Divider />}
        {types.map((rt) => (
          <Chip key={`t:${rt}`} on={p.type === rt} onClick={() => p.onType(p.type === rt ? null : rt)}>{resourceTypeLabel(rt)}</Chip>
        ))}
      </div>
      <label className="mb-[22px] flex items-center gap-2 rounded-[14px] bg-[#1a2540] px-4 py-[13px] focus-within:ring-2 focus-within:ring-[#4593fc]">
        <Search size={17} className="flex-none text-[#6b7684]" aria-hidden="true" />
        <input
          type="search"
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
          placeholder={t('changes.searchPlaceholder')}
          aria-label={t('changes.searchPlaceholder')}
          maxLength={200}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-[#f2f4f6] placeholder:text-[#6b7684] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {p.search && (
          <button type="button" onClick={() => p.onSearch('')} aria-label={t('changes.searchClear')} className="flex-none text-[#6b7684] hover:text-[#f2f4f6]">
            <X size={16} />
          </button>
        )}
      </label>
    </div>
  );
}
