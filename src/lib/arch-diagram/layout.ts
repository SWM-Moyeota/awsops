// Deterministic geometry: AZ tracks line up, tiers line up, then edges are routed / 결정적 배치: AZ와 티어 줄을 맞춘 뒤 선 경로를 찾는다
import { routeAll, type Port, type Pt, type Rect, type RouteRequest } from './route';
import type { DiagramModel, Direction, Res, SubnetModel, Tier } from './types';

export type BoxKind = 'cloud' | 'region' | 'vpc' | 'az' | 'public' | 'private' | 'rail';
export interface Box { kind: BoxKind; rect: Rect; title: string; sub?: string; titleRect: Rect; id?: string; note?: 'also' | 'lb' | 'empty' | 'none'; also?: Res[] }
export interface PlacedNode { res: Res; icon: Rect; label: Rect; lines: string[]; labelSide: 'below' | 'right' }
export interface PlacedEdge { points: Pt[]; dashed: boolean; label?: string }
export interface Layout { width: number; height: number; boxes: Box[]; nodes: PlacedNode[]; edges: PlacedEdge[]; contentBottom: number; droppedEdges: number }

export const ICON = 48;
const CELL_W = 138;
const CELL_H = 102;
const LABEL_W = 126;
const SIDE_LABEL_W = 132;
const LABEL_LINE = 14;
const SUB_PAD = 12;
const SUB_HEAD = 36;
const SUB_EMPTY_H = 34;
const AZ_PAD = 26;
const AZ_HEAD = 34;
const TRACK_GAP = 22;
const AZ_GAP = 30;
const VPC_PAD = 22;
const VPC_HEAD = 46;
const REGION_PAD = 18;
const REGION_HEAD = 40;
const CLOUD_PAD = 20;
const CLOUD_HEAD = 42;
const RAIL_W = 164;
const EDGE_RAIL_W = 204;
const RAIL_GAP = 26;
const BAND_ITEM_W = 208;
const BAND_ITEM_H = 92;
export const MARGIN = 28;
export const HEADER_H = 78;
const MIN_WIDTH = 940;
const MAX_COLS = 4;

// Rough text width: full-width for CJK, else ~0.56em / 대략의 글자 폭: 한중일은 전각, 나머지는 약 0.56em
export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? size : size * 0.56;
  return w;
}

// Wrap at separators into at most two lines, ellipsis past that / 구분자에서 최대 두 줄로 나누고 넘치면 말줄임
export function wrapLabel(text: string, maxW: number, size = 11): string[] {
  const tokens = text.split(/(?<=[-._/ ])/);
  const lines: string[] = [];
  let cur = '';
  const fit = (s: string) => textWidth(s, size) <= maxW;
  for (let t of tokens) {
    if (fit(cur + t)) { cur += t; continue; }
    if (cur) { lines.push(cur); cur = ''; }
    while (!fit(t)) {
      let k = t.length;
      while (k > 1 && !fit(t.slice(0, k))) k--;
      lines.push(t.slice(0, k));
      t = t.slice(k);
    }
    cur = t;
  }
  if (cur) lines.push(cur);
  if (lines.length <= 2) return lines.map(l => l.trim());
  let second = lines[1];
  while (second.length > 1 && !fit(`${second}…`)) second = second.slice(0, -1);
  return [lines[0].trim(), `${second.trimEnd()}…`];
}

// Cut text to a width with an ellipsis / 폭에 맞춰 말줄임
export function clipText(s: string, maxW: number, size: number): string {
  if (textWidth(s, size) <= maxW) return s;
  let t = s;
  while (t.length > 1 && textWidth(`${t}…`, size) > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

const subnetTitle = (s: SubnetModel) => clipText(`${s.name}${s.cidr ? ` (${s.cidr})` : ''}`, 420, 12);
const titleRectAt = (x: number, y: number, title: string, size: number, iconW: number): Rect => ({ x, y, w: iconW + textWidth(title, size) + 6, h: 22 });

export function computeLayout(m: DiagramModel, dir: Direction): Layout {
  const boxes: Box[] = [];
  const nodes: PlacedNode[] = [];
  const vpcTitle = clipText(m.vpc.name, 320, 13);
  const allSubnets = m.azs.flatMap(a => [...a.public, ...a.private]);
  const maxRes = Math.max(1, ...allSubnets.map(s => s.resources.length));
  const cols = Math.min(maxRes, dir === 'LR' || m.azs.length >= 3 ? 3 : MAX_COLS);
  const titleW = Math.max(0, ...allSubnets.map(s => textWidth(subnetTitle(s), 12) + 34));
  const subW = Math.max(cols * CELL_W, titleW, 2 * CELL_W - 40) + 2 * SUB_PAD;
  const subH = (s: SubnetModel) => {
    const rows = Math.ceil(s.resources.length / cols);
    return SUB_HEAD + (rows ? rows * CELL_H : SUB_EMPTY_H) + SUB_PAD - (rows ? 8 : 0);
  };
  const pubSlots = Math.max(0, ...m.azs.map(a => a.public.length));
  const prvSlots = Math.max(0, ...m.azs.map(a => a.private.length));
  const slots = pubSlots + prvSlots;
  const slotOf = (az: DiagramModel['azs'][number], k: number): SubnetModel | undefined => (k < pubSlots ? az.public[k] : az.private[k - pubSlots]);

  // AZ grid at the origin; offset later / AZ 격자를 원점에 놓고 나중에 옮김
  type Placed = { s: SubnetModel; rect: Rect };
  const azRects: Array<{ name: string; rect: Rect }> = [];
  const subRects: Placed[] = [];
  let gridW = 0, gridH = 0;
  if (dir === 'TB') {
    const rowH: number[] = [];
    for (let k = 0; k < slots; k++) rowH[k] = Math.max(0, ...m.azs.map(a => { const s = slotOf(a, k); return s ? subH(s) : 0; }));
    const innerH = rowH.reduce((p, c) => p + c, 0) + Math.max(0, slots - 1) * TRACK_GAP;
    const azH = AZ_HEAD + innerH + AZ_PAD;
    const azW = subW + 2 * AZ_PAD;
    m.azs.forEach((a, i) => {
      const x = i * (azW + AZ_GAP);
      azRects.push({ name: a.name, rect: { x, y: 0, w: azW, h: azH } });
      let y = AZ_HEAD;
      for (let k = 0; k < slots; k++) {
        const s = slotOf(a, k);
        if (s) subRects.push({ s, rect: { x: x + AZ_PAD, y, w: subW, h: rowH[k] } });
        y += rowH[k] + TRACK_GAP;
      }
    });
    gridW = m.azs.length * azW + Math.max(0, m.azs.length - 1) * AZ_GAP;
    gridH = azH;
  } else {
    // Tiers are columns; several subnets of a tier stack inside theirs / 티어가 열이고, 같은 티어의 서브넷은 그 열에 쌓임
    const tierCols = Number(pubSlots > 0) + Number(prvSlots > 0);
    const azW = tierCols * subW + Math.max(0, tierCols - 1) * TRACK_GAP + 2 * AZ_PAD;
    let y = 0;
    m.azs.forEach(a => {
      const stack = (list: SubnetModel[], col: number) => {
        let sy = y + AZ_HEAD;
        for (const s of list) {
          subRects.push({ s, rect: { x: AZ_PAD + col * (subW + TRACK_GAP), y: sy, w: subW, h: subH(s) } });
          sy += subH(s) + TRACK_GAP;
        }
        return sy - TRACK_GAP - (y + AZ_HEAD);
      };
      const h = Math.max(stack(a.public, 0), stack(a.private, pubSlots > 0 ? 1 : 0));
      const azH = AZ_HEAD + h + AZ_PAD;
      azRects.push({ name: a.name, rect: { x: 0, y, w: azW, h: azH } });
      y += azH + AZ_GAP;
    });
    gridW = azW;
    gridH = Math.max(0, y - AZ_GAP);
  }

  // VPC band: load balancers and attachments / VPC 띠: 로드밸런서와 연결
  const band = [...m.lbs, ...m.attachments];
  const hasBand = band.length > 0;
  const bandThick = hasBand ? (dir === 'TB' ? BAND_ITEM_H : BAND_ITEM_W) : (dir === 'LR' && m.igw ? 70 : 0);
  // Load balancers centre on the IGW and attachments sit at the far end, so keep room on both sides / 로드밸런서는 IGW 중심, 연결은 끝에 놓이므로 양쪽 공간 확보
  const lbHalf = dir === 'TB' ? (Math.max(0, m.lbs.length - 1) / 2) * BAND_ITEM_W + ICON / 2 + 9 + SIDE_LABEL_W : (m.lbs.length * BAND_ITEM_H) / 2;
  const attLen = m.attachments.length * (dir === 'TB' ? BAND_ITEM_W : BAND_ITEM_H);
  const bandLen = m.attachments.length ? 2 * (lbHalf + attLen) : m.lbs.length ? 2 * lbHalf : 0;
  // In TB the VPC title must end before the IGW on the border / TB에서는 VPC 제목이 경계의 IGW 앞에서 끝나야 함
  const vpcTitleW = textWidth(`${vpcTitle}  ${m.vpc.cidr}`, 13) + 60;

  // Nested sizes, inside out / 안쪽부터 크기 계산
  const minGridW = Math.max(gridW, dir === 'TB' ? Math.max(bandLen, 2 * vpcTitleW) : vpcTitleW, 300);
  const minGridH = Math.max(gridH, dir === 'LR' ? bandLen : 0, 80);
  const vpcW = (dir === 'TB' ? minGridW : minGridW + bandThick) + 2 * VPC_PAD + (dir === 'LR' ? 24 : 0);
  const vpcH = VPC_HEAD + (dir === 'TB' ? bandThick + minGridH : minGridH) + VPC_PAD;
  const svcRail = m.services.length > 0;
  const edgeRail = m.edgeServices.length > 0;
  const regionW = vpcW + 2 * REGION_PAD + (svcRail ? RAIL_W + RAIL_GAP : 0);
  const regionH = REGION_HEAD + vpcH + REGION_PAD;
  const cloudW = regionW + 2 * CLOUD_PAD + (edgeRail ? EDGE_RAIL_W + RAIL_GAP : 0);
  const cloudH = CLOUD_HEAD + regionH + CLOUD_PAD;
  const internetRoom = m.internet ? (dir === 'TB' ? ICON + 52 : ICON + 74) : 0;

  const totalW = Math.max(MIN_WIDTH, cloudW + 2 * MARGIN + (dir === 'LR' ? internetRoom : 0));
  const cloudX = dir === 'LR' ? Math.round((totalW - cloudW + internetRoom) / 2) : Math.round((totalW - cloudW) / 2);
  const cloudY = HEADER_H + (dir === 'TB' ? internetRoom : 0);
  const regionX = cloudX + CLOUD_PAD + (edgeRail ? EDGE_RAIL_W + RAIL_GAP : 0);
  const regionY = cloudY + CLOUD_HEAD;
  const vpcX = regionX + REGION_PAD;
  const vpcY = regionY + REGION_HEAD;

  const box = (kind: BoxKind, rect: Rect, title: string, opts: Partial<Box> = {}, titleSize = 13, iconW = 28) => {
    const tr = titleRectAt(rect.x + 8, rect.y + 7, opts.sub ? `${title}  ${opts.sub}` : title, titleSize, iconW);
    const b: Box = { kind, rect, title, titleRect: tr, ...opts };
    boxes.push(b);
    return b;
  };
  box('cloud', { x: cloudX, y: cloudY, w: cloudW, h: cloudH }, 'AWS Cloud', {}, 14);
  box('region', { x: regionX, y: regionY, w: regionW, h: regionH }, m.vpc.region ? `Region · ${m.vpc.region}` : 'Region');
  box('vpc', { x: vpcX, y: vpcY, w: vpcW, h: vpcH }, vpcTitle, { sub: m.vpc.cidr, note: m.azs.length ? undefined : 'none' });

  const gridX = vpcX + VPC_PAD + (dir === 'LR' ? bandThick + 24 : 0);
  const gridY = vpcY + VPC_HEAD + (dir === 'TB' ? bandThick : 0);
  const centerShiftX = Math.round((minGridW - gridW) / 2);
  const centerShiftY = Math.round((minGridH - gridH) / 2);
  const ox = gridX + centerShiftX, oy = gridY + centerShiftY;

  for (const a of azRects) box('az', { x: a.rect.x + ox, y: a.rect.y + oy, w: a.rect.w, h: a.rect.h }, `Availability Zone ${a.name}`, {}, 12, 2);

  const place = (res: Res, ix: number, iy: number, side: 'below' | 'right') => {
    const lines = wrapLabel(res.name, side === 'below' ? LABEL_W : SIDE_LABEL_W);
    const h = lines.length * LABEL_LINE + 2;
    const icon = { x: ix, y: iy, w: ICON, h: ICON };
    const label = side === 'below'
      ? { x: ix + ICON / 2 - LABEL_W / 2, y: iy + ICON + 5, w: LABEL_W, h }
      : { x: ix + ICON + 9, y: iy + ICON / 2 - h / 2, w: Math.min(SIDE_LABEL_W, Math.max(...lines.map(l => textWidth(l, 11))) + 4), h };
    nodes.push({ res, icon, label, lines, labelSide: side });
  };

  // Subnets and their icons / 서브넷과 아이콘
  const subBoxOf = new Map<string, Box>();
  for (const { s, rect } of subRects) {
    const r = { x: rect.x + ox, y: rect.y + oy, w: rect.w, h: rect.h };
    const note = s.resources.length ? undefined : s.also.length ? 'also' : s.lbNodes ? 'lb' : 'empty';
    subBoxOf.set(s.id, box(s.tier as Tier, r, subnetTitle(s), { id: s.id, note, also: s.also }, 12));
    const rows = Math.ceil(s.resources.length / cols);
    const contentH = rows * CELL_H - 8;
    const startY = r.y + SUB_HEAD + Math.max(0, Math.round((r.h - SUB_HEAD - SUB_PAD - contentH) / 2));
    s.resources.forEach((res, i) => {
      const row = Math.floor(i / cols), col = i % cols;
      const inRow = row === rows - 1 ? s.resources.length - row * cols : cols;
      const rowW = inRow * CELL_W;
      const cx = r.x + Math.round((r.w - rowW) / 2) + col * CELL_W + CELL_W / 2;
      place(res, cx - ICON / 2, startY + row * CELL_H + 6, 'below');
    });
  }

  // IGW straddles the VPC border, band items sit next to it / IGW는 VPC 경계에 걸치고 띠 항목이 그 옆에
  if (dir === 'TB') {
    const cx = gridX + Math.round(minGridW / 2);
    if (m.igw) place(m.igw, cx - ICON / 2, vpcY - ICON / 2, 'right');
    const y = vpcY + VPC_HEAD + 4;
    // Icon centres straddle the IGW so one load balancer sits right below it / 아이콘 중심을 IGW 기준으로 놓아 하나면 바로 아래에
    m.lbs.forEach((res, i) => place(res, cx + (i - (m.lbs.length - 1) / 2) * BAND_ITEM_W - ICON / 2, y, 'right'));
    m.attachments.forEach((res, i) => place(res, gridX + minGridW - (m.attachments.length - i) * BAND_ITEM_W + (BAND_ITEM_W - ICON - SIDE_LABEL_W) / 2, y, 'right'));
    if (m.internet) place(m.internet, cx - ICON / 2, HEADER_H + 2, 'right');
  } else {
    const cy = vpcY + VPC_HEAD + Math.round(minGridH / 2);
    if (m.igw) place(m.igw, vpcX - ICON / 2, cy - ICON / 2 - 16, 'below');
    const x = vpcX + VPC_PAD + 24 + Math.round((BAND_ITEM_W - CELL_W) / 2) + (CELL_W - ICON) / 2;
    const lbH = m.lbs.length * BAND_ITEM_H;
    m.lbs.forEach((res, i) => place(res, x, cy - lbH / 2 + i * BAND_ITEM_H, 'below'));
    m.attachments.forEach((res, i) => place(res, x, gridY + minGridH - (m.attachments.length - i) * BAND_ITEM_H, 'below'));
    if (m.internet) place(m.internet, cloudX - internetRoom + 4, cy - ICON / 2 - 16, 'below');
  }

  // Side rails / 옆 레일
  const rail = (title: string, x: number, y: number, w: number, top: number, items: Res[]) => {
    box('rail', { x, y, w, h: top + items.length * CELL_H }, title, {}, 12, 2);
    items.forEach((res, i) => place(res, x + w / 2 - ICON / 2, y + top + 6 + i * CELL_H, 'below'));
  };
  if (edgeRail) rail('Global', cloudX + CLOUD_PAD, regionY, EDGE_RAIL_W, 40, m.edgeServices);
  if (svcRail) rail('Account', vpcX + vpcW + RAIL_GAP, vpcY, RAIL_W, 48, m.services);

  // Rails can outgrow their parents; grow the frames to match / 레일이 부모보다 크면 틀을 늘림
  const bottomOf = (kinds: BoxKind[]) => Math.max(...boxes.filter(b => kinds.includes(b.kind)).map(b => b.rect.y + b.rect.h));
  const regionBox = boxes.find(b => b.kind === 'region')!, cloudBox = boxes.find(b => b.kind === 'cloud')!;
  const accountRail = boxes.find(b => b.kind === 'rail' && b.title === 'Account');
  if (accountRail) regionBox.rect.h = Math.max(regionBox.rect.h, accountRail.rect.y + accountRail.rect.h + REGION_PAD - regionBox.rect.y);
  cloudBox.rect.h = Math.max(cloudBox.rect.h, Math.max(regionBox.rect.y + regionBox.rect.h, bottomOf(['rail'])) + CLOUD_PAD - cloudBox.rect.y);

  // Route edges / 선 경로 찾기
  const byId = new Map(nodes.map(n => [n.res.id, n] as const));
  const portsOf = (n: PlacedNode): Port[] => {
    const { x, y, w, h } = n.icon;
    const cx = x + w / 2, cy = y + h / 2;
    // The IGW sits on the VPC border: never leave along it / IGW는 VPC 경계 위라 경계를 따라 나가지 않음
    if (n.res.kind === 'igw') return dir === 'TB' ? [{ x: cx, y, side: 'top' }, { x: cx, y: y + h, side: 'bottom' }] : [{ x, y: cy, side: 'left' }, { x: x + w, y: cy, side: 'right' }];
    const ps: Port[] = [{ x: cx, y, side: 'top' }, { x, y: cy, side: 'left' }];
    if (n.labelSide === 'below') ps.push({ x: x + w, y: cy, side: 'right' });
    else ps.push({ x: cx, y: y + h, side: 'bottom' });
    return ps;
  };
  // Subnets leave through the AZ margin, so outbound lines merge into one bus / 서브넷은 AZ 여백으로 나가 아웃바운드 선이 하나로 합쳐짐
  const subnetPorts = (b: Box): Port[] => [{ x: b.rect.x, y: b.rect.y + Math.round(b.rect.h / 2), side: 'left' }];
  const obstacles: Rect[] = [];
  for (const n of nodes) obstacles.push(n.icon, n.label);
  for (const b of boxes) obstacles.push(b.titleRect);
  const reqs: RouteRequest[] = [];
  const kept: Array<{ dashed: boolean; label?: string }> = [];
  // The front door first, then requests, outbound last / 입구 먼저, 그다음 요청 흐름, 아웃바운드는 마지막
  const rank = (e: { from: string; dashed?: boolean }) => (e.dashed ? 3 : e.from === 'internet' ? 0 : e.from === m.igw?.id ? 1 : 2);
  const order = m.edges.slice().sort((a, b) => rank(a) - rank(b));
  for (const e of order) {
    const fromSub = e.from.startsWith('subnet:') ? subBoxOf.get(e.from.slice(7)) : undefined;
    const fromNode = byId.get(e.from);
    const toNode = byId.get(e.to);
    if (!toNode || (!fromNode && !fromSub)) continue;
    reqs.push({ from: fromSub ? subnetPorts(fromSub) : portsOf(fromNode!), to: portsOf(toNode), group: `f:${e.from}`, group2: `t:${e.to}` });
    kept.push({ dashed: !!e.dashed, label: e.label });
  }
  const contentBottom = Math.max(cloudBox.rect.y + cloudBox.rect.h, ...nodes.map(n => n.label.y + n.label.h));
  const gutters = boxes.map(b => b.rect);
  const paths = routeAll(reqs, obstacles, gutters, { x: 6, y: HEADER_H - 12, w: totalW - 12, h: contentBottom - HEADER_H + 30 });
  const edges: PlacedEdge[] = [];
  paths.forEach((points, i) => { if (points) edges.push({ points, dashed: kept[i].dashed, label: kept[i].label }); });

  return { width: totalW, height: contentBottom, boxes, nodes, edges, contentBottom, droppedEdges: reqs.length - edges.length };
}
