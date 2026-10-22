import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyResults, initialState, loadState, saveState } from '@/lib/health/state';
import type { CheckResult, HealthState } from '@/lib/health/types';

const T0 = new Date('2026-10-22T00:00:00.000Z');
const T1 = new Date('2026-10-22T00:01:00.000Z');
const T2 = new Date('2026-10-22T00:02:00.000Z');

const fail = (id: CheckResult['id'], message = 'boom'): CheckResult => ({ id, ok: false, message });
const ok = (id: CheckResult['id'], message = 'fine'): CheckResult => ({ id, ok: true, message });

describe('applyResults', () => {
  it('firstFailureDoesNotTransition', () => {
    const { next, transitions } = applyResults(initialState(), [fail('steampipe')], T0);
    expect(transitions).toEqual([]);
    expect(next.steampipe.consecutiveFailures).toBe(1);
    expect(next.steampipe.status).toBe('unknown');
  });

  it('secondConsecutiveFailureTransitionsToFail', () => {
    const a = applyResults(initialState(), [fail('steampipe')], T0);
    const b = applyResults(a.next, [fail('steampipe', 'still down')], T1);
    expect(b.transitions).toHaveLength(1);
    expect(b.transitions[0]).toMatchObject({
      id: 'steampipe',
      from: 'unknown',
      to: 'fail',
      message: 'still down',
      at: T1.toISOString(),
    });
    expect(b.next.steampipe.status).toBe('fail');
    expect(b.next.steampipe.since).toBe(T1.toISOString());
  });

  it('failedItemDoesNotRetransitionOnFurtherFailures', () => {
    let s = initialState();
    s = applyResults(s, [fail('steampipe')], T0).next;
    s = applyResults(s, [fail('steampipe')], T1).next;
    const c = applyResults(s, [fail('steampipe')], T2);
    expect(c.transitions).toEqual([]);
    expect(c.next.steampipe.consecutiveFailures).toBe(3);
    expect(c.next.steampipe.since).toBe(T1.toISOString());
  });

  it('agentcoreInvokeNeedsThree', () => {
    let s = initialState();
    const r1 = applyResults(s, [fail('agentcore-invoke')], T0);
    s = r1.next;
    const r2 = applyResults(s, [fail('agentcore-invoke')], T1);
    s = r2.next;
    expect(r1.transitions).toEqual([]);
    expect(r2.transitions).toEqual([]);
    const r3 = applyResults(s, [fail('agentcore-invoke')], T2);
    expect(r3.transitions).toHaveLength(1);
    expect(r3.transitions[0]).toMatchObject({ id: 'agentcore-invoke', to: 'fail' });
  });

  it('unknownToOkIsSilent', () => {
    const { next, transitions } = applyResults(initialState(), [ok('bedrock')], T0);
    expect(next.bedrock.status).toBe('ok');
    expect(next.bedrock.since).toBe(T0.toISOString());
    expect(transitions).toEqual([]);
  });

  it('restoredFailRecoversOnFirstSuccess', () => {
    let s: HealthState = initialState();
    s = applyResults(s, [fail('lambda')], T0).next;
    s = applyResults(s, [fail('lambda')], T1).next;
    expect(s.lambda.status).toBe('fail');
    const { next, transitions } = applyResults(s, [ok('lambda', 'back')], T2);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ id: 'lambda', from: 'fail', to: 'ok', message: 'back' });
    expect(next.lambda.consecutiveFailures).toBe(0);
    expect(next.lambda.status).toBe('ok');
  });

  it('okStaysQuietOnRepeatSuccess', () => {
    const a = applyResults(initialState(), [ok('steampipe')], T0);
    const b = applyResults(a.next, [ok('steampipe')], T1);
    expect(b.transitions).toEqual([]);
    expect(b.next.steampipe.since).toBe(T0.toISOString());
    expect(b.next.steampipe.lastChecked).toBe(T1.toISOString());
  });

  it('resultsForUnlistedItemsLeaveThemUntouched', () => {
    const prev = initialState();
    const before = JSON.stringify(prev.bedrock);
    const { next } = applyResults(prev, [fail('steampipe')], T0);
    expect(JSON.stringify(next.bedrock)).toBe(before);
  });

  it('doesNotMutatePrev', () => {
    const prev = initialState();
    const snapshot = JSON.stringify(prev);
    applyResults(prev, [fail('steampipe')], T0);
    expect(JSON.stringify(prev)).toBe(snapshot);
  });
});

describe('persistence', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));

  it('loadStateFallsBackOnCorruptFile', () => {
    const p = path.join(tmp(), 'health-status.json');
    fs.writeFileSync(p, '{not json');
    expect(loadState(p)).toEqual(initialState());
  });

  it('loadStateFallsBackOnMissingFile', () => {
    expect(loadState(path.join(tmp(), 'nope.json'))).toEqual(initialState());
  });

  it('saveStateIsAtomic', () => {
    const dir = tmp();
    const p = path.join(dir, 'health-status.json');
    const s = applyResults(initialState(), [fail('steampipe')], T0).next;
    saveState(p, s);
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual(s);
    expect(fs.existsSync(p + '.tmp')).toBe(false);
    expect(loadState(p)).toEqual(s);
  });
});
