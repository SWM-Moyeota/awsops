// Typed client for GET /api/graph + a hook that retries every 10 s while the graph is still building.
// /api/graph 클라이언트 — 그래프를 만드는 중이면 10초마다 다시 부르고, 화면을 떠나면 멈춘다.
import { useEffect, useRef, useState } from 'react';
import type { BuildStats, GraphNode, Neighborhood, WalkResult } from '@/lib/dep-graph/types';
import type { ProjectPreview } from '@/lib/dep-graph/project';

export const BUILDING_RETRY_MS = 10_000;

export type GraphParams = Record<string, string>;
export interface StatsBody { status: 'ready'; stats: BuildStats }
export interface HubsBody { builtAt: string; hubs: Array<GraphNode & { dependents: number }> }
export interface SearchBody { builtAt: string; results: GraphNode[] }
export type NeighborhoodBody = { builtAt: string } & Neighborhood;
export type WalkBody = { builtAt: string } & WalkResult;
export type ProjectBody = { builtAt: string; warnings: string[] } & ProjectPreview;

/** Error with the HTTP status; `message` is the server's `error` field. / HTTP 상태를 담은 오류. */
export class GraphFetchError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'GraphFetchError'; }
}

export type FetchResult<T> = { building: true } | { building: false; body: T };

export async function fetchGraph<T>(params: GraphParams, signal?: AbortSignal): Promise<FetchResult<T>> {
  const res = await fetch(`/api/graph?${new URLSearchParams(params)}`, { signal, cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (body && body.status === 'building') return { building: true };
  if (!res.ok || !body) {
    const msg = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new GraphFetchError(msg, res.status);
  }
  return { building: false, body: body as T };
}

export interface GraphState<T> { data: T | null; loading: boolean; building: boolean; error: GraphFetchError | null }
const IDLE = { data: null, loading: false, building: false, error: null };

/**
 * Fetch `params` (null = idle). Refetches when params or `reloadKey` change.
 * params가 null이면 아무것도 안 한다. params나 reloadKey가 바뀌면 다시 부른다.
 */
export function useGraph<T>(params: GraphParams | null, reloadKey: number | string = 0): GraphState<T> {
  const key = params ? new URLSearchParams(params).toString() : '';
  const [state, setState] = useState<GraphState<T>>(IDLE);
  const lastKey = useRef('');

  useEffect(() => {
    if (!key) { lastKey.current = ''; setState(IDLE); return; }
    // Drop data from a different request so panels never mix two resources.
    // 다른 요청의 데이터는 버린다 — 두 리소스가 섞여 보이지 않게.
    const sameKey = lastKey.current === key;
    lastKey.current = key;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const run = async (first: boolean) => {
      setState((s) => ({ data: first && !sameKey ? null : s.data, loading: true, building: s.building, error: null }));
      try {
        const r = await fetchGraph<T>(Object.fromEntries(new URLSearchParams(key)), ctrl.signal);
        if (!alive) return;
        if (r.building) {
          setState({ data: null, loading: false, building: true, error: null });
          timer = setTimeout(() => { void run(false); }, BUILDING_RETRY_MS);
          return;
        }
        setState({ data: r.body, loading: false, building: false, error: null });
      } catch (e) {
        if (!alive || ctrl.signal.aborted) return;
        const err = e instanceof GraphFetchError ? e : new GraphFetchError(e instanceof Error ? e.name : 'Error', 0);
        setState({ data: null, loading: false, building: false, error: err });
      }
    };
    void run(true);
    return () => { alive = false; ctrl.abort(); if (timer) clearTimeout(timer); };
  }, [key, reloadKey]);

  return state;
}

/** Whole minutes since `builtAt` (never negative). / builtAt 이후 지난 분(음수 없음). */
export function minutesSince(builtAt: string, now = Date.now()): number {
  const t = Date.parse(builtAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 60_000));
}
