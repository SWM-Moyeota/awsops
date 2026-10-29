// /api/terraform-export — Terraform code export jobs (see src/lib/tf-export/api.ts).
// Terraform 코드 내보내기 API — 작업 시작·상태·파일·내려받기.
import { NextRequest, NextResponse } from 'next/server';
import { handleTerraformGet, handleTerraformPost, type ApiResult } from '@/lib/tf-export/api';
import { getUserFromRequest } from '@/lib/auth-utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const HEADERS = { 'Cache-Control': 'no-store' };

// Map a handler result to a response / 처리기 결과를 응답으로 변환
function respond(r: ApiResult): NextResponse {
  if (r.zip) {
    return new NextResponse(new Uint8Array(r.zip), { status: r.status, headers: { ...HEADERS, 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${r.filename}"` } });
  }
  if (r.text !== undefined) return new NextResponse(r.text, { status: r.status, headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
  return NextResponse.json(r.body, { status: r.status, headers: HEADERS });
}

export async function GET(request: NextRequest) {
  return respond(await handleTerraformGet(request.nextUrl.searchParams));
}

export async function POST(request: NextRequest) {
  let json: unknown = null;
  try { json = await request.json(); } catch { /* handler answers 400 / 처리기가 400 응답 */ }
  const user = getUserFromRequest(request);
  const userId = user.email && user.email !== 'unknown' ? user.email : null;
  return respond(await handleTerraformPost(json, userId));
}
