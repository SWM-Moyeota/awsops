// Job and stats store / 작업·지표 저장소
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { saveJob, readJobs, readStats, addStats, jobDir, tfExportDir, MAX_JOBS } from '../store';
import type { JobRecord, JobStats } from '../types';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfx-store-'));
  process.env.TF_EXPORT_DATA_DIR = dir;
  globalThis.__awsopsTfExport = undefined;
});
afterEach(() => {
  delete process.env.TF_EXPORT_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const job = (n: number): JobRecord => ({
  id: `20261029-${String(n).padStart(6, '0')}-abcdef`,
  accountId: '111122223333', region: 'ap-northeast-2', seed: { kind: 'prefix', prefix: 'x' }, requestedBy: null,
  startedAt: new Date(Date.UTC(2026, 9, 29, 0, 0, n)).toISOString(), stage: 'done', items: [], excluded: [], results: [],
});

describe('store', () => {
  it('uses TF_EXPORT_DATA_DIR and rejects bad job ids', () => {
    expect(tfExportDir()).toBe(dir);
    expect(() => jobDir('../etc')).toThrow('BadJobId');
  });

  it('upserts newest first, keeps 20 and deletes older job folders', async () => {
    for (let n = 0; n < 23; n++) {
      const j = job(n);
      fs.mkdirSync(jobDir(j.id), { recursive: true });
      await saveJob(j);
    }
    const list = await readJobs();
    expect(list.length).toBe(MAX_JOBS);
    expect(list[0].id).toBe(job(22).id);
    expect(list[list.length - 1].id).toBe(job(3).id);
    for (const n of [0, 1, 2]) expect(fs.existsSync(jobDir(job(n).id))).toBe(false);
    expect(fs.existsSync(jobDir(job(3).id))).toBe(true);
    await saveJob({ ...job(10), stage: 'failed', error: 'Timeout' });
    const again = await readJobs();
    expect(again.length).toBe(MAX_JOBS);
    expect(again.find(j => j.id === job(10).id)?.error).toBe('Timeout');
  });

  it('moves a corrupt jobs file aside', async () => {
    fs.writeFileSync(path.join(dir, 'jobs.json'), '{nope');
    expect(await readJobs()).toEqual([]);
    expect(fs.readdirSync(dir).some(f => f.startsWith('jobs.json.corrupt-'))).toBe(true);
  });

  it('accumulates stats', async () => {
    const s: JobStats = { total: 10, passRules: 6, passAi: 9, passFinal: 8, pure: 6, ignore: 2, failed: 2, byType: { aws_vpc: { total: 1, pass: 1 }, aws_instance: { total: 2, pass: 1 } }, aiCalls: 3, inputTokens: 100, outputTokens: 50 };
    expect((await readStats()).jobs).toBe(0);
    await addStats(s);
    const t = await addStats({ ...s, byType: { aws_instance: { total: 1, pass: 1 } } });
    expect(t).toMatchObject({ jobs: 2, total: 20, passRules: 12, passAi: 18, passFinal: 16, pure: 12, ignore: 4, failed: 4, aiCalls: 6, inputTokens: 200, outputTokens: 100 });
    expect(t.byType).toEqual({ aws_vpc: { total: 1, pass: 1 }, aws_instance: { total: 3, pass: 2 } });
    expect(await readStats()).toEqual(t);
  });
});
