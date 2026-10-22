// Health API — exposes the in-server health monitor (GET status, POST admin actions).
// 헬스 API — 서버 내장 헬스 모니터 상태 조회(GET)와 관리자 전용 동작(POST).
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth-utils';
import { getConfig } from '@/lib/app-config';
import { ensureHealthMonitorStarted, getHealthSnapshot, runOnce } from '@/lib/health/monitor';
import { sendTestMessage, CHECK_TITLES } from '@/lib/health/slack';
import { CHECK_IDS } from '@/lib/health/types';

export const dynamic = 'force-dynamic';

// Same admin rule as steampipe/route.ts / steampipe/route.ts와 동일한 관리자 규칙
function isAdminRequest(request: NextRequest): boolean {
  const user = getUserFromRequest(request);
  const adminEmails = getConfig().adminEmails || [];
  return user.email !== 'anonymous' && (adminEmails.length === 0 || adminEmails.includes(user.email));
}

function buildPayload(isAdmin: boolean) {
  const snap = getHealthSnapshot();
  const items = CHECK_IDS.map(id => {
    const s = snap.state[id];
    return {
      id,
      title: CHECK_TITLES[id],
      status: s.status,
      message: s.message,
      lastChecked: s.lastChecked,
      since: s.since,
    };
  });
  return {
    items,
    lastRunAt: snap.lastRunAt,
    lastSlack: snap.lastSlack,
    failing: items.filter(i => i.status === 'fail').length,
    isAdmin,
  };
}

export async function GET(request: NextRequest) {
  ensureHealthMonitorStarted();
  return NextResponse.json(buildPayload(isAdminRequest(request)));
}

export async function POST(request: NextRequest) {
  ensureHealthMonitorStarted();
  let body: { action?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (body.action !== 'test' && body.action !== 'run') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }
  if (body.action === 'test') {
    const result = await sendTestMessage();
    return NextResponse.json(result);
  }
  await runOnce({ includeSlow: true });
  return NextResponse.json(buildPayload(true));
}
