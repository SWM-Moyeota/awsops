// Typed client for /api/root-cause (list, get, manual analyze) + hooks that abort stale requests.
// /api/root-cause 클라이언트(목록·상세·수동 분석) + 지난 요청을 끊는 훅.
import { useEffect, useState } from 'react';
import type { Incident } from '@/lib/root-cause/types';
import { viewFor } from './selection';

export interface ListBody { incidents: Incident[]; autoDetect: boolean }
export type AnalyzeBody = { accountId: string; resourceArn: string | null; at?: string };
// 200 = finished incident, 202 = still running on the server. / 200은 끝난 사건, 202는 서버에서 아직 도는 중.
export type AnalyzeResult = { kind: 'done'; incident: Incident } | { kind: 'running' };

/** Error with the HTTP status; `message` is the server's `error` field. / HTTP 상태를 담은 오류. */
export class RootCauseError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'RootCauseError'; }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body !== 'object') {
    const msg = body && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new RootCauseError(msg, res.status);
  }
  return body as Record<string, unknown>;
}

export async function listIncidents(accountId: string, signal?: AbortSignal): Promise<ListBody> {
  const qs = new URLSearchParams({ op: 'list', accountId });
  const body = await readJson(await fetch(`/api/root-cause?${qs}`, { signal, cache: 'no-store' }));
  return { incidents: Array.isArray(body.incidents) ? (body.incidents as Incident[]) : [], autoDetect: body.autoDetect !== false };
}

export async function getIncident(id: string, signal?: AbortSignal): Promise<Incident> {
  const qs = new URLSearchParams({ op: 'get', id });
  const body = await readJson(await fetch(`/api/root-cause?${qs}`, { signal, cache: 'no-store' }));
  return body.incident as Incident;
}

export async function analyze(req: AnalyzeBody, signal?: AbortSignal): Promise<AnalyzeResult> {
  const res = await fetch('/api/root-cause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'analyze', ...req }),
    signal,
    cache: 'no-store',
  });
  if (res.status === 202) return { kind: 'running' };
  const body = await readJson(res);
  return { kind: 'done', incident: body.incident as Incident };
}

export interface Loaded<T> { data: T | null; loading: boolean; error: RootCauseError | null }

// Shared fetch-on-key hook; drops data from a different key. / 키가 바뀌면 다시 부르고, 다른 키의 데이터는 버린다.
function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, reloadKey: number): Loaded<T> {
  const [state, setState] = useState<Loaded<T> & { key: string | null }>({ data: null, loading: false, error: null, key: null });
  useEffect(() => {
    if (!key) { setState({ data: null, loading: false, error: null, key: null }); return; }
    const ctrl = new AbortController();
    setState((s) => ({ data: s.key === key ? s.data : null, loading: true, error: null, key }));
    load(ctrl.signal).then(
      (data) => { if (!ctrl.signal.aborted) setState({ data, loading: false, error: null, key }); },
      (e) => {
        if (ctrl.signal.aborted) return;
        const err = e instanceof RootCauseError ? e : new RootCauseError(e instanceof Error ? e.name : 'Error', 0);
        setState({ data: null, loading: false, error: err, key });
      },
    );
    return () => ctrl.abort();
    // `load` is derived from `key`. / load는 key로 정해진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloadKey]);
  // Until the effect catches up, hide data stored for the previous key. / 효과가 따라잡기 전엔 이전 키의 데이터를 숨긴다.
  const view = viewFor(state, key);
  return { data: view.data, loading: view.loading, error: view.stale ? null : state.error };
}

/** Incident list for an account (`__all__` = every account). / 계정의 사건 목록. */
export function useIncidentList(accountId: string, reloadKey: number): Loaded<ListBody> {
  return useLoad(accountId, (signal) => listIncidents(accountId, signal), reloadKey);
}

/** One full incident (null id = idle). / 사건 하나(id가 null이면 쉼). */
export function useIncident(id: string | null, reloadKey: number): Loaded<Incident> {
  return useLoad(id, (signal) => getIncident(id as string, signal), reloadKey);
}
