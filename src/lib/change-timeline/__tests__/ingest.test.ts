import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestOnce, type LookupFn } from '../ingest';
import { eventNamesFor } from '../catalog';
import { readState } from '../store';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.json`), 'utf8');
const NOW = new Date('2026-10-26T00:00:00Z');
const A = '111122223333';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ingest-')); process.env.CHANGE_TIMELINE_DATA_DIR = dir; });
afterEach(() => { delete process.env.CHANGE_TIMELINE_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

type Call = Parameters<LookupFn>;
function fake(over?: (c: Call) => ReturnType<LookupFn> | undefined) {
  const calls: Call[] = [];
  const fn: LookupFn = async (...c) => {
    calls.push(c);
    const o = over?.(c);
    if (o) return o;
    if (c[1] === 'ap-northeast-2' && (c[2].eventName === 'CreateBucket' || c[2].readOnlyFalse)) {
      return { events: [{ CloudTrailEvent: fx('CreateBucket') }] };
    }
    return { events: [] };
  };
  return { fn, calls };
}

describe('ingestOnce', () => {
  it('backfillQueriesEachTrackedNameThenIncremental', async () => {
    const { fn, calls } = fake();
    const r = await ingestOnce({ lookup: fn, now: NOW, accounts: [A] });
    const ap = calls.filter((c) => c[1] === 'ap-northeast-2');
    const us = calls.filter((c) => c[1] === 'us-east-1');
    expect(ap.filter((c) => c[2].eventName).map((c) => c[2].eventName)).toEqual(eventNamesFor('ap-northeast-2'));
    expect(us.filter((c) => c[2].eventName).map((c) => c[2].eventName)).toEqual(eventNamesFor('us-east-1'));
    expect(ap[ap.length - 1][2].readOnlyFalse).toBe(true);
    expect(calls.findIndex((c) => c[1] === 'us-east-1')).toBeGreaterThan(calls.findIndex((c) => c[2].readOnlyFalse && c[1] === 'ap-northeast-2'));
    expect(r.added).toBe(1);
    const st = (await readState()).accounts[`${A}:ap-northeast-2`];
    expect(st.backfillDone).toEqual(eventNamesFor('ap-northeast-2'));
    expect(new Date(st.backfillFrom).getTime()).toBe(NOW.getTime() - 90 * 86_400_000);
  });

  it('backfillResumesFromState', async () => {
    const names = eventNamesFor('ap-northeast-2');
    let n = 0;
    const first = fake((c) => {
      if (c[1] === 'ap-northeast-2' && c[2].eventName && ++n === 3) throw Object.assign(new Error('x'), { name: 'ThrottlingException' });
      return undefined;
    });
    const r1 = await ingestOnce({ lookup: first.fn, now: NOW, accounts: [A] });
    expect(r1.failed).toEqual([A]);
    expect((await readState()).accounts[`${A}:ap-northeast-2`].backfillDone).toEqual(names.slice(0, 2));
    const second = fake();
    await ingestOnce({ lookup: second.fn, now: NOW, accounts: [A] });
    const asked = second.calls.filter((c) => c[1] === 'ap-northeast-2' && c[2].eventName).map((c) => c[2].eventName);
    expect(asked).toEqual(names.slice(2));
  });

  it('incrementalUsesOverlapAndDedupes', async () => {
    const f = fake();
    expect((await ingestOnce({ lookup: f.fn, now: NOW, accounts: [A] })).added).toBe(1);
    const later = new Date(NOW.getTime() + 600_000);
    const g = fake();
    expect((await ingestOnce({ lookup: g.fn, now: later, accounts: [A] })).added).toBe(0);
    const inc = g.calls.find((c) => c[1] === 'ap-northeast-2' && c[2].readOnlyFalse)!;
    expect(inc[2].start.getTime()).toBe(NOW.getTime() - 20 * 60_000);
    expect(inc[2].end.getTime()).toBe(later.getTime());
    expect(g.calls.some((c) => c[2].eventName)).toBe(false);
  });

  it('oneAccountFailureDoesNotStopOthers', async () => {
    const f = fake((c) => {
      if (c[0] === 'bad') throw Object.assign(new Error('x'), { name: 'AccessDenied' });
      return undefined;
    });
    const r = await ingestOnce({ lookup: f.fn, now: NOW, accounts: ['bad', A] });
    expect(r.failed).toEqual(['bad']);
    expect(r.added).toBe(1);
    const s = await readState();
    expect(s.accounts['bad:ap-northeast-2'].lastError).toBe('AccessDenied');
    expect(s.accounts[`${A}:ap-northeast-2`].lastError).toBeUndefined();
  });

  it('pagesFollowNextToken', async () => {
    const f = fake((c) => {
      if (c[1] === 'ap-northeast-2' && c[2].eventName === 'CreateBucket') {
        return Promise.resolve(c[2].nextToken ? { events: [] } : { events: [], nextToken: 't1' });
      }
      return undefined;
    });
    await ingestOnce({ lookup: f.fn, now: NOW, accounts: [A] });
    const cb = f.calls.filter((c) => c[2].eventName === 'CreateBucket');
    expect(cb.map((c) => c[2].nextToken)).toEqual([undefined, 't1']);
  });

  it('incrementalHonoursMaxPages', async () => {
    const f = fake((c) => (c[2].readOnlyFalse ? Promise.resolve({ events: [], nextToken: 'more' }) : undefined));
    await ingestOnce({ lookup: f.fn, now: NOW, accounts: [A], maxPagesPerCall: 3 });
    expect(f.calls.filter((c) => c[1] === 'ap-northeast-2' && c[2].readOnlyFalse).length).toBe(3);
  });

  it('stateRecordsLastRunAndClearsError', async () => {
    let fail = true;
    const f = fake(() => { if (fail) throw Object.assign(new Error('x'), { name: 'Boom' }); return undefined; });
    await ingestOnce({ lookup: f.fn, now: NOW, accounts: [A] });
    expect((await readState()).accounts[`${A}:ap-northeast-2`].lastError).toBe('Boom');
    fail = false;
    const later = new Date(NOW.getTime() + 600_000);
    await ingestOnce({ lookup: fake().fn, now: later, accounts: [A] });
    const st = (await readState()).accounts[`${A}:ap-northeast-2`];
    expect(st.lastError).toBeUndefined();
    expect(st.lastRunAt).toBe(later.toISOString());
    expect(st.lastTo).toBe(later.toISOString());
  });
});
