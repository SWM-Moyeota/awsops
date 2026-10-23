'use client';

// System health card — polls /api/health every 60s, opens a detail panel with per-item status.
// 시스템 상태 카드 — 60초마다 /api/health를 조회하고, 클릭하면 항목별 상태 패널을 연다.
import { useState, useEffect, useCallback } from 'react';
import { Activity, X } from 'lucide-react';
import StatsCard from './StatsCard';
import { useLanguage } from '@/lib/i18n/LanguageContext';

interface HealthItem {
  id: string;
  title: string;
  status: 'ok' | 'fail' | 'unknown';
  message: string;
  lastChecked: string | null;
  since: string | null;
}

interface HealthResponse {
  items: HealthItem[];
  lastRunAt: string | null;
  failing: number;
  isAdmin: boolean;
}

const POLL_MS = 60_000;
const DOT: Record<HealthItem['status'], string> = {
  ok: 'bg-accent-green',
  fail: 'bg-accent-red',
  unknown: 'bg-gray-500',
};

/** Check id → i18n key suffix (keys exist in en/ko/zh). / 항목 id → 번역 키 */
const ITEM_KEYS: Record<string, string> = {
  steampipe: 'steampipe',
  bedrock: 'bedrock',
  'agentcore-runtime': 'agentcoreRuntime',
  'agentcore-invoke': 'agentcoreInvoke',
  lambda: 'lambda',
  'cross-account': 'crossAccount',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function SystemHealthCard() {
  const { t } = useLanguage();
  const [data, setData] = useState<HealthResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/health', { signal, cache: 'no-store' });
      if (!res.ok) return;
      setData(await res.json());
    } catch {
      // Keep last known data on network errors / 네트워크 오류 시 마지막 데이터 유지
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    const timer = setInterval(() => load(ctrl.signal), POLL_MS);
    return () => {
      clearInterval(timer);
      ctrl.abort();
    };
  }, [load]);

  const sendTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch('/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test' }),
      });
      const json: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        setTestMsg({ ok: true, text: t('health.testSent') });
      } else {
        setTestMsg({ ok: false, text: `${t('health.testFailed')}${json.error ? `: ${json.error}` : ''}` });
      }
    } catch (err) {
      setTestMsg({ ok: false, text: `${t('health.testFailed')}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setTesting(false);
    }
  };

  // Localized item title; falls back to the server's (Korean) title for unknown ids or missing keys.
  // 항목 제목 번역 — 알 수 없는 id나 번역 키가 없으면 서버가 준 제목 사용
  const itemTitle = (item: HealthItem): string => {
    const suffix = ITEM_KEYS[item.id];
    if (!suffix) return item.title;
    const key = `health.item.${suffix}`;
    const text = t(key);
    return text === key ? item.title : text;
  };

  const items = data?.items ?? [];
  const failing = data?.failing ?? 0;
  const noRunYet = !data || items.every(i => i.status === 'unknown');
  const value = noRunYet ? '—' : failing === 0 ? t('health.allOk') : t('health.failing', { count: failing });
  const color = noRunYet ? 'cyan' : failing === 0 ? 'green' : 'red';
  const failingTitles = items.filter(i => i.status === 'fail').map(itemTitle).join(', ');

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="cursor-pointer h-full"
        onClick={() => setOpen(true)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
      >
        <StatsCard
          label={t('health.title')}
          value={value}
          icon={Activity}
          color={color}
          highlight={!noRunYet}
          change={failingTitles ? `⚠ ${failingTitles}` : undefined}
        />
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-navy-800 border border-navy-600 rounded-lg w-full max-w-lg p-5"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-label={t('health.title')}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold">{t('health.title')}</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white" aria-label="close">
                <X size={18} />
              </button>
            </div>

            <ul className="space-y-3">
              {items.map(item => (
                <li key={item.id} className="flex items-start gap-3">
                  <span className={`mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ${DOT[item.status]}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white">{itemTitle(item)}</p>
                    {item.message && <p className="text-xs text-gray-400 break-words">{item.message}</p>}
                    <p className="text-xs text-gray-500 font-mono">{fmt(item.lastChecked)}</p>
                  </div>
                </li>
              ))}
            </ul>

            <p className="text-xs text-gray-500 mt-4">{t('health.lastRun')}: {fmt(data?.lastRunAt ?? null)}</p>

            {data?.isAdmin && (
              <div className="mt-4 flex items-center gap-3">
                <button
                  onClick={sendTest}
                  disabled={testing}
                  className="px-3 py-1.5 text-sm rounded-lg bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/20 disabled:opacity-50"
                >
                  {t('health.testButton')}
                </button>
                {testMsg && (
                  <span className={`text-xs ${testMsg.ok ? 'text-accent-green' : 'text-accent-red'}`}>{testMsg.text}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
