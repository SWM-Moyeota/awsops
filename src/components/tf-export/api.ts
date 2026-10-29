// Typed client for /api/terraform-export + hooks that abort stale requests and poll a running job every 3 s.
// /api/terraform-export 클라이언트 + 지난 요청을 끊고, 도는 작업을 3초마다 확인하는 훅.
import { useEffect, useRef, useState } from 'react';
import type { ExportItem, ExportSeed, Excluded, JobRecord, JobStats, Stage } from '@/lib/tf-export/types';
import { POLL_MS, isSettled } from './format';

export interface StatusBody { installed: boolean; version?: string; running: string | null }
export interface PreviewBody { items: ExportItem[]; excluded: Excluded[] }
export type StatsTotals = JobStats & { jobs: number; updatedAt: string | null };

/** Error with the HTTP status; `message` is the server's `error` field. / HTTP 상태를 담은 오류. */
export class TfExportError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'TfExportError'; }
}

const BASE = '/api/terraform-export';

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body !== 'object') {
    const msg = body && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new TfExportError(msg, res.status);
  }
  return body as Record<string, unknown>;
}

async function get(params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return readJson(await fetch(`${BASE}?${new URLSearchParams(params)}`, { signal, cache: 'no-store' }));
}

async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    cache: 'no-store',
  });
}

export async function getStatus(signal?: AbortSignal): Promise<StatusBody> {
  const b = await get({ op: 'status' }, signal);
  return { installed: b.installed === true, version: typeof b.version === 'string' ? b.version : undefined, running: typeof b.running === 'string' ? b.running : null };
}

export async function previewSeed(accountId: string, seed: ExportSeed, signal?: AbortSignal): Promise<PreviewBody> {
  const b = await readJson(await post({ op: 'preview', accountId, seed }, signal));
  return { items: Array.isArray(b.items) ? (b.items as ExportItem[]) : [], excluded: Array.isArray(b.excluded) ? (b.excluded as Excluded[]) : [] };
}

/** Start a job; 202 → jobId. 429 busy, 409 not installed, 400 bad seed throw TfExportError. / 작업 시작. */
export async function startJob(accountId: string, seed: ExportSeed, signal?: AbortSignal): Promise<string> {
  const b = await readJson(await post({ op: 'start', accountId, seed }, signal));
  if (typeof b.jobId !== 'string') throw new TfExportError('NoJobId', 0);
  return b.jobId;
}

export async function getJob(id: string, signal?: AbortSignal): Promise<JobRecord> {
  const b = await get({ op: 'job', id }, signal);
  if (!b.job || typeof b.job !== 'object') throw new TfExportError('NoJob', 0);
  return b.job as JobRecord;
}

export async function listJobs(signal?: AbortSignal): Promise<JobRecord[]> {
  const b = await get({ op: 'list' }, signal);
  return Array.isArray(b.jobs) ? (b.jobs as JobRecord[]) : [];
}

export async function getStats(signal?: AbortSignal): Promise<StatsTotals> {
  return (await get({ op: 'stats' }, signal)) as unknown as StatsTotals;
}

export async function getFile(id: string, name: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${BASE}?${new URLSearchParams({ op: 'file', id, name })}`, { signal, cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new TfExportError(body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`, res.status);
  }
  return res.text();
}

export interface Loaded<T> { data: T | null; loading: boolean; error: TfExportError | null }

function toError(e: unknown): TfExportError {
  return e instanceof TfExportError ? e : new TfExportError(e instanceof Error ? e.name : 'Error', 0);
}

// Shared fetch-on-key hook; data from a different key is never returned. / 키가 바뀌면 다시 부르고, 다른 키의 데이터는 돌려주지 않는다.
function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const [state, setState] = useState<Loaded<T> & { key: string | null }>({ data: null, loading: false, error: null, key: null });
  useEffect(() => {
    if (!key) { setState({ data: null, loading: false, error: null, key: null }); return; }
    const ctrl = new AbortController();
    setState((s) => ({ data: s.key === key ? s.data : null, loading: true, error: null, key }));
    load(ctrl.signal).then(
      (data) => { if (!ctrl.signal.aborted) setState({ data, loading: false, error: null, key }); },
      (e) => { if (!ctrl.signal.aborted) setState({ data: null, loading: false, error: toError(e), key }); },
    );
    return () => ctrl.abort();
    // `load` is derived from `key`. / load는 key로 정해진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return { data: null, loading: false, error: null };
  if (state.key !== key) return { data: null, loading: true, error: null };
  return { data: state.data, loading: state.loading, error: state.error };
}

/** Install state + running job. / 설치 상태와 도는 작업. */
export function useStatus(reloadKey: number): Loaded<StatusBody> {
  return useLoad(`status:${reloadKey}`, (s) => getStatus(s));
}
/** Recent jobs (null = idle). / 최근 작업 목록. */
export function useJobs(reloadKey: number, enabled = true): Loaded<JobRecord[]> {
  return useLoad(enabled ? `list:${reloadKey}` : null, (s) => listJobs(s));
}
/** Cumulative stats (null = idle). / 누적 지표. */
export function useStats(reloadKey: number, enabled = true): Loaded<StatsTotals> {
  return useLoad(enabled ? `stats:${reloadKey}` : null, (s) => getStats(s));
}
/** One result file's text (null id/name = idle). / 결과 파일 하나의 내용. */
export function useFile(id: string | null, name: string | null): Loaded<string> {
  return useLoad(id && name ? `file:${id}:${name}` : null, (s) => getFile(id as string, name as string, s));
}

export interface JobPoll extends Loaded<JobRecord> { lastStage: Stage | null }

/**
 * One job, re-read every 3 s until done/failed. Stops on unmount or id change; 404 stops polling.
 * `lastStage` is the last running stage seen, so a failed job can show where it stopped.
 * 작업 하나를 끝나거나 실패할 때까지 3초마다 다시 읽는다 — 화면을 떠나거나 id가 바뀌면 멈추고, 404면 그만 부른다.
 * lastStage는 마지막으로 본 진행 단계라, 실패한 작업이 어디서 멈췄는지 보여 줄 수 있다.
 */
export function useJobPoll(id: string | null, onSettled?: (job: JobRecord) => void): JobPoll {
  const [state, setState] = useState<JobPoll & { key: string | null }>({ data: null, loading: false, error: null, lastStage: null, key: null });
  // Latest callback without restarting the poll / 폴링을 다시 시작하지 않고 최신 콜백을 쓴다
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  useEffect(() => {
    if (!id) { setState({ data: null, loading: false, error: null, lastStage: null, key: null }); return; }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seen: Stage | null = null;
    setState({ data: null, loading: true, error: null, lastStage: null, key: id });
    const tick = async () => {
      try {
        const job = await getJob(id, ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (!isSettled(job.stage)) seen = job.stage;
        setState({ data: job, loading: false, error: null, lastStage: seen, key: id });
        if (isSettled(job.stage)) { settledRef.current?.(job); return; }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const err = toError(e);
        setState((s) => ({ ...s, loading: false, error: err, key: id }));
        if (err.status === 404) return;
      }
      timer = setTimeout(() => { void tick(); }, POLL_MS);
    };
    void tick();
    return () => { ctrl.abort(); if (timer) clearTimeout(timer); };
  }, [id]);
  if (!id) return { data: null, loading: false, error: null, lastStage: null };
  if (state.key !== id) return { data: null, loading: true, error: null, lastStage: null };
  return { data: state.data, loading: state.loading, error: state.error, lastStage: state.lastStage };
}
