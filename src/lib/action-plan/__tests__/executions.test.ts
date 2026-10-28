import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadExecution, saveExecution } from '../executions';
import type { ExecutionRecord } from '../types';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-exec-')); process.env.ACTION_PLAN_DATA_DIR = dir; });
afterEach(() => { delete process.env.ACTION_PLAN_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

const ID = '123e4567-e89b-42d3-a456-426614174000';
const rec = (id: string): ExecutionRecord => ({
  id, executedAt: '2026-10-28T00:00:00Z', requesterId: 'U1', approverId: 'U2', channel: 'C', threadTs: '1',
  results: [{ index: 0, status: 'done', requestId: 'r-1' }],
});

describe('executions', () => {
  it('executionRoundTripsAndRejectsPathTraversalIds', () => {
    saveExecution(rec(ID));
    expect(loadExecution(ID)).toEqual(rec(ID));
    expect(fs.readdirSync(path.join(dir, 'executions'))).toEqual([`${ID}.json`]);
    expect(loadExecution('123e4567-e89b-42d3-a456-426614174999')).toBeNull();
    for (const bad of ['../audit', '../../etc/passwd', `${ID}/../x`, '', 'abc']) {
      expect(loadExecution(bad)).toBeNull();
      expect(() => saveExecution(rec(bad))).toThrow();
    }
    expect(fs.existsSync(path.join(dir, 'audit.json'))).toBe(false);
  });
});
