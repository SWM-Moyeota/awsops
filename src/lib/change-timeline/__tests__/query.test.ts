import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRecords, writeState } from '../store';
import { queryChanges, findCreators, searchByText, rangeStart, isBackfillComplete } from '../query';
import type { ChangeRecord } from '../types';
import { rec } from './helpers';

const NOW = new Date('2026-10-26T00:00:00Z');
const q = (o: object = {}) => ({ accountId: '__all__', range: '30d' as const, now: NOW, ...o });
const P = (n: string) => ({ kind: 'person' as const, name: n });
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-query-')); process.env.CHANGE_TIMELINE_DATA_DIR = dir; });
afterEach(() => { delete process.env.CHANGE_TIMELINE_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

describe('queryChanges', () => {
  it('rangeStart', () => {
    expect(rangeStart('24h', NOW).toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(rangeStart('7d', NOW).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(rangeStart('all', NOW).getTime()).toBe(0);
  });
  it('summaryCountsPeopleNotAuto', async () => {
    await appendRecords([
      rec('1', '2026-10-20T00:00:00Z', { actor: P('sungyoon') }),
      rec('2', '2026-10-20T01:00:00Z', { actor: P('jiwoo') }),
      rec('3', '2026-10-20T02:00:00Z', { actor: P('minsu') }),
      rec('4', '2026-10-20T03:00:00Z', { actor: P('sungyoon') }),
      rec('5', '2026-10-20T04:00:00Z', { kind: 'delete', actor: P('sungyoon') }),
      rec('6', '2026-10-20T05:00:00Z', { actor: { kind: 'auto', name: 'CloudFormation' } }),
    ]);
    const r = await queryChanges(q());
    // Spec §4: auto rows count toward creates/deletes, but not toward the people count.
    expect(r.summary).toEqual({ creates: 5, deletes: 1, people: 3 });
  });
  it('filtersByKindActorTypeAndText', async () => {
    await appendRecords([
      rec('1', '2026-10-20T00:00:00Z', { actor: P('a'), resourceName: 'Alpha-Web' }),
      rec('2', '2026-10-20T01:00:00Z', { actor: P('b'), kind: 'delete', resourceType: 's3-bucket', resourceName: 'logs', resourceId: 'logs' }),
    ]);
    expect((await queryChanges(q({ kind: 'delete' }))).records.map((r) => r.id)).toEqual(['2']);
    expect((await queryChanges(q({ actor: 'a' }))).records.map((r) => r.id)).toEqual(['1']);
    expect((await queryChanges(q({ resourceType: 's3-bucket' }))).records.map((r) => r.id)).toEqual(['2']);
    const t = await queryChanges(q({ q: 'alpha' }));
    expect(t.records.map((r) => r.id)).toEqual(['1']);
    expect(t.facets.people.sort()).toEqual(['a', 'b']);
    expect(t.facets.resourceTypes.sort()).toEqual(['ec2-instance', 's3-bucket']);
  });
  it('hidesFailed', async () => {
    await appendRecords([rec('1', '2026-10-20T00:00:00Z', { failed: true }), rec('2', '2026-10-20T01:00:00Z')]);
    expect((await queryChanges(q())).records.map((r) => r.id)).toEqual(['2']);
  });
  it('allAccountsVsOne', async () => {
    await appendRecords([rec('1', '2026-10-20T00:00:00Z'), rec('2', '2026-10-20T01:00:00Z', { accountId: '222222222222' })]);
    expect((await queryChanges(q())).records.length).toBe(2);
    expect((await queryChanges(q({ accountId: '222222222222' }))).records.map((r) => r.id)).toEqual(['2']);
  });
  it('capsAt500WithTruncated', async () => {
    const rs: ChangeRecord[] = [];
    for (let i = 0; i < 510; i++) rs.push(rec(`r${i}`, new Date(Date.UTC(2026, 9, 20, 0, 0, i)).toISOString()));
    await appendRecords(rs);
    const r = await queryChanges(q({ range: '7d' }));
    expect(r.records.length).toBe(500);
    expect(r.truncated).toBe(true);
    expect(r.records[0].id).toBe('r509');
    expect(r.summary.creates).toBe(510);
  });
  it('statusReportsBackfillingAndFailures', async () => {
    await writeState({ accounts: {
      '111111111111:ap-northeast-2': { backfillFrom: '2026-08-01T00:00:00Z', backfillDone: ['A', 'B'], lastTo: 'x', lastRunAt: '2026-10-25T00:00:00Z' },
      '222222222222:ap-northeast-2': { backfillFrom: '2026-09-01T00:00:00Z', backfillDone: ['A'], lastRunAt: '2026-10-25T05:00:00Z', lastError: 'Throttling' },
    } });
    const r = await queryChanges(q(), { namesFor: () => ['A', 'B'] });
    expect(r.status).toEqual({ coverageFrom: '2026-08-01T00:00:00Z', lastIngestAt: '2026-10-25T05:00:00Z', backfilling: true, failedAccounts: ['222222222222'] });
    const r2 = await queryChanges(q({ accountId: '111111111111' }), { namesFor: () => ['A', 'B'] });
    expect(r2.status.backfilling).toBe(false);
  });
  it('isBackfillComplete', () => {
    const s = { backfillFrom: 'x', backfillDone: ['A'] };
    expect(isBackfillComplete(s, ['A'])).toBe(true);
    expect(isBackfillComplete(s, ['A', 'B'])).toBe(false);
    expect(isBackfillComplete(s, [])).toBe(false);
    expect(isBackfillComplete({ ...s, lastTo: 'y' }, [])).toBe(true);
  });
});

describe('findCreators', () => {
  const state = { accounts: { '111111111111:ap-northeast-2': { backfillFrom: '2026-09-01T00:00:00Z', backfillDone: [] } } };
  it('findCreatorsFoundTooOldNone', async () => {
    await writeState(state);
    await appendRecords([rec('1', '2026-10-01T00:00:00Z', { actor: P('old'), resourceId: 'i-1' }), rec('2', '2026-10-05T00:00:00Z', { actor: P('new'), resourceId: 'i-1', tool: 'cli' }),
      rec('3', '2026-10-05T00:00:00Z', { resourceType: 's3-bucket', resourceId: 'b', resourceName: 'my-bucket', actor: P('s3') })]);
    const r = await findCreators([
      '111111111111:i-1',
      { key: '111111111111:i-old', createdAt: '2026-01-01T00:00:00Z' },
      { key: '111111111111:i-newer', createdAt: '2026-10-10T00:00:00Z' },
      '111111111111:my-bucket',
      '222222222222:i-1',
    ]);
    expect(r[0]).toMatchObject({ key: '111111111111:i-1', status: 'found', time: '2026-10-05T00:00:00Z', tool: 'cli' });
    expect(r[0].actor?.name).toBe('new');
    expect(r[1].status).toBe('too-old');
    expect(r[2].status).toBe('none');
    expect(r[3]).toMatchObject({ status: 'found', actor: P('s3') });
    expect(r[4].status).toBe('none');
  });
  it('findCreatorsReportsLaterDelete', async () => {
    await writeState(state);
    await appendRecords([rec('1', '2026-10-01T00:00:00Z', { resourceId: 'i-1' }),
      rec('2', '2026-10-03T00:00:00Z', { resourceId: 'i-1', kind: 'delete' }),
      rec('3', '2026-10-04T00:00:00Z', { resourceId: 'i-1', kind: 'delete' })]);
    const [r] = await findCreators(['111111111111:i-1']);
    expect(r.status).toBe('found');
    expect(r.deletedAt).toBe('2026-10-04T00:00:00Z');
  });
});

describe('searchByText', () => {
  it('searchByTextExactFirst', async () => {
    await appendRecords([rec('1', '2026-10-01T00:00:00Z', { resourceName: 'web' }), rec('2', '2026-10-02T00:00:00Z', { resourceName: 'web-api' })]);
    expect((await searchByText('web')).map((r) => r.id)).toEqual(['1']);
    expect((await searchByText('web-')).map((r) => r.id)).toEqual(['2']);
    expect(await searchByText('zzz')).toEqual([]);
  });
});

describe('rdsCaseInsensitive', () => {
  it('matchesLowercaseStoredRdsIds', async () => {
    const { rec } = await import('./helpers');
    const r = rec('d', '2026-10-01T00:00:00Z', { resourceType: 'rds-instance', resourceId: 'moyeota-dev-db', resourceName: 'moyeota-dev-db' });
    const out = await findCreators([`${r.accountId}:MoYeota-Dev-DB`], { read: async () => [r], state: async () => ({ accounts: {} }) as never });
    expect(out[0].status).toBe('found');
  });
});

describe('state kinds', () => {
  it('summaryStillCountsCreateDeleteOnly', async () => {
    const now = new Date('2026-10-26T06:00:00Z');
    const recs = [
      rec('a', '2026-10-26T05:00:00Z', { kind: 'create' }),
      rec('b', '2026-10-26T04:00:00Z', { kind: 'delete' }),
      rec('c', '2026-10-26T03:00:00Z', { kind: 'stop', actor: P('scheduler-bob') }),
      rec('d', '2026-10-26T02:00:00Z', { kind: 'start', actor: P('scheduler-bob') }),
      rec('e', '2026-10-26T01:00:00Z', { kind: 'modify', actor: P('dba-kim') }),
    ];
    const deps = { read: async () => recs, state: async () => ({ accounts: {} }) };
    const all = await queryChanges({ accountId: '__all__', range: '7d', now }, deps);
    expect(all.records).toHaveLength(5);
    // stop/start/modify actors are not counted: the summary stays create/delete only
    expect(all.summary).toEqual({ creates: 1, deletes: 1, people: 1 });
    expect(all.facets.people).toEqual(['sungyoon']);
    const st = await queryChanges({ accountId: '__all__', range: '7d', now, kinds: ['stop', 'start'] }, deps);
    expect(st.records.map((r) => r.id)).toEqual(['c', 'd']);
    expect(st.summary).toEqual({ creates: 0, deletes: 0, people: 0 });
    // the state view still offers its own people as filter choices
    expect(st.facets.people).toEqual(['scheduler-bob']);
  });
  it('searchByTextIgnoresStateAndModify', async () => {
    const recs = [
      rec('a', '2026-10-26T05:00:00Z', { kind: 'create', resourceName: 'web' }),
      rec('b', '2026-10-26T04:00:00Z', { kind: 'stop', resourceName: 'web' }),
      rec('c', '2026-10-26T03:00:00Z', { kind: 'modify', resourceName: 'web' }),
    ];
    const hits = await searchByText('web', { read: async () => recs });
    expect(hits.map((r) => r.id)).toEqual(['a']);
  });
  it('peopleCountsCreateDeleteActorsOnly', async () => {
    const now = new Date('2026-10-26T06:00:00Z');
    const recs = [
      rec('a', '2026-10-26T05:00:00Z', { kind: 'create', actor: P('jiwoo') }),
      rec('b', '2026-10-26T04:00:00Z', { kind: 'delete', actor: P('minsu') }),
      rec('c', '2026-10-26T03:00:00Z', { kind: 'stop', actor: P('ops-a') }),
      rec('d', '2026-10-26T02:00:00Z', { kind: 'modify', actor: P('ops-b') }),
      rec('e', '2026-10-26T01:00:00Z', { kind: 'start', actor: { kind: 'root', name: 'root' } }),
    ];
    const r = await queryChanges({ accountId: '__all__', range: '7d', now }, { read: async () => recs, state: async () => ({ accounts: {} }) });
    expect(r.summary.people).toBe(2);
    expect(r.facets.people).toEqual(['jiwoo', 'minsu']);
  });
  it('recordCapIs500ForShortRangesAnd1000ForLongOnes', async () => {
    const now = new Date('2026-10-26T06:00:00Z');
    const recs = Array.from({ length: 1200 }, (_, i) => rec(`r${i}`, new Date(now.getTime() - (i + 1) * 60_000).toISOString()));
    const deps = { read: async () => recs, state: async () => ({ accounts: {} }) };
    for (const [range, cap] of [['24h', 500], ['7d', 500], ['30d', 1000], ['90d', 1000], ['all', 1000]] as const) {
      const r = await queryChanges({ accountId: '__all__', range, now }, deps);
      expect(r.records, range).toHaveLength(cap);
      expect(r.truncated, range).toBe(true);
      expect(r.records[0].id).toBe('r0'); // newest first
    }
  });
});
