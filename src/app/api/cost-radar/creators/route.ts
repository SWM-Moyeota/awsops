import { NextRequest, NextResponse } from 'next/server';
import { ensureHealthMonitorStarted } from '@/lib/health/monitor';
import { getConfig } from '@/lib/app-config';
import { lookupCreators } from '@/lib/cost-radar/creators';
import { parseCreatorIds, RadarInputError } from '@/lib/cost-radar/radar';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  ensureHealthMonitorStarted();
  try {
    const ids = (getConfig().accounts || []).map((a) => a.accountId);
    const items = parseCreatorIds(request.nextUrl.searchParams.get('ids'), ids);
    const data = await lookupCreators(items);
    return NextResponse.json(data, { headers: HEADERS });
  } catch (e) {
    if (e instanceof RadarInputError) return NextResponse.json({ error: e.message }, { status: 400, headers: HEADERS });
    return NextResponse.json({ error: e instanceof Error ? e.name : 'Error' }, { status: 500, headers: HEADERS });
  }
}
