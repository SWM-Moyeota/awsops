'use client';

// /root-cause page body: header, auto-detect banner, manual analysis, incident list (left) and detail (right). ?id= selects.
// 장애 원인 분석 본문 — 헤더, 자동 감지 꺼짐 안내, 직접 분석, 사건 목록(왼쪽)과 상세(오른쪽). ?id=로 사건 선택.
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Header from '@/components/layout/Header';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useAccountContext } from '@/contexts/AccountContext';
import AnalyzeForm, { type AnalyzeOutcome } from './AnalyzeForm';
import IncidentList from './IncidentList';
import IncidentDetail from './IncidentDetail';
import { useIncident, useIncidentList } from './api';
import { isForeign } from './selection';

const RUNNING_REFRESH_MS = 30_000;
const TOAST_MS = 5_000;
const ID_RE = /^rc-[a-z0-9]{10}$/;

type Toast = { tone: 'info' | 'warn' | 'error'; text: string };
const TOAST_STYLE: Record<Toast['tone'], string> = {
  info: 'border-accent-cyan/40 bg-navy-800 text-accent-cyan',
  warn: 'border-accent-orange/40 bg-navy-800 text-accent-orange',
  error: 'border-accent-red/40 bg-navy-800 text-accent-red',
};

export default function RootCauseView() {
  const { t } = useLanguage();
  const { currentAccountId, accounts } = useAccountContext();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlId = searchParams.get('id');
  const selectedFromUrl = urlId && ID_RE.test(urlId) ? urlId : null;

  const [reloadKey, setReloadKey] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (runningTimer.current) clearTimeout(runningTimer.current);
  }, []);

  const list = useIncidentList(currentAccountId, reloadKey);
  const incidents = list.data?.incidents ?? [];
  // URL wins; otherwise show the newest incident. / URL이 우선, 없으면 가장 최근 사건.
  const selectedId = selectedFromUrl ?? incidents[0]?.id ?? null;
  const detail = useIncident(selectedId, reloadKey);
  // A ?id from another account (e.g. after switching accounts) is dropped, so the newest incident of this account shows.
  // Checked against the incident's own account, so a Slack link still opens under "all accounts".
  // 다른 계정의 ?id(계정을 바꾼 뒤 등)는 버리고 이 계정의 최신 사건을 보여 준다 — 사건 자신의 계정으로 판단해 "전체 계정"에서는 Slack 링크가 그대로 열린다.
  const foreign = !!detail.data && isForeign(detail.data.accountId, currentAccountId);
  useEffect(() => {
    if (foreign && selectedFromUrl) router.replace(pathname, { scroll: false });
  }, [foreign, selectedFromUrl, router, pathname]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const select = useCallback((id: string) => {
    router.replace(`${pathname}?id=${encodeURIComponent(id)}`, { scroll: false });
  }, [router, pathname]);

  const show = useCallback((tone: Toast['tone'], text: string) => {
    setToast({ tone, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const onResult = useCallback((r: AnalyzeOutcome) => {
    if (r.kind === 'done') {
      show('info', t('rootCause.analyzeDone'));
      refresh();
      select(r.incident.id);
      return;
    }
    if (r.kind === 'running') {
      // Still running server-side: refresh the list in 30 s. / 서버에서 아직 도는 중 — 30초 뒤 목록 새로고침.
      show('info', t('rootCause.running'));
      if (runningTimer.current) clearTimeout(runningTimer.current);
      runningTimer.current = setTimeout(refresh, RUNNING_REFRESH_MS);
      return;
    }
    if (r.status === 429) show('warn', t('rootCause.rateLimited'));
    else if (r.status === 404) show('error', t('rootCause.analyzeNotFound'));
    else if (r.status === 400) show('error', t('rootCause.analyzeBadTime'));
    else show('error', t('rootCause.analyzeFailed'));
  }, [refresh, select, show, t]);

  const aliasOf = (id: string) => accounts.find((a) => a.accountId === id)?.alias;
  const accountLabel = (id: string) => { const alias = aliasOf(id); return alias ? `${alias} (${id})` : id; };

  return (
    <div className="space-y-4 animate-fade-in font-[family-name:var(--font-pretendard)]">
      <Header title={t('rootCause.title')} subtitle={t('rootCause.subtitle')} onRefresh={refresh} />

      {list.data && !list.data.autoDetect && (
        <div className="rounded-lg border border-accent-orange/40 bg-accent-orange/10 px-4 py-3 text-sm text-accent-orange" role="status">
          {t('rootCause.autoDetectOff')}
        </div>
      )}

      <AnalyzeForm accountId={currentAccountId} onResult={onResult} />

      {list.error && (
        <div className="flex items-center gap-3 rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
          {t('rootCause.loadFailed')}
          <button type="button" onClick={refresh} className="rounded border border-accent-red/40 px-2 py-0.5 text-xs hover:bg-accent-red/20">
            {t('rootCause.retry')}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <aside className="w-full flex-none lg:w-[340px]">
          <h2 className="mb-2 text-sm font-semibold text-white">{t('rootCause.list.title')}</h2>
          {list.loading && !list.data && <p className="text-sm text-gray-500">{t('rootCause.loading')}</p>}
          {list.data && <IncidentList incidents={incidents} selectedId={selectedId} onSelect={select} />}
        </aside>

        <main className="min-w-0 flex-1">
          {!selectedId && list.data && (
            <p className="rounded-lg border border-navy-600 bg-navy-800 px-4 py-10 text-center text-sm text-gray-500">{t('rootCause.selectHint')}</p>
          )}
          {selectedId && detail.loading && !detail.data && <p className="text-sm text-gray-500">{t('rootCause.loading')}</p>}
          {selectedId && detail.error && (
            <p className="rounded-lg border border-accent-red/40 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
              {detail.error.status === 404 ? t('rootCause.notFound') : t('rootCause.loadFailed')}
            </p>
          )}
          {detail.data && !foreign && <IncidentDetail incident={detail.data} accountLabel={accountLabel(detail.data.accountId)} />}
        </main>
      </div>

      <p className="text-[11px] text-gray-600">{t('rootCause.readOnly')}</p>

      {toast && (
        <div role="status" aria-live="polite" className={`fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border px-4 py-3 text-sm shadow-xl ${TOAST_STYLE[toast.tone]}`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
