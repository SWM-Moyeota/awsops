// In-server dep-graph rebuild loop: snapshot at boot, first build after 60 s, then every 15 min, never overlapping.
// 서버 안 그래프 재빌드 루프: 기동 때 스냅샷, 60초 후 첫 빌드, 이후 15분마다. 겹치지 않는다(runBuildOnce).
import { loadSnapshot, rebuildGraph, runBuildOnce } from './build';
import type { BuildStats } from './types';

export const BUILD_INTERVAL_MS = 900_000;
const FIRST_RUN_DELAY_MS = 60_000;

interface LoopState { started: boolean; timer: NodeJS.Timeout | null }
declare global {
  // eslint-disable-next-line no-var
  var __awsopsDepGraphLoop: LoopState | undefined;
}

function loop(): LoopState {
  return (globalThis.__awsopsDepGraphLoop ??= { started: false, timer: null });
}

const errName = (e: unknown) => (e instanceof Error ? e.name : 'Error');
const isStats = (v: unknown): v is BuildStats => !!v && typeof v === 'object' && 'nodeCounts' in v;

/** One rebuild through the shared lock (ignores ensureGraph's cooldown). / 공용 잠금으로 재빌드 한 번 — 쿨다운은 무시. */
export async function tick(): Promise<void> {
  try {
    // If another build is running this joins it instead of starting a second one.
    // 다른 빌드가 돌고 있으면 새로 시작하지 않고 그 결과를 기다린다.
    let st = await runBuildOnce(() => rebuildGraph());
    // Joined a snapshot load instead of a build: run the real build now.
    // 스냅샷 적재에 합류했다면 이번 회차 빌드를 바로 이어서 한다.
    if (!isStats(st)) st = await runBuildOnce(() => rebuildGraph());
    if (isStats(st)) {
      const nodes = Object.values(st.nodeCounts).reduce((a: number, n) => a + (n ?? 0), 0);
      console.log(`[dep-graph] built: ${nodes} nodes, ${st.edgeCount} edges`);
    }
  } catch (e) {
    console.error('[dep-graph] build failed:', errName(e));
  }
}

export function ensureDepGraphStarted(): void {
  const s = loop();
  if (s.started || process.env.NODE_ENV !== 'production') return;
  s.started = true;
  // Load the last snapshot right away so Slack cards get graph lines after a restart.
  // 재시작 직후에도 Slack 카드에 그래프 줄이 나오도록 마지막 스냅샷을 바로 적재한다.
  runBuildOnce(() => loadSnapshot()).catch((e) => console.error('[dep-graph] snapshot load failed:', errName(e)));
  const first = setTimeout(() => {
    void tick();
    s.timer = setInterval(() => void tick(), BUILD_INTERVAL_MS);
    s.timer.unref?.();
  }, FIRST_RUN_DELAY_MS);
  first.unref?.();
}
