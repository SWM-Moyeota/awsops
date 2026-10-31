// Architecture diagram API: live relationship queries -> VPC model -> computed layout -> standalone SVG.
// 아키텍처 다이어그램 API: 라이브 쿼리 → VPC 모델 → 계산된 배치 → 독립 SVG.
import { NextRequest, NextResponse } from 'next/server';
import { runQuery } from '@/lib/steampipe';
import { getConfig } from '@/lib/app-config';
import { collectRows } from '@/lib/arch-diagram/collect';
import { buildModel } from '@/lib/arch-diagram/model';
import { renderSvg, type Lang } from '@/lib/arch-diagram/svg';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const vpc: unknown = body.vpc;
    if (!vpc || typeof vpc !== 'string') {
      return NextResponse.json({ error: 'vpc required' }, { status: 400 });
    }
    const direction = body.direction === 'LR' ? 'LR' : 'TB';
    const includeEmpty = Boolean(body.includeEmpty);
    const includeServices = body.includeServices !== false;
    const excludeSubnets: string[] = Array.isArray(body.excludeSubnets)
      ? body.excludeSubnets.filter((s: unknown): s is string => typeof s === 'string').slice(0, 50)
      : [];
    const accountId: string | undefined = typeof body.accountId === 'string' ? body.accountId : undefined;
    const lang: Lang = body.lang === 'en' || body.lang === 'zh' ? body.lang : 'ko';

    const bustCache = body.refresh === true;
    const { rows, skipped } = await collectRows(sql => runQuery(sql, { accountId, bustCache }), includeServices);
    const cfg = getConfig();
    const account = cfg.accounts?.find(a => a.accountId === accountId) ?? cfg.accounts?.find(a => a.isHost);
    const model = buildModel(rows, { vpc, includeEmpty, excludeSubnets, includeServices, region: account?.region, skipped });
    const generatedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul', hour12: false }).slice(0, 16);
    const svg = renderSvg(model, { direction, lang, generatedAt });
    return new NextResponse(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    console.error('[Diagram] render failed:', name);
    return NextResponse.json({ error: name }, { status: name === 'VpcNotFound' ? 404 : name === 'VpcAmbiguous' ? 400 : 500 });
  }
}
