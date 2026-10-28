// Next.js server-start hook — runs once when `next start` boots (instrumentationHook in next.config.mjs).
// Next.js 서버 기동 훅 — `next start` 시 1회 실행.
export async function register() {
  // Keep the import inside this constant-folded branch so the edge build never bundles Node-only SDKs.
  // edge 빌드가 Node 전용 SDK를 묶지 않도록 import는 이 분기 안에만 둔다.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Slack ChatOps: connects only if its SSM tokens exist; never blocks or fails the server start.
    // Slack ChatOps: SSM 토큰이 있을 때만 연결, 서버 기동을 막거나 실패시키지 않는다.
    const { startSlackChatops } = await import('./lib/slack-chatops/bot');
    void startSlackChatops();
    // Change timeline: CloudTrail ingest loop (production only, never throws).
    // 변경 기록: CloudTrail 수집 루프 (프로덕션 전용).
    try {
      const { ensureChangeTimelineStarted } = await import('./lib/change-timeline/loop');
      ensureChangeTimelineStarted();
    } catch (e) {
      console.error('[change-timeline] start failed:', e instanceof Error ? e.name : 'Error');
    }
    // Dependency graph: Steampipe -> graph rebuild loop (production only, never throws).
    // 의존성 그래프: Steampipe 기반 재빌드 루프 (프로덕션 전용).
    try {
      const { ensureDepGraphStarted } = await import('./lib/dep-graph/loop');
      ensureDepGraphStarted();
    } catch (e) {
      console.error('[dep-graph] start failed:', e instanceof Error ? e.name : 'Error');
    }
  }
}
