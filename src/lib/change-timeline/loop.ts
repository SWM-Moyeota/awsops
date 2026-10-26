// In-server change-timeline ingest loop: first run after 30 s, then every 10 min, never overlapping.
// 서버 안 수집 루프: 시작 30초 후 첫 실행, 이후 10분마다. 겹쳐 실행하지 않는다.
import { ingestOnce } from './ingest';

export const INGEST_INTERVAL_MS = 10 * 60_000;
const FIRST_RUN_DELAY_MS = 30_000;

interface LoopState { started: boolean; running: boolean; timer: NodeJS.Timeout | null; summaryHook: (() => Promise<void>) | null }
declare global {
  // eslint-disable-next-line no-var
  var __awsopsChangeTimeline: LoopState | undefined;
}

function loop(): LoopState {
  return (globalThis.__awsopsChangeTimeline ??= { started: false, running: false, timer: null, summaryHook: null });
}

/** Task 7 registers the daily Slack summary here (avoids importing it). / 일일 요약 훅 등록. */
export function setDailySummaryHook(fn: () => Promise<void>): void {
  loop().summaryHook = fn;
}

export async function tick(): Promise<void> {
  const s = loop();
  if (s.running) return;
  s.running = true;
  try {
    await ingestOnce();
  } catch (e) {
    console.error('[change-timeline] tick failed:', e instanceof Error ? e.name : 'Error');
  }
  try {
    await s.summaryHook?.();
  } catch (e) {
    console.error('[change-timeline] summary failed:', e instanceof Error ? e.name : 'Error');
  } finally {
    s.running = false;
  }
}

export function ensureChangeTimelineStarted(): void {
  const s = loop();
  if (s.started || process.env.NODE_ENV !== 'production') return;
  s.started = true;
  const first = setTimeout(() => {
    void tick();
    s.timer = setInterval(() => void tick(), INGEST_INTERVAL_MS);
    s.timer.unref?.();
  }, FIRST_RUN_DELAY_MS);
  first.unref?.();
}
