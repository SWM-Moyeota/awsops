'use client';

// Preview of a seed: what goes into the code and what is left out (with a reason), plus the "코드 만들기" button.
// 미리 보기 — 코드에 들어갈 것과 빠지는 것(이유 포함), 그리고 "코드 만들기" 버튼.
import { useLanguage } from '@/lib/i18n/LanguageContext';
import type { PreviewBody } from './api';
import { excludeReasonLabel, typeLabel } from './format';

interface Props {
  data: PreviewBody;
  region?: string;
  onStart: () => void;
  starting: boolean;
  /** Why the start button is off (null = can start). / 버튼을 못 누르는 이유(null이면 누를 수 있음). */
  blocked: string | null;
}

export default function PreviewList({ data, region, onStart, starting, blocked }: Props) {
  const { t } = useLanguage();
  const { items, excluded } = data;
  const hasShared = excluded.some((e) => e.reason === 'shared');

  return (
    <section className="space-y-3 rounded-lg border border-navy-600 bg-navy-800 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold text-white">{t('tfExport.preview.title')}</h2>
        <span className="text-xs text-gray-400">{t('tfExport.preview.summary', { included: items.length, excluded: excluded.length })}</span>
      </div>
      {region && <p className="text-xs text-gray-500">{t('tfExport.preview.region', { region })}</p>}

      {items.length === 0 && <p className="text-sm text-gray-400">{t('tfExport.preview.empty')}</p>}

      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead className="text-gray-500">
              <tr className="border-b border-navy-600">
                <th className="py-1.5 pr-3 font-medium">{t('tfExport.col.type')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('tfExport.col.name')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('tfExport.col.tfType')}</th>
                <th className="py-1.5 font-medium">{t('tfExport.col.id')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.address} className="border-b border-navy-700 text-gray-300">
                  <td className="py-1.5 pr-3">{typeLabel(i.nodeType, t)}</td>
                  <td className="max-w-[220px] truncate py-1.5 pr-3" title={i.name}>{i.name}</td>
                  <td className="py-1.5 pr-3 font-mono text-gray-400">{i.tfType}</td>
                  <td className="max-w-[260px] truncate py-1.5 font-mono text-gray-500" title={i.importId}>{i.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {excluded.length > 0 && (
        <details className="rounded border border-navy-600 bg-navy-900 px-3 py-2" open={items.length === 0}>
          <summary className="cursor-pointer text-xs font-medium text-gray-300">{t('tfExport.preview.excludedTitle', { count: excluded.length })}</summary>
          {hasShared && <p className="mt-2 text-[11px] text-gray-500">{t('tfExport.preview.sharedHint')}</p>}
          <ul className="mt-2 space-y-1">
            {excluded.map((e) => (
              <li key={`${e.nodeArn}:${e.reason}`} className="flex flex-wrap items-center gap-2 text-xs text-gray-400" title={e.nodeArn}>
                <span className="rounded bg-navy-700 px-1.5 py-0.5 text-[11px] text-accent-orange">{excludeReasonLabel(e.reason, t)}</span>
                <span className="text-gray-500">{typeLabel(e.nodeType, t)}</span>
                <span className="min-w-0 truncate">{e.name}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          onClick={onStart}
          disabled={items.length === 0 || starting || !!blocked}
          className="rounded-lg bg-accent-green/15 px-4 py-2 text-sm font-medium text-accent-green hover:bg-accent-green/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {starting ? t('tfExport.start.starting') : t('tfExport.start.button', { count: items.length })}
        </button>
        {blocked && <span className="text-xs text-accent-orange">{blocked}</span>}
        {!blocked && items.length > 0 && <span className="text-xs text-gray-500">{t('tfExport.start.hint')}</span>}
      </div>
    </section>
  );
}
