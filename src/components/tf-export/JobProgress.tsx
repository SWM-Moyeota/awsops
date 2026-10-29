'use client';

// Step 2 — stage stepper for one job (prepare … package), elapsed time, and the failure box.
// 2단계 만들기 — 작업 하나의 단계 진행 표시(준비 … 묶기), 걸린 시간, 실패 안내.
import { useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import type { JobRecord, Stage } from '@/lib/tf-export/types';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { STEPS, elapsed, isSettled, stageLabel, stepStates, type StepState } from './format';

const DOT: Record<StepState, string> = {
  done: 'border-accent-green bg-accent-green/15 text-accent-green',
  current: 'border-accent-cyan bg-accent-cyan/15 text-accent-cyan',
  todo: 'border-navy-600 bg-navy-900 text-gray-600',
  failed: 'border-accent-red bg-accent-red/15 text-accent-red',
};
const TEXT: Record<StepState, string> = {
  done: 'text-gray-300',
  current: 'text-accent-cyan font-medium',
  todo: 'text-gray-600',
  failed: 'text-accent-red font-medium',
};

export default function JobProgress({ job, lastStage }: { job: JobRecord; lastStage: Stage | null }) {
  const { t } = useLanguage();
  const states = stepStates(job.stage, lastStage);
  const running = !isSettled(job.stage);
  // Tick once a second while running, for the elapsed time. / 도는 동안 1초마다 걸린 시간 갱신.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <section className="space-y-3 rounded-lg border border-navy-600 bg-navy-800 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold text-white">{t('tfExport.progress.title')}</h2>
        <span className="font-mono text-xs text-gray-500">{job.id}</span>
        <span className="text-xs text-gray-400">{elapsed(job.startedAt, job.finishedAt, t)}</span>
        {running && <span className="text-xs text-gray-500">{t('tfExport.progress.polling')}</span>}
      </div>

      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2" aria-current={states[i] === 'current' ? 'step' : undefined}>
            <span className={`flex h-6 w-6 flex-none items-center justify-center rounded-full border text-[11px] ${DOT[states[i]]}`}>
              {states[i] === 'done' ? <Check size={12} /> : states[i] === 'failed' ? <X size={12} /> : states[i] === 'current' ? <Loader2 size={12} className="animate-spin" /> : i + 1}
            </span>
            <span className={`text-xs ${TEXT[states[i]]}`}>{stageLabel(s, t)}</span>
          </li>
        ))}
      </ol>

      {running && <p className="text-xs text-gray-500">{t('tfExport.progress.hint')}</p>}
      {job.stage === 'done' && <p className="text-xs text-accent-green">{t('tfExport.progress.done')}</p>}
      {job.stage === 'failed' && (
        <div className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
          {t('tfExport.progress.failed')}
          {job.error && <span className="ml-2 font-mono text-xs text-gray-400">{job.error}</span>}
        </div>
      )}
    </section>
  );
}
