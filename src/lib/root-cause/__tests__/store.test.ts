// Incident store tests on a temp dir. / 사건 저장소 시험 — 임시 디렉터리 사용.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readIncidents, rootCauseDir, updateIncidents, writeIncidents } from '../store';
import type { Incident } from '../types';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-store-'));
  process.env.ROOT_CAUSE_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.ROOT_CAUSE_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const inc = (id: string): Incident => ({ id, key: `manual|${id}`, accountId: '111111111111', region: 'ap-northeast-2', resourceArn: null, resourceName: null, signals: [], startedAt: '2026-10-29T12:00:00.000Z', firstSeenAt: '2026-10-29T12:00:00.000Z', lastSeenAt: '2026-10-29T12:00:00.000Z', status: 'open', source: 'manual' });

describe('root-cause store', () => {
  it('uses the env override', () => expect(rootCauseDir()).toBe(dir));
  it('missing file -> []', async () => expect(await readIncidents()).toEqual([]));
  it('write then read round-trips, no tmp left', async () => {
    await writeIncidents([inc('rc-a')]);
    expect((await readIncidents()).map((i) => i.id)).toEqual(['rc-a']);
    expect(fs.readdirSync(dir)).toEqual(['incidents.json']);
  });
  it('corrupt file is moved aside and reads as []', async () => {
    fs.writeFileSync(path.join(dir, 'incidents.json'), '{"broken');
    expect(await readIncidents()).toEqual([]);
    const names = fs.readdirSync(dir);
    const aside = names.find((n) => n.startsWith('incidents.json.corrupt-'));
    expect(aside).toBeTruthy();
    expect(fs.readFileSync(path.join(dir, aside!), 'utf8')).toBe('{"broken');
  });
  it('concurrent updateIncidents are both applied', async () => {
    await Promise.all([
      updateIncidents((l) => [inc('rc-1'), ...l]),
      updateIncidents((l) => [inc('rc-2'), ...l]),
    ]);
    expect((await readIncidents()).map((i) => i.id).sort()).toEqual(['rc-1', 'rc-2']);
  });
  it('a failing update does not break the chain', async () => {
    await expect(updateIncidents(() => { throw new Error('x'); })).rejects.toThrow('x');
    await updateIncidents((l) => [inc('rc-3'), ...l]);
    expect((await readIncidents()).map((i) => i.id)).toEqual(['rc-3']);
  });
});
