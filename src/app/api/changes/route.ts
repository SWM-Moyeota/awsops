// GET /api/changes — change timeline (who created / deleted which resource), read from the local JSON store.
// 변경 기록 조회 — 누가 어떤 리소스를 만들고 지웠는지 (로컬 JSON 저장소에서 읽는다).
import { NextRequest, NextResponse } from 'next/server';
import { queryChanges } from '@/lib/change-timeline/query';
import { TRACKED, eventNamesFor } from '@/lib/change-timeline/catalog';
import type { ChangeKind, ChangesQuery, RangeId, ResourceType, TrackedRegion } from '@/lib/change-timeline/types';

export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'no-store' };

const RANGES = new Set<RangeId>(['24h', '7d', '30d', '90d', 'all']);
const KINDS = new Set<ChangeKind>(['create', 'delete']);
const TYPES = new Set<ResourceType>(TRACKED.map((t) => t.resourceType));
const REGIONS = new Set<string>(TRACKED.map((t) => t.region));
const MAX_TEXT = 200;

const bad = (error: string) => NextResponse.json({ error }, { status: 400, headers: HEADERS });

export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const accountId = p.get('accountId') || '__all__';
  const range = (p.get('range') || '7d') as RangeId;
  const kind = p.get('kind') || undefined;
  const type = p.get('type') || undefined;
  const actor = p.get('actor') || undefined;
  const q = p.get('q')?.trim() || undefined;

  if (accountId !== '__all__' && !/^\d{12}$/.test(accountId)) return bad('invalid accountId');
  if (!RANGES.has(range)) return bad('invalid range');
  if (kind && !KINDS.has(kind as ChangeKind)) return bad('invalid kind');
  if (type && !TYPES.has(type as ResourceType)) return bad('invalid type');
  if ((actor && actor.length > MAX_TEXT) || (q && q.length > MAX_TEXT)) return bad('text too long');

  const query: ChangesQuery = {
    accountId, range,
    ...(kind ? { kind: kind as ChangeKind } : {}),
    ...(type ? { resourceType: type as ResourceType } : {}),
    ...(actor ? { actor } : {}),
    ...(q ? { q } : {}),
  };
  try {
    const data = await queryChanges(query, {
      namesFor: (region) => (REGIONS.has(region) ? eventNamesFor(region as TrackedRegion) : []),
    });
    return NextResponse.json(data, { headers: HEADERS });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.name : 'Error' }, { status: 500, headers: HEADERS });
  }
}
