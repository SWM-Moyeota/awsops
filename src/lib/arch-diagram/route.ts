// Orthogonal edge router: A* over a sparse grid, around icons and titles / 직각 선 경로 탐색: 듬성한 격자 위 A*, 아이콘과 제목을 피함
export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }
export type Side = 'top' | 'bottom' | 'left' | 'right';
export interface Port extends Pt { side: Side }
export interface RouteRequest { from: Port[]; to: Port[]; group: string; group2?: string }

const STUB = 12; // straight run out of a port / 포트에서 곧게 나오는 길이
const CLEAR = 9; // distance kept from obstacles / 장애물과 띄우는 거리
const BEND = 46;
const CROSS = 28; // crossing another group's line / 다른 묶음의 선과 교차
const OVERLAP = 3; // per px along another group's line / 다른 묶음의 선과 겹칠 때 px당
const REUSE = 0.25; // per px along this group's own line, so edges merge into a tree / 같은 묶음의 선을 따라갈 때 px당 (나무 모양으로 합쳐짐)
const PORT_SHARED = 160; // a port another line already uses / 다른 선이 이미 쓰는 포트
const BUDGET_MS = 3000;

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const outward = (s: Side): Pt => (s === 'top' ? { x: 0, y: -1 } : s === 'bottom' ? { x: 0, y: 1 } : s === 'left' ? { x: -1, y: 0 } : { x: 1, y: 0 });
export const stubOf = (p: Port): Pt => { const o = outward(p.side); return { x: p.x + o.x * STUB, y: p.y + o.y * STUB }; };

// Remove repeats and collinear middles / 중복과 일직선 중간점 제거
export function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const a = out[out.length - 1], b = out[out.length - 2];
    if (a && a.x === p.x && a.y === p.y) continue;
    if (a && b && ((a.x === b.x && a.x === p.x) || (a.y === b.y && a.y === p.y))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const { k, v } = this; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const { k, v } = this; const top = v[0]; const key = k.pop()!, val = v.pop()!; const n = k.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= key) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = key; v[i] = val;
    }
    return top;
  }
}

const near = (rects: Rect[], at: number, axis: 'x' | 'y'): number[] => rects.flatMap(r => (axis === 'x' ? [r.x - CLEAR, r.x + r.w + CLEAR] : [r.y - CLEAR, r.y + r.h + CLEAR])).concat(at);
const sortedUnique = (a: number[]) => Array.from(new Set(a.map(Math.round))).sort((x, y) => x - y);

// Route every request in order; null when there is no route or the time budget ran out (never a line through icons) / 차례로 경로를 찾음. 경로가 없거나 시간을 넘기면 null (아이콘을 뚫는 선은 만들지 않음)
export function routeAll(reqs: RouteRequest[], obstacles: Rect[], gutters: Rect[], bounds: Rect): Array<Pt[] | null> {
  const ports = reqs.flatMap(r => [...r.from, ...r.to]);
  const stubs = ports.map(stubOf);
  const xs = sortedUnique([...near(obstacles, bounds.x, 'x'), ...near(gutters, bounds.x + bounds.w, 'x'), ...stubs.map(p => p.x)]).filter(x => x >= bounds.x && x <= bounds.x + bounds.w);
  const ys = sortedUnique([...near(obstacles, bounds.y, 'y'), ...near(gutters, bounds.y + bounds.h, 'y'), ...stubs.map(p => p.y)]).filter(y => y >= bounds.y && y <= bounds.y + bounds.h);
  const nx = xs.length, ny = ys.length;
  const idx = (i: number, j: number) => j * nx + i;
  const lowerX = new Map(xs.map((x, i) => [x, i] as const));
  const lowerY = new Map(ys.map((y, j) => [y, j] as const));

  // Per grid step: who already runs along it / 격자 칸마다 이미 지나는 묶음
  const usedH = new Map<number, Set<string>>();
  const usedV = new Map<number, Set<string>>();
  const portUsers = new Map<string, Set<string>>();
  const portKey = (p: Port) => `${p.x},${p.y},${p.side}`;
  const startedAt = Date.now();

  const blockInto = (hBlocked: Uint8Array, vBlocked: Uint8Array, r: Rect) => {
    for (let j = 0; j < ny; j++) {
      const y = ys[j];
      if (y <= r.y || y >= r.y + r.h) continue;
      for (let i = 0; i < nx - 1; i++) if (xs[i + 1] > r.x && xs[i] < r.x + r.w) hBlocked[idx(i, j)] = 1;
    }
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      if (x <= r.x || x >= r.x + r.w) continue;
      for (let j = 0; j < ny - 1; j++) if (ys[j + 1] > r.y && ys[j] < r.y + r.h) vBlocked[idx(i, j)] = 1;
    }
  };

  const hBlocked = new Uint8Array(nx * ny);
  const vBlocked = new Uint8Array(nx * ny);
  for (const o of obstacles) blockInto(hBlocked, vBlocked, o);
  const size = nx * ny * 4;
  const dist = new Float64Array(size);
  const prev = new Int32Array(size);

  const paths: Array<Pt[] | null> = [];
  for (const req of reqs) {
    if (Date.now() - startedAt > BUDGET_MS) { paths.push(null); continue; }
    const portCost = (p: Port) => (other(portUsers.get(portKey(p))) ? PORT_SHARED : 0);
    const mine = (s: Set<string> | undefined) => !!s && (s.has(req.group) || (!!req.group2 && s.has(req.group2)));
    const other = (s: Set<string> | undefined) => !!s && !mine(s);
    const targets = new Map<number, Port>();
    for (const p of req.to) { const st = stubOf(p); const i = lowerX.get(Math.round(st.x)), j = lowerY.get(Math.round(st.y)); if (i !== undefined && j !== undefined) targets.set(idx(i, j), p); }
    const tx = req.to.map(p => stubOf(p));
    const h = (i: number, j: number) => Math.min(...tx.map(t => Math.abs(xs[i] - t.x) + Math.abs(ys[j] - t.y))) * REUSE;

    dist.fill(Infinity);
    prev.fill(-1);
    const heap = new Heap();
    const starts = new Map<number, Port>();
    req.from.forEach(p => {
      const st = stubOf(p); const i = lowerX.get(Math.round(st.x)), j = lowerY.get(Math.round(st.y));
      if (i === undefined || j === undefined) return;
      const o = outward(p.side);
      const d = DIRS.findIndex(v => v[0] === o.x && v[1] === o.y);
      const s = idx(i, j) * 4 + d;
      const start = portCost(p);
      dist[s] = start; starts.set(s, p);
      heap.push(start + h(i, j), s);
    });

    let end = -1;
    let endCost = Infinity;
    while (heap.size) {
      if (Date.now() - startedAt > BUDGET_MS) break;
      const s = heap.pop();
      const cell = s >> 2, dir = s & 3;
      const i = cell % nx, j = (cell - i) / nx;
      const g = dist[s];
      if (g >= endCost) break;
      const tp = targets.get(cell);
      if (tp) {
        const inward = outward(tp.side);
        const straight = DIRS[dir][0] === -inward.x && DIRS[dir][1] === -inward.y;
        const c = g + (straight ? 0 : BEND) + portCost(tp);
        if (c < endCost) { endCost = c; end = s; }
      }
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIRS[d];
        if (dx === -DIRS[dir][0] && dy === -DIRS[dir][1]) continue;
        const ni = i + dx, nj = j + dy;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const horizontal = dy === 0;
        const key = horizontal ? idx(Math.min(i, ni), j) : idx(i, Math.min(j, nj));
        if ((horizontal ? hBlocked : vBlocked)[key]) continue;
        const len = horizontal ? Math.abs(xs[ni] - xs[i]) : Math.abs(ys[nj] - ys[j]);
        const seg = (horizontal ? usedH : usedV).get(key);
        const cross = (horizontal ? usedV : usedH).get(horizontal ? idx(i, Math.min(j, Math.max(0, j - 1))) : idx(Math.min(i, Math.max(0, i - 1)), j));
        let c = mine(seg) ? len * REUSE : len;
        if (other(seg)) c += len * OVERLAP;
        if (other(cross)) c += CROSS;
        if (d !== dir) c += BEND;
        const ns = idx(ni, nj) * 4 + d;
        if (g + c < dist[ns]) {
          dist[ns] = g + c; prev[ns] = s;
          heap.push(g + c + h(ni, nj), ns);
        }
      }
    }

    if (end < 0) { paths.push(null); continue; }
    const cells: Pt[] = [];
    let cur = end;
    let first = end;
    while (cur >= 0) {
      const cell = cur >> 2; const i = cell % nx, j = (cell - i) / nx;
      cells.push({ x: xs[i], y: ys[j] });
      first = cur;
      cur = prev[cur];
    }
    cells.reverse();
    // Remember the used steps for later edges / 다음 선을 위해 지난 칸 기록
    for (let k = 0; k + 1 < cells.length; k++) {
      const a = cells[k], b = cells[k + 1];
      const horizontal = a.y === b.y;
      const i = lowerX.get(Math.min(a.x, b.x))!, j = lowerY.get(Math.min(a.y, b.y))!;
      const map = horizontal ? usedH : usedV;
      const key = idx(i, j);
      const set = map.get(key) ?? new Set<string>();
      set.add(req.group);
      if (req.group2) set.add(req.group2);
      map.set(key, set);
    }
    const a0 = starts.get(first)!, b0 = targets.get(end >> 2)!;
    for (const p of [a0, b0]) {
      const set = portUsers.get(portKey(p)) ?? new Set<string>();
      set.add(req.group);
      if (req.group2) set.add(req.group2);
      portUsers.set(portKey(p), set);
    }
    paths.push(simplify([a0, ...cells, b0]));
  }
  return paths;
}
