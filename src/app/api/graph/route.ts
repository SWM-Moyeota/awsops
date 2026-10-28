// GET /api/graph — read-only dependency graph queries (see src/lib/dep-graph/api.ts).
// 의존성 그래프 조회 — 읽기 전용.
import { NextRequest, NextResponse } from 'next/server';
import { ensureGraph } from '@/lib/dep-graph/build';
import { handleGraphRequest, parseGraphRequest } from '@/lib/dep-graph/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const HEADERS = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const req = parseGraphRequest(request.nextUrl.searchParams);
  if ('error' in req) return NextResponse.json({ error: req.error }, { status: 400, headers: HEADERS });
  try {
    const store = await ensureGraph();
    const { status, body } = await handleGraphRequest(req, store);
    return NextResponse.json(body, { status, headers: HEADERS });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.name : 'Error' }, { status: 500, headers: HEADERS });
  }
}
