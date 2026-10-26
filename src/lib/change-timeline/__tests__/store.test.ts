import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRecords, readRecords, readState, writeState, timelineDir } from '../store';
import { rec } from './helpers';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-store-')); process.env.CHANGE_TIMELINE_DATA_DIR = dir; });
afterEach(() => { delete process.env.CHANGE_TIMELINE_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

describe('store', () => {
  it('appendRecordsDedupes', async () => {
    const rs = [rec('a', '2026-10-01T00:00:00Z'), rec('b', '2026-10-02T00:00:00Z')];
    expect(await appendRecords(rs)).toBe(2);
    expect(await appendRecords(rs)).toBe(0);
    const file = JSON.parse(fs.readFileSync(path.join(timelineDir(), 'records-2026-10.json'), 'utf8'));
    expect(Object.keys(file).sort()).toEqual(['a', 'b']);
  });
  it('readsAcrossMonths', async () => {
    await appendRecords([rec('a', '2026-08-31T23:00:00Z'), rec('b', '2026-09-15T00:00:00Z'), rec('c', '2026-10-02T00:00:00Z')]);
    const got = await readRecords(new Date('2026-09-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z'));
    expect(got.map((r) => r.id).sort()).toEqual(['b', 'c']);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('records-')).length).toBe(3);
  });
  it('missingDirReturnsEmpty', async () => {
    process.env.CHANGE_TIMELINE_DATA_DIR = path.join(dir, 'nope');
    expect(await readRecords(new Date(0), new Date())).toEqual([]);
    expect(await readState()).toEqual({ accounts: {} });
  });
  it('writeStateRoundTrips', async () => {
    const s = { accounts: { '1:ap-northeast-2': { backfillFrom: 'x', backfillDone: ['A'] } } };
    await writeState(s);
    expect(await readState()).toEqual(s);
  });
  it('corruptMonthFileIsPreservedNotReplaced', async () => {
    const f = path.join(dir, 'records-2026-10.json');
    fs.writeFileSync(f, '{"a": {"id":"a"');
    expect(await appendRecords([rec('b', '2026-10-02T00:00:00Z')])).toBe(1);
    const aside = fs.readdirSync(dir).filter((n) => n.startsWith('records-2026-10.json.corrupt-'));
    expect(aside.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe('{"a": {"id":"a"');
    expect(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')))).toEqual(['b']);
  });
  it('unreadableMonthFileThrowsAndIsUntouched', async () => {
    const f = path.join(dir, 'records-2026-10.json');
    fs.mkdirSync(f); // reading a directory -> EISDIR, not ENOENT
    await expect(appendRecords([rec('b', '2026-10-02T00:00:00Z')])).rejects.toBeTruthy();
    expect(fs.statSync(f).isDirectory()).toBe(true);
    fs.rmdirSync(f);
    expect(await appendRecords([rec('c', '2026-10-02T00:00:00Z')])).toBe(1); // chain still works
  });
});
