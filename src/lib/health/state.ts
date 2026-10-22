// Health state machine — pure logic plus atomic JSON persistence.
// 헬스 상태 머신 — 순수 로직 + 원자적 JSON 저장.
import fs from 'node:fs';
import { CHECK_IDS } from './types';
import type { CheckId, CheckResult, HealthState, ItemState, Transition } from './types';

/** Consecutive failures required before an item is declared 'fail'. */
export const FAIL_THRESHOLD: Record<CheckId, number> = {
  steampipe: 2,
  bedrock: 2,
  'agentcore-runtime': 2,
  'agentcore-invoke': 3,
  lambda: 2,
};

function emptyItem(): ItemState {
  return { status: 'unknown', consecutiveFailures: 0, lastChecked: null, message: '', since: null };
}

export function initialState(): HealthState {
  const s = {} as HealthState;
  for (const id of CHECK_IDS) s[id] = emptyItem();
  return s;
}

export function applyResults(
  prev: HealthState,
  results: CheckResult[],
  now: Date,
): { next: HealthState; transitions: Transition[] } {
  const at = now.toISOString();
  const next = {} as HealthState;
  for (const id of CHECK_IDS) next[id] = { ...prev[id] };
  const transitions: Transition[] = [];

  for (const r of results) {
    const cur = next[r.id];
    if (!cur) continue;
    const from = cur.status;
    cur.lastChecked = at;
    cur.message = r.message;

    if (r.ok) {
      cur.consecutiveFailures = 0;
      if (from !== 'ok') {
        cur.status = 'ok';
        cur.since = at;
        // unknown -> ok is silent (first observation); only fail -> ok is reported.
        if (from === 'fail') transitions.push({ id: r.id, from, to: 'ok', message: r.message, at });
      }
    } else {
      cur.consecutiveFailures += 1;
      if (from !== 'fail' && cur.consecutiveFailures >= FAIL_THRESHOLD[r.id]) {
        cur.status = 'fail';
        cur.since = at;
        transitions.push({ id: r.id, from, to: 'fail', message: r.message, at });
      }
    }
  }
  return { next, transitions };
}

export function loadState(path: string): HealthState {
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return initialState();
    // Merge over defaults so a partial/older file still yields every CheckId.
    const s = initialState();
    for (const id of CHECK_IDS) {
      if (raw[id] && typeof raw[id] === 'object') s[id] = { ...s[id], ...raw[id] };
    }
    return s;
  } catch {
    return initialState();
  }
}

export function saveState(path: string, s: HealthState): void {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, path);
}
