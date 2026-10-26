// Change timeline JSON store: monthly record files + ingest state, atomic writes.
// 변경 기록 JSON 저장소: 월별 기록 파일 + 수집 상태, 원자적 쓰기.
import fs from 'node:fs';
import path from 'node:path';
import type { ChangeRecord, IngestState } from './types';

const STATE_FILE = 'state.json';
const MONTH_FILE = /^records-(\d{4})-(\d{2})\.json$/;

/** data/change-timeline under cwd; CHANGE_TIMELINE_DATA_DIR overrides it (tests). / 테스트용 환경변수로 재정의 가능. */
export function timelineDir(): string {
  return process.env.CHANGE_TIMELINE_DATA_DIR || path.join(process.cwd(), 'data', 'change-timeline');
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(timelineDir(), name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(name: string, value: unknown): Promise<void> {
  const dir = timelineDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(value));
    await fs.promises.rename(tmp, file);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Read a month file for read-modify-write. Missing (ENOENT) -> {}. Unparseable (corrupt/truncated)
 * -> renamed aside to `<file>.corrupt-<timestamp>` (history preserved), error name logged, start fresh.
 * Any other I/O error (EACCES, EIO, ...) is thrown so the append is skipped and the file is never overwritten.
 * 월 파일 읽기: 없으면 {}, 깨졌으면 .corrupt-* 로 옮겨 보존 후 새로 시작, 그 외 I/O 오류는 throw (덮어쓰기 금지).
 */
async function readMonthForWrite(name: string): Promise<Record<string, ChangeRecord>> {
  const file = path.join(timelineDir(), name);
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, ChangeRecord>;
    throw new SyntaxError('not an object');
  } catch (e) {
    console.error('[change-timeline] corrupt month file, moved aside:', e instanceof Error ? e.name : 'Error');
    await fs.promises.rename(file, `${file}.corrupt-${Date.now()}`);
    return {};
  }
}

const monthName = (iso: string) => `records-${iso.slice(0, 7)}.json`;

let chain: Promise<unknown> = Promise.resolve();
/** Serialise all writes on one promise chain. / 모든 쓰기를 하나의 체인으로 직렬화. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

/** Append records (dedupe by id); returns how many were new. / id로 중복 제거, 새로 추가된 수 반환. */
export function appendRecords(records: ChangeRecord[]): Promise<number> {
  return serial(async () => {
    const byFile = new Map<string, ChangeRecord[]>();
    for (const r of records) {
      const n = monthName(new Date(r.time).toISOString());
      byFile.set(n, [...(byFile.get(n) ?? []), r]);
    }
    let added = 0;
    for (const [name, rs] of Array.from(byFile.entries())) {
      const cur = await readMonthForWrite(name);
      let changed = false;
      for (const r of rs) {
        if (cur[r.id]) continue;
        cur[r.id] = r;
        added++;
        changed = true;
      }
      if (changed) await writeJsonAtomic(name, cur);
    }
    return added;
  });
}

/** Records with from <= time <= to; reads only overlapping months. / 겹치는 달만 읽는다. */
export async function readRecords(from: Date, to: Date): Promise<ChangeRecord[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(timelineDir());
  } catch {
    return [];
  }
  const lo = from.getUTCFullYear() * 12 + from.getUTCMonth();
  const hi = to.getUTCFullYear() * 12 + to.getUTCMonth();
  const out: ChangeRecord[] = [];
  for (const n of names) {
    const m = MONTH_FILE.exec(n);
    if (!m) continue;
    const idx = Number(m[1]) * 12 + Number(m[2]) - 1;
    if (idx < lo || idx > hi) continue;
    const file = await readJson<Record<string, ChangeRecord>>(n, {});
    for (const r of Object.values(file)) {
      const t = new Date(r.time).getTime();
      if (t >= from.getTime() && t <= to.getTime()) out.push(r);
    }
  }
  return out;
}

export async function readState(): Promise<IngestState> {
  const s = await readJson<IngestState | null>(STATE_FILE, null);
  return s && typeof s === 'object' && s.accounts ? s : { accounts: {} };
}

export function writeState(s: IngestState): Promise<void> {
  return serial(() => writeJsonAtomic(STATE_FILE, s));
}
