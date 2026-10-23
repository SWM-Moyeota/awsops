import { NextRequest, NextResponse } from 'next/server';
import { ensureHealthMonitorStarted } from '@/lib/health/monitor';
import { defaultDeps, getRadarResponse, RadarInputError } from '@/lib/cost-radar/radar';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  ensureHealthMonitorStarted();
  try {
    const accountId = request.nextUrl.searchParams.get('accountId') || '__all__';
    const data = await getRadarResponse(accountId, await defaultDeps());
    return NextResponse.json(data, { headers: HEADERS });
  } catch (e) {
    if (e instanceof RadarInputError) return NextResponse.json({ error: e.message }, { status: 400, headers: HEADERS });
    return NextResponse.json({ error: e instanceof Error ? e.name : 'Error' }, { status: 500, headers: HEADERS });
  }
}
