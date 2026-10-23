// Cost Radar JSON persistence helpers (atomic write, overridable directory).
// 비용 레이더 JSON 저장 도우미 (원자적 쓰기, 디렉터리 재정의 가능).
import fs from 'node:fs';
import path from 'node:path';

/** data/cost-radar under cwd; COST_RADAR_DATA_DIR overrides it (tests). / 테스트용 환경변수로 재정의 가능. */
export function costRadarDir(): string {
  return process.env.COST_RADAR_DATA_DIR || path.join(process.cwd(), 'data', 'cost-radar');
}

/** Read JSON; missing or corrupt file → fallback. / 없거나 깨진 파일이면 fallback. */
export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(costRadarDir(), name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write temp file in the same directory, then rename. / 같은 디렉터리에 임시 파일 후 rename. */
export async function writeJsonAtomic(name: string, value: unknown): Promise<void> {
  const dir = costRadarDir();
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
