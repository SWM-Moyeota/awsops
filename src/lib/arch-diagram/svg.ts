// Render the layout to a standalone SVG string; every data value goes through esc() / 배치를 독립 SVG 문자열로 그린다. 모든 데이터 값은 esc()를 거친다
import { ICONS, type IconKey } from './icons';
import { clipText, computeLayout, ICON, MARGIN, textWidth, type Box, type PlacedEdge, type PlacedNode } from './layout';
import { allResources } from './model';
import type { DiagramModel, Direction, Res } from './types';

export type Lang = 'ko' | 'en' | 'zh';

const TEXT = {
  ko: { title: '아키텍처', azs: 'AZ', subnets: '서브넷', res: '리소스', legend: '범례', traffic: '요청 흐름', outbound: '아웃바운드·복제', hidden: (n: number) => `빈 서브넷 ${n}개 숨김`, skipped: (s: string) => `조회 못 한 항목: ${s}`, noRel: 'EC2와 RDS·캐시 사이의 연결은 데이터로 확인할 수 없어 그리지 않았어요', lbScope: '로드밸런서는 ALB·NLB만 표시해요 (Gateway LB·Classic LB 제외)', dropped: (n: number) => `연결선이 너무 많아 ${n}개는 생략했어요`, also: (n: string) => `${n}번도 이 서브넷을 함께 사용`, lb: '로드밸런서 노드', empty: '리소스 없음', account: '계정 공통 (이 VPC 전용 아님)', group: 'Auto Scaling 그룹', stopped: '흐리게 = 정지됨', generated: '생성' },
  en: { title: 'Architecture', azs: 'AZs', subnets: 'subnets', res: 'resources', legend: 'Legend', traffic: 'Request flow', outbound: 'Outbound / replication', hidden: (n: number) => `${n} empty subnets hidden`, skipped: (s: string) => `Could not read: ${s}`, noRel: 'Links between EC2 and RDS/cache cannot be proven from this data, so they are not drawn', lbScope: 'Only ALB and NLB are shown (not Gateway or Classic load balancers)', dropped: (n: number) => `${n} connections left out, too many to draw`, also: (n: string) => `#${n} also use this subnet`, lb: 'Load balancer nodes', empty: 'No resources', account: 'Account-wide, not only this VPC', group: 'Auto Scaling group', stopped: 'Faded = stopped', generated: 'Generated' },
  zh: { title: '架构', azs: '可用区', subnets: '子网', res: '资源', legend: '图例', traffic: '请求流', outbound: '出站 / 复制', hidden: (n: number) => `已隐藏 ${n} 个空子网`, skipped: (s: string) => `无法读取：${s}`, noRel: 'EC2 与 RDS/缓存之间的连接无法从数据确认，因此未绘制', lbScope: '仅显示 ALB 和 NLB（不含 Gateway LB、Classic LB）', dropped: (n: number) => `连接过多，已省略 ${n} 条`, also: (n: string) => `${n} 号也使用此子网`, lb: '负载均衡器节点', empty: '无资源', account: '账户通用（不仅限此 VPC）', group: 'Auto Scaling 组', stopped: '淡色 = 已停止', generated: '生成于' },
} as const;

const FONT = "'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic','Segoe UI',Helvetica,Arial,sans-serif";
const INK = '#232F3E', MUTED = '#5F6B7A', LINE = '#414D5C', LINE_SOFT = '#8D99A8';

// Escape text and drop control characters XML cannot hold / 글자 이스케이프, XML에 못 넣는 제어 문자 제거
export function esc(v: unknown): string {
  return String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const LOCK = (open: boolean) => `<rect x="6.5" y="10.5" width="9" height="7" rx="1" fill="none" stroke="#fff" stroke-width="1.4"/><path d="${open ? 'M8.5 10.5V8a2.5 2.5 0 0 1 5-.6' : 'M8.5 10.5V8a2.5 2.5 0 0 1 5 0v2.5'}" fill="none" stroke="#fff" stroke-width="1.4"/>`;
const CLOUD = '<path d="M7 15.5h8.2a2.9 2.9 0 0 0 .4-5.8 4.2 4.2 0 0 0-8-1A3.5 3.5 0 0 0 7 15.5z" fill="none" stroke="#fff" stroke-width="1.4"/>';
const FLAG = '<path d="M7 17V5.5m0 .5h8.5l-2 2.75 2 2.75H7" fill="none" stroke="#fff" stroke-width="1.4"/>';

const BOX_STYLE: Record<Box['kind'], { fill: string; stroke: string; dash?: string; width: number; title: string; badge?: string; glyph?: string; size: number; weight: number }> = {
  cloud: { fill: '#FFFFFF', stroke: INK, width: 1.4, title: INK, badge: INK, glyph: CLOUD, size: 14, weight: 700 },
  region: { fill: '#FFFFFF', stroke: '#00A4A6', dash: '2 3', width: 1.4, title: '#00797B', badge: '#00A4A6', glyph: FLAG, size: 13, weight: 600 },
  vpc: { fill: '#FCFEF9', stroke: '#3F8624', width: 1.8, title: '#2E6B18', badge: '#3F8624', glyph: CLOUD, size: 13, weight: 700 },
  az: { fill: 'none', stroke: '#147EBA', dash: '7 5', width: 1.3, title: '#116A9E', size: 12, weight: 600 },
  public: { fill: '#F0F6E6', stroke: '#B6D08E', width: 1, title: '#3F6212', badge: '#5F9213', glyph: LOCK(true), size: 12, weight: 600 },
  private: { fill: '#E7F2F9', stroke: '#A9CFE6', width: 1, title: '#0F5C87', badge: '#147EBA', glyph: LOCK(false), size: 12, weight: 600 },
  rail: { fill: '#F8F9FB', stroke: '#AAB4C0', dash: '4 4', width: 1, title: MUTED, size: 12, weight: 600 },
};

function drawBox(b: Box, lang: Lang): string {
  const st = BOX_STYLE[b.kind];
  const { x, y, w, h } = b.rect;
  const rx = b.kind === 'public' || b.kind === 'private' ? 6 : 8;
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.width}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`;
  let tx = x + 12;
  if (st.badge) {
    out += `<svg x="${x + 8}" y="${y + 7}" width="22" height="22" viewBox="0 0 22 22"><rect width="22" height="22" rx="4" fill="${st.badge}"/>${st.glyph}</svg>`;
    tx = x + 36;
  }
  out += `<text x="${tx}" y="${y + 23}" font-size="${st.size}" font-weight="${st.weight}" fill="${st.title}">${esc(b.title)}${b.sub ? `<tspan font-weight="400" fill="${MUTED}" dx="8">${esc(b.sub)}</tspan>` : ''}</text>`;
  if (b.kind === 'rail' && b.title === 'Account') out = out.replace('</text>', `</text><text x="${x + 12}" y="${y + 37}" font-size="9.5" fill="${MUTED}">${esc(TEXT[lang].account.split(' (')[0].split(',')[0].split('（')[0])}</text>`);
  if (b.note) {
    const note = b.note === 'also' ? TEXT[lang].also((b.also ?? []).map(r => r.n ?? '').join(', ')) : b.note === 'lb' ? TEXT[lang].lb : TEXT[lang].empty;
    out += `<text x="${x + w / 2}" y="${y + Math.round((h + 36) / 2) + 4}" text-anchor="middle" font-size="11" font-style="italic" fill="${MUTED}">${esc(note)}</text>`;
  }
  return out;
}

// Rounded polyline / 모서리를 둥글린 선
function pathOf(pts: PlacedEdge['points'], r = 7): string {
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], a = pts[i - 1], n = pts[i + 1];
    if (!n) { d += `L${p.x} ${p.y}`; break; }
    const inLen = Math.abs(p.x - a.x) + Math.abs(p.y - a.y), outLen = Math.abs(n.x - p.x) + Math.abs(n.y - p.y);
    const q = Math.min(r, inLen / 2, outLen / 2);
    const ax = p.x - Math.sign(p.x - a.x) * q, ay = p.y - Math.sign(p.y - a.y) * q;
    const bx = p.x + Math.sign(n.x - p.x) * q, by = p.y + Math.sign(n.y - p.y) * q;
    d += `L${ax} ${ay}Q${p.x} ${p.y} ${bx} ${by}`;
  }
  return d;
}

function drawEdge(e: PlacedEdge): string {
  const stroke = e.dashed ? LINE_SOFT : LINE;
  let out = `<path d="${pathOf(e.points)}" fill="none" stroke="${stroke}" stroke-width="${e.dashed ? 1.2 : 1.5}"${e.dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#${e.dashed ? 'arrow-soft' : 'arrow'})"/>`;
  if (e.label) {
    let best = 0, bestLen = -1;
    for (let i = 0; i + 1 < e.points.length; i++) {
      const len = Math.abs(e.points[i + 1].x - e.points[i].x) + Math.abs(e.points[i + 1].y - e.points[i].y);
      if (len > bestLen) { bestLen = len; best = i; }
    }
    const a = e.points[best], b = e.points[best + 1];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, w = textWidth(e.label, 10) + 10;
    out += `<rect x="${mx - w / 2}" y="${my - 8}" width="${w}" height="16" rx="3" fill="#fff" stroke="#D5DBE1"/><text x="${mx}" y="${my + 3.5}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(e.label)}</text>`;
  }
  return out;
}

const INTERNET = `<svg viewBox="2 8 44 30" preserveAspectRatio="xMidYMax meet"><path d="M13 37h23a9 9 0 0 0 1.2-17.9A13 13 0 0 0 12.6 16 10.6 10.6 0 0 0 13 37z" fill="#F4F6F8" stroke="${LINE}" stroke-width="1.8"/></svg>`;

function drawIcon(res: Res, x: number, y: number, size: number): string {
  if (res.kind === 'internet') return INTERNET.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);
  return `<use href="#i-${res.kind}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;
}

function drawNode(n: PlacedNode): string {
  const { res, icon, label } = n;
  let out = res.faded ? '<g opacity="0.45">' : '<g>';
  // Halo so border-straddling icons stay readable / 경계에 걸친 아이콘이 잘 보이도록 흰 바탕
  if (res.kind === 'igw' || res.kind === 'internet') out += `<rect x="${icon.x - 3}" y="${icon.y - 3}" width="${icon.w + 6}" height="${icon.h + 6}" rx="8" fill="#fff"/>`;
  if (res.group) out += `<rect x="${label.x + 4}" y="${icon.y - 9}" width="${label.w - 8}" height="${label.y + label.h + 5 - (icon.y - 9)}" rx="6" fill="none" stroke="#ED7100" stroke-width="1.3" stroke-dasharray="5 3"/>`;
  out += drawIcon(res, icon.x, icon.y, ICON);
  const anchor = n.labelSide === 'below' ? 'middle' : 'start';
  const tx = n.labelSide === 'below' ? icon.x + ICON / 2 : label.x + 2;
  if (n.labelSide === 'right' || res.kind === 'igw') {
    out += `<rect x="${label.x - 2}" y="${label.y - 1}" width="${label.w + 4}" height="${label.h + 2}" rx="3" fill="#fff" fill-opacity="0.85"/>`;
  }
  n.lines.forEach((l, i) => {
    out += `<text x="${tx}" y="${label.y + 11 + i * 14}" text-anchor="${anchor}" font-size="11" fill="${INK}">${esc(l)}</text>`;
  });
  out += '</g>';
  if (res.count && res.count > 1) {
    const t = `×${res.count}`, w = textWidth(t, 10) + 8;
    out += `<rect x="${icon.x + ICON - w + 6}" y="${icon.y + ICON - 10}" width="${w}" height="15" rx="7.5" fill="${INK}"/><text x="${icon.x + ICON - w / 2 + 6}" y="${icon.y + ICON + 1}" text-anchor="middle" font-size="10" font-weight="600" fill="#fff">${esc(t)}</text>`;
  }
  if (res.n) out += badge(res.n, icon.x + ICON - 5, icon.y - 7);
  return out;
}

function badge(n: number, x: number, y: number): string {
  const w = n >= 100 ? 24 : n >= 10 ? 19 : 15;
  return `<rect x="${x}" y="${y}" width="${w}" height="15" rx="3.5" fill="#4F46E5"/><text x="${x + w / 2}" y="${y + 11}" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">${n}</text>`;
}

// Legend: numbers to full names, then line meanings and notes / 범례: 번호와 전체 이름, 선의 뜻, 참고
function drawLegend(m: DiagramModel, y0: number, width: number, lang: Lang, droppedEdges: number): { svg: string; height: number } {
  const T = TEXT[lang];
  const items = allResources(m);
  const colW = 292;
  const cols = Math.max(2, Math.floor((width - 2 * MARGIN) / colW));
  const rowH = 34;
  const rows = Math.ceil(items.length / cols);
  let out = `<text x="${MARGIN}" y="${y0 + 16}" font-size="13" font-weight="700" fill="${INK}">${esc(T.legend)}</text>`;
  out += `<line x1="${MARGIN}" y1="${y0 + 25}" x2="${width - MARGIN}" y2="${y0 + 25}" stroke="#E3E7EC"/>`;
  const top = y0 + 36;
  items.forEach((r, i) => {
    const col = Math.floor(i / rows), row = i % rows;
    const x = MARGIN + col * colW, y = top + row * rowH;
    out += badge(r.n ?? i + 1, x, y + 8);
    out += drawIcon(r, x + 26, y + 3, 24);
    const maxW = colW - 66;
    const clip = (s: string) => { let t = s; while (t.length > 1 && textWidth(t, 11) > maxW) t = t.slice(0, -1); return t === s ? s : `${t}…`; };
    out += `<text x="${x + 56}" y="${y + 13}" font-size="11" font-weight="600" fill="${INK}">${esc(clip(r.name))}</text>`;
    if (r.detail) out += `<text x="${x + 56}" y="${y + 26}" font-size="10" fill="${MUTED}">${esc(clip(r.detail))}</text>`;
  });
  let y = top + rows * rowH + 12;
  // Line and frame key / 선과 테두리 뜻
  let x = MARGIN;
  const key = (svg: string, text: string, w: number) => {
    out += svg.replace(/@X/g, String(x)).replace(/@Y/g, String(y)).replace(/@E/g, String(x + 30)).replace(/@G/g, String(x + 3));
    out += `<text x="${x + 37}" y="${y + 4}" font-size="10.5" fill="${MUTED}">${esc(text)}</text>`;
    x += 37 + textWidth(text, 10.5) + w;
  };
  key(`<line x1="@X" y1="@Y" x2="@E" y2="@Y" stroke="${LINE}" stroke-width="1.5" marker-end="url(#arrow)"/>`, T.traffic, 22);
  key(`<line x1="@X" y1="@Y" x2="@E" y2="@Y" stroke="${LINE_SOFT}" stroke-width="1.2" stroke-dasharray="5 4" marker-end="url(#arrow-soft)"/>`, T.outbound, 22);
  key(`<rect x="@G" y="${y - 7}" width="24" height="14" rx="3" fill="none" stroke="#ED7100" stroke-width="1.3" stroke-dasharray="4 2"/>`, T.group, 22);
  out += `<text x="${x}" y="${y + 4}" font-size="10.5" fill="${MUTED}">${esc(T.stopped)}</text>`;
  y += 20;
  const notes: string[] = [T.noRel, T.lbScope];
  if (droppedEdges) notes.unshift(T.dropped(droppedEdges));
  if (m.hiddenEmpty) notes.unshift(T.hidden(m.hiddenEmpty));
  if (m.skipped.length) notes.push(T.skipped(m.skipped.join(', ')));
  for (const note of notes) {
    out += `<text x="${MARGIN}" y="${y + 4}" font-size="10.5" fill="${MUTED}">· ${esc(note)}</text>`;
    y += 16;
  }
  return { svg: out, height: y - y0 + 10 };
}

export interface RenderOptions { direction: Direction; lang: Lang; generatedAt?: string }

export function renderSvg(m: DiagramModel, opt: RenderOptions): string {
  const L = computeLayout(m, opt.direction);
  const T = TEXT[opt.lang];
  const legend = drawLegend(m, L.contentBottom + 22, L.width, opt.lang, L.droppedEdges);
  const height = L.contentBottom + 22 + legend.height + 8;
  const subnetCount = m.azs.reduce((p, a) => p + a.public.length + a.private.length, 0);
  const used = Array.from(new Set(L.nodes.map(n => n.res.kind).filter((k): k is IconKey => k !== 'internet')));
  const symbols = used.map(k => `<symbol id="i-${k}" viewBox="${ICONS[k].viewBox}">${ICONS[k].body}</symbol>`).join('');
  const meta = [m.vpc.id, m.vpc.cidr, m.vpc.region, m.vpc.accountId].filter(Boolean).join('  ·  ');
  const stats = `${T.azs} ${m.azs.length}  ·  ${T.subnets} ${subnetCount}  ·  ${T.res} ${allResources(m).length}`;
  // Boxes outer to inner by draw order, rails with them; edges above boxes, icons on top / 틀은 바깥부터, 그 위에 선, 맨 위에 아이콘
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${L.width} ${height}" width="${L.width}" height="${height}" font-family="${esc(FONT)}">`,
    `<defs>${symbols}`,
    `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10z" fill="${LINE}"/></marker>`,
    `<marker id="arrow-soft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0 0L10 5L0 10z" fill="${LINE_SOFT}"/></marker>`,
    '</defs>',
    `<rect width="${L.width}" height="${height}" fill="#fff"/>`,
    `<text x="${MARGIN}" y="38" font-size="22" font-weight="700" fill="${INK}">${esc(clipText(m.vpc.name, L.width - 2 * MARGIN - 420, 22))} ${esc(T.title)}</text>`,
    `<text x="${MARGIN}" y="60" font-size="12" fill="${MUTED}">${esc(meta)}</text>`,
    `<text x="${L.width - MARGIN}" y="38" text-anchor="end" font-size="12" font-weight="600" fill="${INK}">${esc(stats)}</text>`,
    opt.generatedAt ? `<text x="${L.width - MARGIN}" y="60" text-anchor="end" font-size="11" fill="${MUTED}">${esc(T.generated)} ${esc(opt.generatedAt)}</text>` : '',
    ...L.boxes.map(b => drawBox(b, opt.lang)),
    ...L.edges.map(drawEdge),
    ...L.nodes.map(drawNode),
    legend.svg,
    '</svg>',
  ].join('');
}

