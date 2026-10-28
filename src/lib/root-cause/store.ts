// Root-cause incident JSON store: one file, atomic writes, writes serialized on one chain.
// 장애 원인 분석 사건 JSON 저장소 — 파일 하나, 원자적 쓰기, 하나의 체인으로 직렬화.
import fs from 'node:fs';
import path from 'node:path';
import type { Incident } from './types';
import { MAX_INCIDENTS } from './incidents';

const FILE = 'incidents.json';

// Process-wide state shared by store, queue and loop (Next.js may load modules twice). / 저장소·큐·루프가 나눠 쓰는 프로세스 전역 상태.
export interface RootCauseState {
  writes: Promise<unknown>;
  queue: Promise<unknown>;
  lastManualAt: number;
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
  notifier: ((inc: Incident) => Promise<unknown>) | null;
}
declare global {
  // eslint-disable-next-line no-var
  var __awsopsRootCause: RootCauseState | undefined;
}
export function rootCauseState(): RootCauseState {
  return (globalThis.__awsopsRootCause ??= { writes: Promise.resolve(), queue: Promise.resolve(), lastManualAt: 0, started: false, running: false, timer: null, notifier: null });
}

/** data/root-cause under cwd; ROOT_CAUSE_DATA_DIR overrides it (tests). / 테스트용 환경변수로 재정의 가능. */
export function rootCauseDir(): string {
  return process.env.ROOT_CAUSE_DATA_DIR || path.join(process.cwd(), 'data', 'root-cause');
}

/**
 * Missing -> []. Unparseable -> moved to `.corrupt-<ts>` (kept), []. Other I/O errors are thrown so nothing is overwritten.
 * 없으면 [], 깨졌으면 .corrupt-* 로 옮겨 보존 후 [], 그 외 I/O 오류는 throw (덮어쓰기 금지).
 */
export async function readIncidents(): Promise<Incident[]> {
  const file = path.join(rootCauseDir(), FILE);
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return v as Incident[];
    throw new SyntaxError('not an array');
  } catch (e) {
    console.error('[root-cause] corrupt incidents file, moved aside:', e instanceof Error ? e.name : 'Error');
    await fs.promises.rename(file, `${file}.corrupt-${Date.now()}`);
    return [];
  }
}

/** Write the newest 200 via tmp + rename. / 최근 200건을 임시 파일 + rename으로 쓴다. */
export async function writeIncidents(list: Incident[]): Promise<void> {
  const dir = rootCauseDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(list.slice(0, MAX_INCIDENTS)));
    await fs.promises.rename(tmp, file);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Read-modify-write on one promise chain; returns the saved list. / 하나의 체인에서 읽고-바꾸고-쓴다. */
export function updateIncidents(fn: (list: Incident[]) => Incident[]): Promise<Incident[]> {
  const s = rootCauseState();
  const p = s.writes.then(async () => {
    const next = fn(await readIncidents()).slice(0, MAX_INCIDENTS);
    await writeIncidents(next);
    return next;
  });
  s.writes = p.catch(() => undefined);
  return p;
}
