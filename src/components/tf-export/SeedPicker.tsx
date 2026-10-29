'use client';

// Step 1 — pick resources: tabs for tag / name prefix / VPC / one-by-one search (chips, up to 60), then "미리 보기".
// 1단계 고르기 — 태그 / 이름 접두어 / VPC / 개별 검색(칩, 최대 60개) 탭, 그다음 "미리 보기".
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { GraphNode } from '@/lib/dep-graph/types';
import type { ExportSeed } from '@/lib/tf-export/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import SearchBox from '@/components/dep-graph/SearchBox';
import { typeColor } from '@/components/dep-graph/layout';
import { MAX_ARNS, addArn, blocksSubmit, buildSeed, seedKey, type SeedKind } from './format';

const TABS: SeedKind[] = ['tag', 'prefix', 'vpc', 'arns'];
const inputCls = 'w-full rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-accent-cyan focus:outline-none';

interface Props {
  accountId: string;
  /** Called whenever the form makes a different seed (null = not ready). / 입력이 바뀌어 씨앗이 달라질 때마다. */
  onChange: (seed: ExportSeed | null) => void;
  onPreview: () => void;
  loading: boolean;
}

function Chip({ node, arn, onRemove }: { node?: GraphNode; arn: string; onRemove: () => void }) {
  const { t } = useLanguage();
  const color = typeColor(node?.type ?? '');
  return (
    <span title={arn} className="inline-flex max-w-[260px] items-center gap-1.5 rounded border border-navy-600 bg-navy-900 py-0.5 pl-2 pr-1 text-[11px] text-gray-300">
      <span className="h-2 w-2 flex-none rounded-sm" style={{ background: color }} />
      {node && <span style={{ color }}>{t(`depGraph.type.${node.type}`)}</span>}
      <span className="truncate">{node?.name ?? arn}</span>
      <button type="button" onClick={onRemove} aria-label={t('tfExport.pick.remove')} className="rounded p-0.5 text-gray-500 hover:bg-navy-700 hover:text-white">
        <X size={12} />
      </button>
    </span>
  );
}

export default function SeedPicker({ accountId, onChange, onPreview, loading }: Props) {
  const { t } = useLanguage();
  const [kind, setKind] = useState<SeedKind>('tag');
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [prefix, setPrefix] = useState('');
  const [vpc, setVpc] = useState<GraphNode | null>(null);
  const [vpcArn, setVpcArn] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Record<string, GraphNode>>({});

  // Picks belong to one account. / 고른 것은 계정마다 다르다.
  useEffect(() => { setVpc(null); setVpcArn(''); setPicked([]); setNodes({}); }, [accountId]);

  const seed = useMemo(
    () => buildSeed({ kind, tagKey, tagValue, prefix, vpcArn: vpcArn.trim() || vpc?.arn || '', arns: picked }),
    [kind, tagKey, tagValue, prefix, vpcArn, vpc, picked],
  );
  const key = seedKey(seed);
  // Report by key so identical seeds do not re-fire. / 같은 씨앗이면 다시 알리지 않도록 키로 비교.
  useEffect(() => { onChange(seed); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickNode = (n: GraphNode) => {
    setNodes((m) => ({ ...m, [n.arn]: n }));
    setPicked((l) => addArn(l, n.arn));
  };
  const full = picked.length >= MAX_ARNS;
  // Enter in a search input must not submit the preview form (result buttons still click) / 검색창의 Enter로 미리 보기 form이 제출되지 않게
  const guardEnter = (e: KeyboardEvent<HTMLDivElement>) => {
    if (blocksSubmit(e.key, (e.target as HTMLElement | null)?.tagName)) e.preventDefault();
  };

  return (
    <form
      className="space-y-3 rounded-lg border border-navy-600 bg-navy-800 p-4"
      onSubmit={(e) => { e.preventDefault(); if (seed && !loading) onPreview(); }}
    >
      <div>
        <h2 className="text-sm font-semibold text-white">{t('tfExport.pick.title')}</h2>
        <p className="mt-0.5 text-xs text-gray-500">{t('tfExport.pick.hint')}</p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-navy-600" role="tablist">
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${kind === k ? 'border-accent-cyan text-accent-cyan' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
          >
            {t(`tfExport.pick.tab.${k}`)}
          </button>
        ))}
      </div>

      {kind === 'tag' && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">{t('tfExport.pick.tagHint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={inputCls} value={tagKey} maxLength={128} onChange={(e) => setTagKey(e.target.value)} placeholder={t('tfExport.pick.tagKey')} aria-label={t('tfExport.pick.tagKey')} />
            <input className={inputCls} value={tagValue} maxLength={128} onChange={(e) => setTagValue(e.target.value)} placeholder={t('tfExport.pick.tagValue')} aria-label={t('tfExport.pick.tagValue')} />
          </div>
        </div>
      )}
      {kind === 'prefix' && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">{t('tfExport.pick.prefixHint')}</p>
          <input className={inputCls} value={prefix} maxLength={64} onChange={(e) => setPrefix(e.target.value)} placeholder={t('tfExport.pick.prefix')} aria-label={t('tfExport.pick.prefix')} />
        </div>
      )}
      {kind === 'vpc' && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">{t('tfExport.pick.vpcHint')}</p>
          <div onKeyDown={guardEnter}>
            <SearchBox placeholder={t('tfExport.pick.vpcSearch')} accountId={accountId} onlyType="vpc" onPick={(n) => { setVpc(n); setVpcArn(''); }} />
          </div>
          {vpc && !vpcArn.trim() && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              {t('tfExport.pick.vpcSelected')}: <Chip node={vpc} arn={vpc.arn} onRemove={() => setVpc(null)} />
            </div>
          )}
          <input className={inputCls} value={vpcArn} maxLength={2048} onChange={(e) => setVpcArn(e.target.value)} placeholder={t('tfExport.pick.vpcArn')} aria-label={t('tfExport.pick.vpcArn')} />
        </div>
      )}
      {kind === 'arns' && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">{t('tfExport.pick.arnsHint', { max: MAX_ARNS })}</p>
          {!full && (
            <div onKeyDown={guardEnter}>
              <SearchBox placeholder={t('tfExport.pick.search')} accountId={accountId} onPick={pickNode} />
            </div>
          )}
          {full && <p className="text-xs text-accent-orange">{t('tfExport.pick.full', { max: MAX_ARNS })}</p>}
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-gray-500">{t('tfExport.pick.count', { count: picked.length, max: MAX_ARNS })}</span>
            {picked.map((a) => (
              <Chip key={a} node={nodes[a]} arn={a} onRemove={() => setPicked((l) => l.filter((x) => x !== a))} />
            ))}
            {picked.length > 0 && (
              <button type="button" onClick={() => setPicked([])} className="ml-1 text-xs text-gray-500 underline hover:text-gray-300">
                {t('tfExport.pick.clear')}
              </button>
            )}
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={!seed || loading}
        className="rounded-lg bg-accent-cyan/15 px-4 py-2 text-sm font-medium text-accent-cyan hover:bg-accent-cyan/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? t('tfExport.pick.previewing') : t('tfExport.pick.preview')}
      </button>
    </form>
  );
}
