// Execution records (data/action-plan/executions/<id>.json) — inverse operations for undo live here.
// 실행 기록 저장소. 되돌리기용 역연산이 들어 있다.
import fs from 'node:fs';
import path from 'node:path';
import { actionPlanDir } from './audit';
import type { ExecutionRecord } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function execFile(id: string): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('invalid execution id');
  return path.join(actionPlanDir(), 'executions', `${id}.json`);
}

/** Atomic (tmp + rename). Throws on an invalid id or write failure — callers decide how to react. */
export function saveExecution(rec: ExecutionRecord): void {
  const file = execFile(rec.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function loadExecution(id: string): ExecutionRecord | null {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(execFile(id), 'utf8')) as ExecutionRecord;
  } catch {
    return null;
  }
}
