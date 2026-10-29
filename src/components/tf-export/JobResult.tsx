'use client';

// Step 3 — result of a finished job: pass-rate cards, per-resource table, CHANGE_ME note, file viewer and the zip link.
// 3단계 결과 — 통과율 카드, 리소스별 표, CHANGE_ME 안내, 파일 보기, zip 내려받기.
import { CheckCircle2, CircleAlert, Download, Sparkles, Wand2, XCircle, ShieldCheck } from 'lucide-react';
import type { JobRecord } from '@/lib/tf-export/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import StatsCard from '@/components/dashboard/StatsCard';
import FileViewer from './FileViewer';
import { byTypeRows, downloadUrl, hasSecretVars, outcomeColor, outcomeLabel, passRates, passedAtLabel } from './format';

const BADGE: Record<'green' | 'orange' | 'red', string> = {
  green: 'bg-accent-green/10 text-accent-green',
  orange: 'bg-accent-orange/10 text-accent-orange',
  red: 'bg-accent-red/10 text-accent-red',
};

export default function JobResult({ job }: { job: JobRecord }) {
  const { t } = useLanguage();
  const s = job.stats;
  const rates = s ? passRates(s) : null;
  const hasLambda = job.results.some((r) => r.tfType === 'aws_lambda_function' && r.outcome !== 'failed');
  const typeRows = byTypeRows(s?.byType);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-white">{t('tfExport.result.title')}</h2>
        {job.files && job.files.length > 0 && (
          <a
            href={downloadUrl(job.id)}
            download
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent-cyan/15 px-3 py-1.5 text-sm font-medium text-accent-cyan hover:bg-accent-cyan/25"
          >
            <Download size={14} /> {t('tfExport.result.download')}
          </a>
        )}
      </div>

      {s && rates && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatsCard label={t('tfExport.card.rules')} value={rates.rules} icon={Wand2} color="cyan" change={`${s.passRules}/${s.total}`} />
          <StatsCard label={t('tfExport.card.ai')} value={rates.ai} icon={Sparkles} color="purple" change={`${s.passAi}/${s.total}`} />
          <StatsCard label={t('tfExport.card.final')} value={rates.final} icon={ShieldCheck} color="green" change={`${s.passFinal}/${s.total}`} />
          <StatsCard label={t('tfExport.card.pure')} value={s.pure} icon={CheckCircle2} color="green" />
          <StatsCard label={t('tfExport.card.ignore')} value={s.ignore} icon={CircleAlert} color="orange" />
          <StatsCard label={t('tfExport.card.failed')} value={s.failed} icon={XCircle} color="red" />
        </div>
      )}
      {s && <p className="text-xs text-gray-500">{t('tfExport.result.aiUsage', { calls: s.aiCalls, input: s.inputTokens, output: s.outputTokens })}</p>}

      {job.bundleLevel && (
        <p className="rounded-lg border border-navy-600 bg-navy-800 px-4 py-2 text-xs text-gray-300">{t(`tfExport.bundle.${job.bundleLevel}`)}</p>
      )}
      {hasSecretVars(job.files) && (
        <p className="rounded-lg border border-accent-orange/40 bg-accent-orange/10 px-4 py-2 text-sm text-accent-orange">{t('tfExport.result.changeMe')}</p>
      )}
      {hasLambda && <p className="text-xs text-gray-400">{t('tfExport.result.lambdaCode')}</p>}

      {job.results.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-navy-600 bg-navy-800 p-4">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-gray-500">
              <tr className="border-b border-navy-600">
                <th className="py-1.5 pr-3 font-medium">{t('tfExport.col.tfType')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('tfExport.col.name')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('tfExport.col.result')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('tfExport.col.passedAt')}</th>
                <th className="py-1.5 font-medium">{t('tfExport.col.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {job.results.map((r) => (
                <tr key={r.address} className="border-b border-navy-700 align-top text-gray-300">
                  <td className="py-1.5 pr-3 font-mono text-gray-400">{r.tfType}</td>
                  <td className="py-1.5 pr-3">
                    <span className="block max-w-[220px] truncate" title={r.name}>{r.name}</span>
                    <span className="block max-w-[220px] truncate font-mono text-[11px] text-gray-600" title={r.address}>{r.address}</span>
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${BADGE[outcomeColor(r.outcome)]}`}>{outcomeLabel(r.outcome, t)}</span>
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-gray-400">{r.outcome === 'failed' ? '—' : passedAtLabel(r.passedAt, t)}</td>
                  <td className="py-1.5 text-gray-400">
                    {r.reason && <span className="block">{r.reason}</span>}
                    {r.ignored && r.ignored.length > 0 && (
                      <span className="block text-accent-orange">{t('tfExport.result.ignored', { attrs: r.ignored.join(', ') })}</span>
                    )}
                    {r.sensitiveOnly && r.sensitiveOnly.length > 0 && (
                      <span className="block text-accent-orange">{t('tfExport.result.sensitiveOnly', { attrs: r.sensitiveOnly.join(', ') })}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {typeRows.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {typeRows.map((r) => (
            <span key={r.tfType} className="rounded border border-navy-600 bg-navy-800 px-2 py-1 text-[11px] text-gray-400">
              <span className="font-mono text-gray-300">{r.tfType}</span> {r.pass}/{r.total} · {r.rate}
            </span>
          ))}
        </div>
      )}

      <FileViewer jobId={job.id} files={job.files} />
    </section>
  );
}
