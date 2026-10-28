'use client';

// Right panel: what is affected if the center changes (impact), what it uses (deps), and its attrs.
// 오른쪽 패널 — 바꾸거나 지우면 영향 받는 것(impact), 이 리소스가 쓰는 것(deps), 리소스 정보.
import type { GraphNode, WalkNode } from '@/lib/dep-graph/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { typeColor } from './layout';
import type { GraphState, WalkBody } from './api';

const PER_TYPE = 10;
const BASE_ATTRS: Array<[string, (n: GraphNode) => string]> = [
  ['type', (n) => n.type],
  ['id', (n) => n.id],
  ['account', (n) => n.accountId],
  ['region', (n) => n.region],
];

function groupByType(nodes: WalkNode[]): Array<[string, WalkNode[]]> {
  const m = new Map<string, WalkNode[]>();
  for (const n of nodes) {
    if (!m.has(n.type)) m.set(n.type, []);
    m.get(n.type)!.push(n);
  }
  const groups = Array.from(m.entries());
  for (const [, list] of groups) list.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  return groups.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function WalkSection({ title, state, onPick }: { title: (count: number | string) => string; state: GraphState<WalkBody>; onPick: (arn: string) => void }) {
  const { t } = useLanguage();
  const nodes = state.data?.nodes ?? [];
  return (
    <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
      <h3 className="text-sm font-semibold text-white">{title(state.data ? nodes.length : '…')}</h3>
      {state.loading && <p className="mt-2 text-xs text-gray-500">{t('depGraph.loading')}</p>}
      {state.error && <p className="mt-2 text-xs text-accent-red">{t('depGraph.error')}</p>}
      {state.data?.truncated && <p className="mt-2 text-xs text-accent-orange">{t('depGraph.truncated')}</p>}
      {state.data && nodes.length === 0 && <p className="mt-2 text-xs text-gray-500">{t('depGraph.none')}</p>}
      <div className="mt-2 space-y-3">
        {groupByType(nodes).map(([type, list]) => (
          <div key={type}>
            <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: typeColor(type) }}>
              <span className="h-2 w-2 rounded-sm" style={{ background: typeColor(type) }} />
              {t(`depGraph.type.${type}`)} <span className="text-gray-500">{list.length}</span>
            </div>
            <ul className="mt-1 flex flex-wrap gap-1">
              {list.slice(0, PER_TYPE).map((n) => (
                <li key={n.arn}>
                  <button
                    type="button"
                    onClick={() => onPick(n.arn)}
                    title={n.arn}
                    className="max-w-[200px] truncate rounded border border-navy-600 bg-navy-900 px-2 py-0.5 text-[11px] text-gray-300 hover:border-accent-cyan hover:text-white"
                  >
                    {n.name}
                  </button>
                </li>
              ))}
              {list.length > PER_TYPE && (
                <li className="px-1 py-0.5 text-[11px] text-gray-500">{t('depGraph.more', { count: list.length - PER_TYPE })}</li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

interface Props {
  center: GraphNode;
  impact: GraphState<WalkBody>;
  deps: GraphState<WalkBody>;
  onPick: (arn: string) => void;
}

export default function ImpactPanel({ center, impact, deps, onPick }: Props) {
  const { t } = useLanguage();
  const label = (k: string) => {
    const key = `depGraph.attr.${k}`;
    const v = t(key);
    return v === key ? k : v;
  };

  // Show attrs except tags; of the tags only Name. / tags는 빼고, 태그 중에는 Name만 보여 준다.
  const rows: Array<[string, string]> = BASE_ATTRS.map(([k, f]) => [k, k === 'type' ? t(`depGraph.type.${center.type}`) : f(center)]);
  for (const [k, v] of Object.entries(center.attrs ?? {})) {
    if (k === 'tags' || v === null || v === undefined || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') rows.push([k, String(v)]);
  }
  const tags = center.attrs?.tags as Record<string, unknown> | undefined;
  if (tags && typeof tags.Name === 'string' && tags.Name) rows.push(['Name', tags.Name]);
  rows.push(['arn', center.arn]);

  return (
    <div className="space-y-3">
      <WalkSection title={(count) => t('depGraph.impactTitle', { count })} state={impact} onPick={onPick} />
      <WalkSection title={(count) => t('depGraph.depsTitle', { count })} state={deps} onPick={onPick} />
      <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
        <h3 className="text-sm font-semibold text-white">{t('depGraph.infoTitle')}</h3>
        <dl className="mt-2 space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[110px_1fr] gap-2 text-xs">
              <dt className="text-gray-500">{label(k)}</dt>
              <dd className="break-all font-mono text-gray-300">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
