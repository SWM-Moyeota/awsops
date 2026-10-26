// GET /api/cost-radar/explain — why the monthly estimate changed (Cost Detective), from snapshots + change records.
// 돈 탐정 — 월 예상 비용이 왜 바뀌었는지 (스냅샷 + 변경 기록, CloudTrail·Steampipe 추가 호출 없음).
import { NextRequest, NextResponse } from 'next/server';
import { ensureHealthMonitorStarted } from '@/lib/health/monitor';
import { explainChange } from '@/lib/cost-radar/explain';
import { RadarInputError } from '@/lib/cost-radar/radar';
import type { ExplainDays } from '@/lib/cost-radar/types';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'no-store' };
const DAYS = new Map<string, ExplainDays>([['1', 1], ['7', 7], ['30', 30]]);

const bad = (error: string) => NextResponse.json({ error }, { status: 400, headers: HEADERS });

export async function GET(request: NextRequest) {
  ensureHealthMonitorStarted();
  const p = request.nextUrl.searchParams;
  const accountId = p.get('accountId') || '__all__';
  const days = DAYS.get(p.get('days') || '7');
  if (accountId !== '__all__' && !/^\d{12}$/.test(accountId)) return bad('invalid accountId');
  if (!days) return bad('invalid days');
  try {
    const data = await explainChange({ accountId, days });
    return NextResponse.json(data, { headers: HEADERS });
  } catch (e) {
    if (e instanceof RadarInputError) return bad(e.message);
    return NextResponse.json({ error: e instanceof Error ? e.name : 'Error' }, { status: 500, headers: HEADERS });
  }
}
