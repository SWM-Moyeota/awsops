'use client';

// Read-only project cleanup preview: pick a seed (tag / name prefix / VPC), show delete order, a candidate graph,
// blockers, AWS-managed links and shared.
// 프로젝트 정리 미리보기(읽기 전용) — 씨앗(태그/이름 접두어/VPC)을 고르면 지우는 순서·후보 관계도·막는 것·AWS 관리 연결·공유라 빠진 것을 보여 준다.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import type { GraphNode } from '@/lib/dep-graph/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { layoutSteps, typeColor } from './layout';
import { useGraph, type GraphParams, type ProjectBody } from './api';
import SearchBox from './SearchBox';
import GraphCanvas from './GraphCanvas';

type SeedKind = 'tag' | 'prefix' | 'vpc';
const PER_STEP = 30;
// Nodes drawn in the candidate graph, in delete order. / 관계도에 그리는 최대 개수(지우는 순서대로).
const GRAPH_MAX = 300;

function NodeChip({ node, fallback }: { node?: GraphNode; fallback: string }) {
  const { t } = useLanguage();
  const color = typeColor(node?.type ?? '');
  return (
    <span title={node?.arn ?? fallback} className="inline-flex max-w-[240px] items-center gap-1.5 rounded border border-navy-600 bg-navy-900 px-2 py-0.5 text-[11px] text-gray-300">
      <span className="h-2 w-2 flex-none rounded-sm" style={{ background: color }} />
      {node && <span style={{ color }}>{t(`depGraph.type.${node.type}`)}</span>}
      <span className="truncate">{node?.name ?? fallback}</span>
    </span>
  );
}

const inputCls = 'w-full rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-accent-cyan focus:outline-none';

export default function ProjectPreviewPanel({ accountId, reloadKey, onPick }: { accountId: string; reloadKey: number; onPick?: (arn: string) => void }) {
  const { t } = useLanguage();
  const [kind, setKind] = useState<SeedKind>('tag');
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [prefix, setPrefix] = useState('');
  const [vpc, setVpc] = useState<GraphNode | null>(null);
  const [vpcArn, setVpcArn] = useState('');
  const [params, setParams] = useState<GraphParams | null>(null);
  // Bumped per run so the same seed refetches. / 같은 씨앗으로 다시 눌러도 새로 조회
  const [runNonce, setRunNonce] = useState(0);

  // Results belong to one account. / 결과는 계정마다 다르다.
  useEffect(() => { setParams(null); setVpc(null); }, [accountId]);

  const seedParams = useMemo((): GraphParams | null => {
    if (kind === 'tag') return tagKey.trim() && tagValue.trim() ? { tag: `${tagKey.trim()}=${tagValue.trim()}` } : null;
    if (kind === 'prefix') return prefix.trim() ? { prefix: prefix.trim() } : null;
    const arn = vpcArn.trim() || vpc?.arn || '';
    return arn ? { vpc: arn } : null;
  }, [kind, tagKey, tagValue, prefix, vpc, vpcArn]);

  const run = () => {
    if (!seedParams) return;
    setParams({ op: 'project', ...seedParams, accountId });
    setRunNonce((n) => n + 1);
  };
  const { data, loading, building, error } = useGraph<ProjectBody>(params, `${reloadKey}:${runNonce}`);
  const byArn = useMemo(() => new Map((data?.members ?? []).map((n) => [n.arn, n])), [data]);
  const warnings = data?.warnings ?? [];

  // Candidate graph: members in delete order (capped), edges among drawn members, step columns.
  // 후보 관계도 — 지우는 순서대로(상한까지) 그리고, 그린 후보끼리의 간선만, 단계마다 한 열.
  const graph = useMemo(() => {
    if (!data || data.seedCount === 0) return null;
    const drawn = new Set<string>();
    const order: Array<{ arns: string[] }> = [];
    for (const st of data.order) {
      const room = GRAPH_MAX - drawn.size;
      if (room <= 0) break;
      const arns = st.arns.slice(0, room).filter((a) => byArn.has(a));
      arns.forEach((a) => drawn.add(a));
      if (arns.length) order.push({ arns });
    }
    const nodes = Array.from(drawn).map((a) => byArn.get(a)!);
    const edges = (data.edges ?? []).filter((e) => drawn.has(e.src) && drawn.has(e.dst));
    return { nodes, edges, positions: layoutSteps(order), truncated: drawn.size < data.members.length };
  }, [data, byArn]);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-accent-orange/40 bg-accent-orange/10 px-4 py-3 text-sm text-accent-orange">
        <Info size={16} className="mt-0.5 flex-none" />
        <div>
          <p className="font-semibold">{t('depGraph.project.notice')}</p>
          <p className="mt-0.5 text-xs text-gray-400">{t('depGraph.project.intro')}</p>
          <p className="mt-0.5 text-xs text-gray-400">{t('depGraph.project.coverage')}</p>
        </div>
      </div>

      <form
        className="space-y-3 rounded-lg border border-navy-600 bg-navy-800 p-4"
        onSubmit={(e) => { e.preventDefault(); run(); }}
      >
        <p className="text-sm font-medium text-white">{t('depGraph.project.seedLabel')}</p>
        <div className="flex flex-wrap gap-4" role="radiogroup">
          {(['tag', 'prefix', 'vpc'] as SeedKind[]).map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-1.5 text-sm text-gray-300">
              <input type="radio" name="dg-seed" checked={kind === k} onChange={() => setKind(k)} className="accent-[#00d4ff]" />
              {t(`depGraph.project.seed${k === 'tag' ? 'Tag' : k === 'prefix' ? 'Prefix' : 'Vpc'}`)}
            </label>
          ))}
        </div>

        {kind === 'tag' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={inputCls} value={tagKey} maxLength={128} onChange={(e) => setTagKey(e.target.value)} placeholder={t('depGraph.project.tagKey')} />
            <input className={inputCls} value={tagValue} maxLength={256} onChange={(e) => setTagValue(e.target.value)} placeholder={t('depGraph.project.tagValue')} />
          </div>
        )}
        {kind === 'prefix' && (
          <input className={inputCls} value={prefix} maxLength={100} onChange={(e) => setPrefix(e.target.value)} placeholder={t('depGraph.project.prefixPlaceholder')} />
        )}
        {kind === 'vpc' && (
          <div className="space-y-2">
            <SearchBox placeholder={t('depGraph.project.vpcPlaceholder')} accountId={accountId} onlyType="vpc" onPick={(n) => { setVpc(n); setVpcArn(''); }} reloadKey={reloadKey} />
            {vpc && !vpcArn.trim() && (
              <div className="flex items-center gap-2 text-xs text-gray-400">
                {t('depGraph.project.vpcSelected')}: <NodeChip node={vpc} fallback={vpc.arn} />
              </div>
            )}
            <input className={inputCls} value={vpcArn} maxLength={1024} onChange={(e) => setVpcArn(e.target.value)} placeholder={t('depGraph.project.vpcArn')} />
          </div>
        )}

        <button
          type="submit"
          disabled={!seedParams || loading}
          className="rounded-lg bg-accent-cyan/15 px-4 py-2 text-sm font-medium text-accent-cyan hover:bg-accent-cyan/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('depGraph.project.run')}
        </button>
      </form>

      {loading && <p className="text-sm text-gray-500">{t('depGraph.loading')}</p>}
      {building && <p className="text-sm text-accent-cyan">{t('depGraph.building')}</p>}
      {error && (
        <div className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
          {t('depGraph.error')}
          {error.status === 400 && <span className="ml-2 text-xs text-gray-400">{error.message}</span>}
        </div>
      )}

      {data && warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-accent-orange/40 bg-accent-orange/10 px-4 py-3 text-sm text-accent-orange">
          <AlertTriangle size={16} className="mt-0.5 flex-none" />
          {t('depGraph.project.warnings', { names: warnings.join(', ') })}
        </div>
      )}

      {data && data.seedCount === 0 && (
        <p className="rounded-lg border border-navy-600 bg-navy-800 p-4 text-sm text-gray-400">{t('depGraph.project.empty')}</p>
      )}

      {data && data.seedCount > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-300">{t('depGraph.project.summary', { members: data.members.length, seeds: data.seedCount })}</p>

          <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
            <h3 className="text-sm font-semibold text-white">{t('depGraph.project.order')}</h3>
            <ol className="mt-3 space-y-3">
              {data.order.map((s) => (
                <li key={s.step} className="border-l-2 border-accent-cyan/40 pl-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-accent-cyan">
                    {t('depGraph.project.step', { step: s.step })}
                    {s.cycle && (
                      <span className="rounded bg-accent-purple/15 px-1.5 py-0.5 text-[11px] text-accent-purple">{t('depGraph.project.cycle')}</span>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {s.arns.slice(0, PER_STEP).map((a) => <NodeChip key={a} node={byArn.get(a)} fallback={a} />)}
                    {s.arns.length > PER_STEP && <span className="px-1 text-[11px] text-gray-500">{t('depGraph.more', { count: s.arns.length - PER_STEP })}</span>}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {graph && graph.nodes.length > 0 && (
            <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-sm font-semibold text-white">{t('depGraph.project.graph')}</h3>
                <span className="text-xs text-gray-500">{t('depGraph.project.graphHint')}</span>
                {graph.truncated && <span className="text-xs text-accent-orange">{t('depGraph.truncated')}</span>}
              </div>
              <div className="mt-3 h-[420px] overflow-hidden rounded-lg border border-navy-600 bg-navy-900">
                <GraphCanvas
                  nodes={graph.nodes}
                  edges={graph.edges}
                  positions={graph.positions}
                  onPick={onPick}
                  frameKey={`${data.builtAt}|${runNonce}|${graph.nodes.length}`}
                />
              </div>
            </section>
          )}

          <section className="rounded-lg border border-accent-red/30 bg-navy-800 p-4">
            <h3 className="text-sm font-semibold text-white">{t('depGraph.project.blockers')} <span className="text-gray-500">{data.blockers.length}</span></h3>
            <p className="mt-0.5 text-xs text-gray-500">{t('depGraph.project.blockersHint')}</p>
            {data.blockers.length === 0 && <p className="mt-2 text-xs text-gray-500">{t('depGraph.none')}</p>}
            <ul className="mt-2 space-y-2">
              {data.blockers.map((b) => (
                <li key={b.node.arn} className="text-xs">
                  <NodeChip node={b.node} fallback={b.node.arn} />
                  <p className="mt-1 pl-1 text-gray-500">
                    {t('depGraph.project.uses', { names: b.uses.map((a) => byArn.get(a)?.name ?? a).join(', ') })}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          {(data.managed ?? []).length > 0 && (
            <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
              <h3 className="text-sm font-semibold text-white">{t('depGraph.project.managed')} <span className="text-gray-500">{data.managed.length}</span></h3>
              <div className="mt-2 flex flex-wrap gap-1">
                {data.managed.map((n) => <NodeChip key={n.arn} node={n} fallback={n.arn} />)}
              </div>
            </section>
          )}

          <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
            <h3 className="text-sm font-semibold text-white">{t('depGraph.project.shared')} <span className="text-gray-500">{data.shared.length}</span></h3>
            {data.shared.length === 0 && <p className="mt-2 text-xs text-gray-500">{t('depGraph.none')}</p>}
            <div className="mt-2 flex flex-wrap gap-1">
              {data.shared.map((n) => <NodeChip key={n.arn} node={n} fallback={n.arn} />)}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
