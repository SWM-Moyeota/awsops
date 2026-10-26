import { NextRequest, NextResponse } from 'next/server';
import { ensureHealthMonitorStarted } from '@/lib/health/monitor';
import { ensureChangeTimelineStarted } from '@/lib/change-timeline/loop';
import { findCreators } from '@/lib/change-timeline/query';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'no-store' };
const MAX_IDS = 200;
const ID_RE = /^\d{12}:[^|,\s]{1,256}$/;

class InputError extends Error {}

// ids=acct:resourceId[|createdAtISO],... — key in the response has no date.
function parseIds(raw: string | null): { key: string; createdAt?: string }[] {
  if (!raw) throw new InputError('ids required');
  const parts = raw.split(',').filter(Boolean);
  if (!parts.length || parts.length > MAX_IDS) throw new InputError('invalid ids');
  return parts.map((p) => {
    const [key, createdAt, ...rest] = p.split('|');
    if (rest.length || !ID_RE.test(key)) throw new InputError('invalid id');
    if (createdAt !== undefined && Number.isNaN(new Date(createdAt).getTime())) throw new InputError('invalid date');
    return createdAt ? { key, createdAt } : { key };
  });
}

export async function GET(request: NextRequest) {
  ensureHealthMonitorStarted();
  ensureChangeTimelineStarted();
  try {
    const items = parseIds(request.nextUrl.searchParams.get('ids'));
    return NextResponse.json(await findCreators(items), { headers: HEADERS });
  } catch (e) {
    if (e instanceof InputError) return NextResponse.json({ error: e.message }, { status: 400, headers: HEADERS });
    return NextResponse.json({ error: e instanceof Error ? e.name : 'Error' }, { status: 500, headers: HEADERS });
  }
}
