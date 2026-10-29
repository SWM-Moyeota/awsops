'use client';

// /terraform-export page body: install state, caution, 1) pick + preview, 2) make (stepper), 3) result, past jobs and totals.
// Terraform 코드 변환 본문 — 설치 상태, 주의 문구, 1) 고르기·미리 보기, 2) 만들기(진행 표시), 3) 결과, 지난 작업과 누적 지표.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Boxes, CheckCircle2, ListChecks, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import Header from '@/components/layout/Header';
import StatsCard from '@/components/dashboard/StatsCard';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useAccountContext } from '@/contexts/AccountContext';
import type { ExportSeed, JobRecord } from '@/lib/tf-export/types';
import SeedPicker from './SeedPicker';
import PreviewList from './PreviewList';
import JobProgress from './JobProgress';
import JobResult from './JobResult';
import { TfExportError, previewSeed, startJob, useJobPoll, useJobs, useStats, useStatus, type PreviewBody } from './api';
import {
  byTypeRows, effectiveAccount, isSettled, localDateTime, passRates, percent, seedKey, seedLabel, splitCode, stageLabel,
} from './format';

const SCRIPT = 'scripts/18-setup-terraform.sh';

// Keep the last loaded value while a refresh is in flight (no flicker). / 새로 불러오는 동안 마지막 값을 유지(깜빡임 없음).
function useLast<T>(value: T | null): T | null {
  const [last, setLast] = useState<T | null>(value);
  useEffect(() => { if (value !== null) setLast(value); }, [value]);
  return value ?? last;
}

// Text with `code` parts rendered as <code>. / 백틱 부분을 <code>로 그린다.
function CodeText({ text }: { text: string }) {
  return (
    <>
      {splitCode(text).map((p, i) => (p.code
        ? <code key={i} className="rounded bg-navy-900 px-1 font-mono text-[0.95em] text-accent-cyan">{p.text}</code>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}

type Preview = { key: string; accountId: string; seed: ExportSeed; data: PreviewBody };

export default function TfExportView() {
  const { t } = useLanguage();
  const { currentAccountId, accounts } = useAccountContext();
  const accountId = effectiveAccount(currentAccountId, accounts);
  const account = accounts.find((a) => a.accountId === accountId);
  const aliasOf = (id: string) => accounts.find((a) => a.accountId === id)?.alias ?? id;

  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const statusLoad = useStatus(reloadKey);
  const status = useLast(statusLoad.data);
  const installed = status?.installed === true;
  const jobs = useLast(useJobs(reloadKey, installed).data);
  const totals = useLast(useStats(reloadKey, installed).data);

  const [seed, setSeed] = useState<ExportSeed | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const jobRef = useRef<HTMLDivElement | null>(null);

  // A finished job refreshes status, list and totals. / 작업이 끝나면 상태·목록·누적 지표를 다시 읽는다.
  const poll = useJobPoll(jobId, useCallback((_job: JobRecord) => refresh(), [refresh]));

  // Follow a job that is already running (e.g. after reopening the page). / 이미 도는 작업이 있으면 그 작업을 보여 준다.
  useEffect(() => { if (status?.running && !jobId) setJobId(status.running); }, [status?.running, jobId]);

  // Previews and requests belong to one account; abort on change and on unmount. / 미리 보기와 요청은 계정마다 — 바뀌거나 떠나면 끊는다.
  useEffect(() => {
    setPreview(null); setPreviewError(null); setStartError(null); setPreviewing(false); setStarting(false);
    return () => { ctrlRef.current?.abort(); ctrlRef.current = null; };
  }, [accountId]);

  const newCtrl = () => { ctrlRef.current?.abort(); const c = new AbortController(); ctrlRef.current = c; return c; };

  const runPreview = async () => {
    if (!accountId || !seed) return;
    const c = newCtrl();
    setPreviewing(true); setPreviewError(null); setStartError(null);
    try {
      const data = await previewSeed(accountId, seed, c.signal);
      if (!c.signal.aborted) setPreview({ key: seedKey(seed), accountId, seed, data });
    } catch (e) {
      if (c.signal.aborted) return;
      setPreview(null);
      const err = e instanceof TfExportError ? e : null;
      setPreviewError(err?.status === 404 ? t('tfExport.preview.noGraph') : err?.status === 400 ? err.message : t('tfExport.preview.failed'));
    } finally {
      if (!c.signal.aborted) setPreviewing(false);
    }
  };

  const runStart = async () => {
    if (!preview) return;
    const c = newCtrl();
    setStarting(true); setStartError(null);
    try {
      const id = await startJob(preview.accountId, preview.seed, c.signal);
      if (c.signal.aborted) return;
      setJobId(id);
      refresh();
      jobRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      if (c.signal.aborted) return;
      const err = e instanceof TfExportError ? e : null;
      if (err?.status === 429) { setStartError(t('tfExport.start.busy')); refresh(); }
      else if (err?.status === 409) { setStartError(t('tfExport.notInstalled')); refresh(); }
      else if (err?.status === 400) setStartError(err.message);
      else setStartError(t('tfExport.start.failed'));
    } finally {
      if (!c.signal.aborted) setStarting(false);
    }
  };

  const openJob = (id: string) => {
    setJobId(id);
    jobRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const viewedRunning = !!poll.data && !isSettled(poll.data.stage);
  const otherRunning = !!status?.running && status.running !== jobId;
  const stale = !!preview && (preview.key !== seedKey(seed) || preview.accountId !== accountId);
  const blocked = !accountId ? t('tfExport.account.pickOne')
    : viewedRunning || otherRunning ? t('tfExport.start.busy')
    : stale ? t('tfExport.preview.stale')
    : null;

  const caution = (
    <p className="flex items-start gap-2 rounded-lg border border-accent-orange/40 bg-accent-orange/10 px-4 py-3 text-sm text-accent-orange" role="note">
      <AlertTriangle size={16} className="mt-0.5 flex-none" />
      <span><CodeText text={t('tfExport.caution')} /></span>
    </p>
  );

  return (
    <div className="space-y-4 animate-fade-in">
      <Header title={t('tfExport.title')} subtitle={t('tfExport.subtitle')} onRefresh={refresh} />
      {caution}

      {!status && statusLoad.loading && <p className="text-sm text-gray-500">{t('tfExport.loading')}</p>}
      {!status && statusLoad.error && (
        <div className="flex items-center gap-3 rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
          {t('tfExport.loadFailed')}
          <button type="button" onClick={refresh} className="rounded border border-accent-red/40 px-2 py-0.5 text-xs hover:bg-accent-red/20">{t('tfExport.retry')}</button>
        </div>
      )}

      {status && !installed && (
        <div className="space-y-2 rounded-lg border border-accent-red/40 bg-navy-800 px-4 py-4 text-sm">
          <p className="font-semibold text-accent-red">{t('tfExport.notInstalled')}</p>
          <p className="text-gray-400">{t('tfExport.notInstalledHint')}</p>
          <pre className="overflow-x-auto rounded bg-navy-900 px-3 py-2 font-mono text-xs text-accent-cyan">bash {SCRIPT}</pre>
        </div>
      )}

      {status && installed && (
        <>
          <p className="text-xs text-gray-500">
            {t('tfExport.installed', { version: status.version ?? '?' })}
            {status.running && <span className="ml-2 text-accent-cyan">{t('tfExport.runningNow', { id: status.running })}</span>}
          </p>

          {!accountId && accounts.length === 0 && <p className="text-sm text-gray-500">{t('tfExport.loading')}</p>}
          {!accountId && accounts.length > 0 && (
            <p className="rounded-lg border border-accent-orange/40 bg-accent-orange/10 px-4 py-3 text-sm text-accent-orange">{t('tfExport.account.pickOne')}</p>
          )}

          {accountId && (
            <>
              <p className="text-xs text-gray-400">{t('tfExport.account.using', { account: account ? `${account.alias} (${accountId})` : accountId, region: account?.region ?? '—' })}</p>
              <SeedPicker key={accountId} accountId={accountId} onChange={setSeed} onPreview={runPreview} loading={previewing} />
              {previewError && <p className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">{previewError}</p>}
              {preview && preview.accountId === accountId && (
                <PreviewList data={preview.data} region={account?.region} onStart={runStart} starting={starting} blocked={blocked} />
              )}
              {startError && <p className="rounded-lg border border-accent-orange/40 bg-accent-orange/10 px-4 py-3 text-sm text-accent-orange">{startError}</p>}
            </>
          )}

          <div ref={jobRef} className="scroll-mt-4 space-y-4">
            {jobId && poll.loading && !poll.data && <p className="text-sm text-gray-500">{t('tfExport.loading')}</p>}
            {jobId && poll.error && !poll.data && (
              <p className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
                {poll.error.status === 404 ? t('tfExport.job.notFound') : t('tfExport.loadFailed')}
              </p>
            )}
            {poll.data && <JobProgress job={poll.data} lastStage={poll.lastStage} />}
            {poll.data?.stage === 'done' && <JobResult job={poll.data} />}
          </div>

          <section className="rounded-lg border border-navy-600 bg-navy-800 p-4">
            <h2 className="text-sm font-semibold text-white">{t('tfExport.jobs.title')}</h2>
            {jobs && jobs.length === 0 && <p className="mt-2 text-xs text-gray-500">{t('tfExport.jobs.empty')}</p>}
            {jobs && jobs.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="text-gray-500">
                    <tr className="border-b border-navy-600">
                      <th className="py-1.5 pr-3 font-medium">{t('tfExport.jobs.started')}</th>
                      <th className="py-1.5 pr-3 font-medium">{t('tfExport.jobs.account')}</th>
                      <th className="py-1.5 pr-3 font-medium">{t('tfExport.jobs.seed')}</th>
                      <th className="py-1.5 pr-3 font-medium">{t('tfExport.jobs.stage')}</th>
                      <th className="py-1.5 pr-3 font-medium">{t('tfExport.jobs.passed')}</th>
                      <th className="py-1.5 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => (
                      <tr key={j.id} className={`border-b border-navy-700 text-gray-300 ${j.id === jobId ? 'bg-navy-700/60' : ''}`}>
                        <td className="whitespace-nowrap py-1.5 pr-3">{localDateTime(j.startedAt)}</td>
                        <td className="whitespace-nowrap py-1.5 pr-3">{aliasOf(j.accountId)}</td>
                        <td className="max-w-[240px] truncate py-1.5 pr-3" title={seedLabel(j.seed, t)}>{seedLabel(j.seed, t)}</td>
                        <td className={`whitespace-nowrap py-1.5 pr-3 ${j.stage === 'failed' ? 'text-accent-red' : j.stage === 'done' ? 'text-accent-green' : 'text-accent-cyan'}`}>{stageLabel(j.stage, t)}</td>
                        <td className="whitespace-nowrap py-1.5 pr-3">{j.stats ? `${j.stats.passFinal}/${j.stats.total} · ${percent(j.stats.passFinal, j.stats.total)}` : '—'}</td>
                        <td className="py-1.5 text-right">
                          <button type="button" onClick={() => openJob(j.id)} className="rounded border border-navy-600 px-2 py-0.5 text-[11px] text-accent-cyan hover:bg-navy-700">
                            {t('tfExport.jobs.open')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {totals && totals.jobs > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-white">{t('tfExport.totals.title')}</h2>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <StatsCard label={t('tfExport.totals.jobs')} value={totals.jobs} icon={ListChecks} color="cyan" />
                <StatsCard label={t('tfExport.totals.resources')} value={totals.total} icon={Boxes} color="purple" />
                <StatsCard label={t('tfExport.card.rules')} value={passRates(totals).rules} icon={Wand2} color="cyan" />
                <StatsCard label={t('tfExport.card.ai')} value={passRates(totals).ai} icon={Sparkles} color="purple" />
                <StatsCard label={t('tfExport.card.final')} value={passRates(totals).final} icon={ShieldCheck} color="green" />
                <StatsCard label={t('tfExport.card.pure')} value={totals.pure} icon={CheckCircle2} color="green" change={t('tfExport.totals.split', { ignore: totals.ignore, failed: totals.failed })} />
              </div>
              {byTypeRows(totals.byType).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {byTypeRows(totals.byType).map((r) => (
                    <span key={r.tfType} className="rounded border border-navy-600 bg-navy-800 px-2 py-1 text-[11px] text-gray-400">
                      <span className="font-mono text-gray-300">{r.tfType}</span> {r.pass}/{r.total} · {r.rate}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-500">{t('tfExport.totals.ai', { calls: totals.aiCalls, input: totals.inputTokens, output: totals.outputTokens })}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
