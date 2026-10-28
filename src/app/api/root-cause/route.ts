// /api/root-cause — incident list, detail and manual analysis (see src/lib/root-cause/api.ts).
// 장애 원인 분석 API — 목록·상세·수동 분석.
import { NextRequest, NextResponse } from 'next/server';
import { ensureRootCauseStarted } from '@/lib/root-cause/loop';
import { handleRootCauseGet, handleRootCausePost } from '@/lib/root-cause/api';
import { getUserFromRequest } from '@/lib/auth-utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const HEADERS = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  ensureRootCauseStarted();
  const { status, body } = await handleRootCauseGet(request.nextUrl.searchParams);
  return NextResponse.json(body, { status, headers: HEADERS });
}

export async function POST(request: NextRequest) {
  ensureRootCauseStarted();
  let json: unknown = null;
  try { json = await request.json(); } catch { /* handler answers 400 / 처리기가 400 응답 */ }
  const user = getUserFromRequest(request);
  const userId = user.email && user.email !== 'unknown' ? user.email : null;
  const { status, body } = await handleRootCausePost(json, userId);
  return NextResponse.json(body, { status, headers: HEADERS });
}
