import { describe, it, expect } from 'vitest';
import { computeLayout, textWidth, wrapLabel, type Box } from '../layout';
import { buildModel } from '../model';
import type { Rect } from '../route';
import type { Direction } from '../types';
import { bigRows, DEMO_VPC } from './fixtures';

const model = (over = {}) => buildModel(bigRows(), { vpc: DEMO_VPC, region: 'ap-northeast-2', ...over });
const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const hits = (p: { x: number; y: number }, q: { x: number; y: number }, r: Rect) => {
  const x1 = Math.min(p.x, q.x), x2 = Math.max(p.x, q.x), y1 = Math.min(p.y, q.y), y2 = Math.max(p.y, q.y);
  return x1 < r.x + r.w && x2 > r.x && y1 < r.y + r.h && y2 > r.y;
};

describe.each<Direction>(['TB', 'LR'])('computeLayout %s', dir => {
  const L = computeLayout(model(), dir);
  const of = (k: Box['kind']) => L.boxes.filter(b => b.kind === k);

  it('is deterministic', () => {
    expect(computeLayout(model(), dir)).toEqual(L);
  });
  it('nests frames: subnet in AZ in VPC in region in cloud', () => {
    const cloud = of('cloud')[0].rect, region = of('region')[0].rect, vpc = of('vpc')[0].rect;
    expect(inside(region, cloud)).toBe(true);
    expect(inside(vpc, region)).toBe(true);
    for (const az of of('az')) expect(inside(az.rect, vpc)).toBe(true);
    for (const s of [...of('public'), ...of('private')]) expect(of('az').some(az => inside(s.rect, az.rect))).toBe(true);
    for (const r of of('rail')) expect(inside(r.rect, cloud)).toBe(true);
    expect(L.height).toBeGreaterThanOrEqual(cloud.y + cloud.h);
  });
  it('keeps frames of one kind apart', () => {
    for (const k of ['az', 'public', 'private'] as const) {
      const list = of(k);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) expect(overlap(list[i].rect, list[j].rect)).toBe(false);
    }
  });
  it('keeps icons and labels from overlapping, and subnet icons inside their subnet', () => {
    const rects = L.nodes.flatMap(n => [n.icon, n.label]);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBe(false);
    const m = model();
    for (const s of m.azs.flatMap(a => [...a.public, ...a.private])) {
      const b = L.boxes.find(x => x.id === s.id)!;
      for (const r of s.resources) expect(inside(L.nodes.find(n => n.res.id === r.id)!.icon, b.rect)).toBe(true);
    }
  });
  it('routes every edge orthogonally, around icons and titles', () => {
    expect(L.edges.length).toBe(model().edges.length);
    const m = model();
    const ordered = m.edges.slice();
    expect(ordered.length).toBeGreaterThan(0);
    const icons = L.nodes.map(n => n.icon), labels = L.nodes.map(n => n.label);
    for (const e of L.edges) {
      expect(e.points.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i + 1 < e.points.length; i++) {
        const p = e.points[i], q = e.points[i + 1];
        expect(p.x === q.x || p.y === q.y).toBe(true);
        for (const r of labels) expect(hits(p, q, r)).toBe(false);
        for (const b of L.boxes) expect(hits(p, q, b.titleRect)).toBe(false);
        // Only the first and last runs touch their own icons / 첫·끝 구간만 자기 아이콘에 닿음
        for (const r of icons) expect(hits(p, q, r)).toBe(false);
      }
    }
  });
});

describe('computeLayout alignment', () => {
  it('TB: same tier slot sits on one line across AZs, AZs side by side', () => {
    const L = computeLayout(model(), 'TB');
    const y = (name: string) => L.boxes.find(b => b.title.startsWith(name))!.rect.y;
    expect(y('PublicA')).toBe(y('PublicC'));
    expect(y('AppA')).toBe(y('AppC'));
    expect(y('DbA')).toBe(y('DbC'));
    const azs = L.boxes.filter(b => b.kind === 'az');
    expect(azs[0].rect.y).toBe(azs[1].rect.y);
  });
  it('LR: AZs stack, tiers read left to right', () => {
    const L = computeLayout(model(), 'LR');
    const x = (name: string) => L.boxes.find(b => b.title.startsWith(name))!.rect.x;
    expect(x('PublicA')).toBe(x('PublicC'));
    expect(x('PublicA')).toBeLessThan(x('AppA'));
    const azs = L.boxes.filter(b => b.kind === 'az');
    expect(azs[0].rect.x).toBe(azs[1].rect.x);
  });
  it('puts a single load balancer right under the IGW', () => {
    const r = bigRows();
    r.elb = r.elb.filter(e => e.type === 'application');
    const L = computeLayout(buildModel(r, { vpc: DEMO_VPC }), 'TB');
    expect(L.nodes.find(n => n.res.kind === 'alb')!.icon.x).toBe(L.nodes.find(n => n.res.kind === 'igw')!.icon.x);
  });
  it('handles a VPC with nothing in it, and a crowded subnet', () => {
    const empty = bigRows();
    empty.ec2 = []; empty.elb = []; empty.nat = []; empty.rds = []; empty.elasticache = []; empty.lambda = []; empty.endpoints = []; empty.s3 = []; empty.cloudfront = []; empty.route53 = [];
    const m = buildModel(empty, { vpc: DEMO_VPC });
    expect(m.azs).toEqual([]);
    expect(computeLayout(m, 'TB').edges).toEqual([]);
    expect(computeLayout(m, 'LR').width).toBeGreaterThan(0);

    const crowded = bigRows();
    for (let i = 0; i < 30; i++) crowded.ec2.push({ instance_id: `i-c${i}`, name: `node-${i}`, vpc_id: DEMO_VPC, subnet_id: 'subnet-app-a', instance_type: 'm5.large', instance_state: 'running' });
    const t = Date.now();
    const L = computeLayout(buildModel(crowded, { vpc: DEMO_VPC }), 'TB');
    expect(Date.now() - t).toBeLessThan(8000);
    const rects = L.nodes.map(n => n.icon);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBe(false);
  });
});

describe('text helpers', () => {
  it('wraps long names to two lines with an ellipsis', () => {
    const lines = wrapLabel('api-server-with-a-very-long-name-for-wrapping-and-more', 126);
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith('…')).toBe(true);
    for (const l of lines) expect(textWidth(l, 11)).toBeLessThanOrEqual(126 + 6);
    expect(wrapLabel('short', 126)).toEqual(['short']);
    expect(wrapLabel('한글이름이아주아주아주아주아주아주아주아주길어요정말로요', 126).length).toBe(2);
  });
});
