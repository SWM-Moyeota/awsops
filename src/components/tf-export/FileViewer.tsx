'use client';

// File tabs + code of one result file (text only; binary zips are not shown).
// 결과 파일 탭 + 코드 보기 (텍스트만, zip은 보이지 않음).
import { useEffect, useState } from 'react';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useFile } from './api';
import { viewableFiles } from './format';

export default function FileViewer({ jobId, files }: { jobId: string; files: string[] | undefined }) {
  const { t } = useLanguage();
  const names = viewableFiles(files);
  const first = names[0] ?? null;
  const [active, setActive] = useState<string | null>(first);
  // A different job starts on its first file. / 다른 작업이면 첫 파일부터.
  useEffect(() => { setActive(first); }, [jobId, first]);
  const current = active && names.includes(active) ? active : first;
  const file = useFile(current ? jobId : null, current);

  if (names.length === 0) return null;
  return (
    <section className="rounded-lg border border-navy-600 bg-navy-800">
      <div className="flex flex-wrap items-center gap-1 border-b border-navy-600 px-2 pt-2" role="tablist">
        <h3 className="mr-2 px-2 pb-2 text-sm font-semibold text-white">{t('tfExport.files.title')}</h3>
        {names.map((n) => (
          <button
            key={n}
            type="button"
            role="tab"
            aria-selected={n === current}
            onClick={() => setActive(n)}
            className={`-mb-px rounded-t border-x border-t px-2.5 py-1.5 font-mono text-xs ${n === current ? 'border-navy-600 bg-navy-900 text-accent-cyan' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="p-3">
        {file.loading && <p className="text-xs text-gray-500">{t('tfExport.loading')}</p>}
        {file.error && <p className="text-xs text-accent-red">{t('tfExport.files.error')}</p>}
        {file.data !== null && (
          <pre className="max-h-[560px] overflow-auto rounded bg-navy-900 p-3 font-mono text-xs leading-relaxed text-gray-200">{file.data}</pre>
        )}
      </div>
    </section>
  );
}
