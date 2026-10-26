// Production deps of the explain engine, loaded lazily so tests of explain.ts never touch disk or AWS.
// 돈 탐정 운영 의존성 — explain.ts 테스트가 디스크·AWS를 건드리지 않도록 지연 로드한다.
import type { ExplainDeps } from './explain';
import type { DailySnapshot } from './types';

// INTEGRATION (Task 1): replace these two stubs with
//   import { readSnapshot, listSnapshotDays } from './snapshots';
// Until then the engine always answers in timeline-only mode.
// 통합 시 Task 1의 snapshots.ts로 교체. 그 전에는 항상 기록 기반 추정 모드.
async function readSnapshot(_day: string): Promise<DailySnapshot | null> {
  return null;
}
async function listSnapshotDays(): Promise<string[]> {
  return [];
}

export async function defaultExplainDeps(): Promise<ExplainDeps> {
  const [{ readRecords }, radar] = await Promise.all([
    import('@/lib/change-timeline/store'),
    import('./radar'),
  ]);
  return {
    readSnapshot,
    listSnapshotDays,
    readRecords,
    // Cached radar response (5-min cache); validates the account id (RadarInputError → 400).
    // 캐시된 레이더 응답(5분), 계정 ID 검증(RadarInputError → 400).
    liveEstimate: async (accountId) => (await radar.getRadarResponse(accountId, await radar.defaultDeps())).estimate,
  };
}
