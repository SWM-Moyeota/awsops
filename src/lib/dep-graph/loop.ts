// In-server dep-graph rebuild loop: first run after 60 s, then every 15 min, never overlapping.
// 서버 안 그래프 재빌드 루프: 60초 후 첫 실행, 이후 15분마다. 겹치지 않는다.
import { rebuildGraph } from './build';

export const BUILD_INTERVAL_MS = 900_000;
const FIRST_RUN_DELAY_MS = 60_000;

interface LoopState { started: boolean; running: boolean; timer: NodeJS.Timeout | null }
declare global {
  // eslint-disable-next-line no-var
  var __awsopsDepGraphLoop: LoopState | undefined;
}

function loop(): LoopState {
  return (globalThis.__awsopsDepGraphLoop ??= { started: false, running: false, timer: null });
}

export async function tick(): Promise<void> {
  const s = loop();
  if (s.running) return;
  s.running = true;
  try {
    const st = await rebuildGraph();
    const nodes = Object.values(st.nodeCounts).reduce((a, n) => a + (n ?? 0), 0);
    console.log(`[dep-graph] built: ${nodes} nodes, ${st.edgeCount} edges`);
  } catch (e) {
    console.error('[dep-graph] build failed:', e instanceof Error ? e.name : 'Error');
  } finally {
    s.running = false;
  }
}

export function ensureDepGraphStarted(): void {
  const s = loop();
  if (s.started || process.env.NODE_ENV !== 'production') return;
  s.started = true;
  const first = setTimeout(() => {
    void tick();
    s.timer = setInterval(() => void tick(), BUILD_INTERVAL_MS);
    s.timer.unref?.();
  }, FIRST_RUN_DELAY_MS);
  first.unref?.();
}
