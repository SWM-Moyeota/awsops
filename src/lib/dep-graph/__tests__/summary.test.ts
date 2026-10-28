import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGraphStore, type GraphStore } from '../store';
import { impactSummary } from '../summary';
import type { BuildStats, GraphData, GraphEdge, GraphNode, NodeType } from '../types';

const n = (type: NodeType, id: string, name = id): GraphNode =>
  ({ arn: `arn:aws:test:r:1:${type}/${id}`, type, id, name, accountId: '1', region: 'r', attrs: {} });
const e = (s: GraphNode, d: GraphNode, type: GraphEdge['type']): GraphEdge => ({ src: s.arn, dst: d.arn, type });

// sg-1 is used by eni-1 (web behind it), alb, eni-2 and api directly.
// sg-2 only allows traffic from sg-1, and tg targets api: neither uses sg-1.
// sg-2는 sg-1에서 오는 트래픽을 허용할 뿐이고, tg는 api 앞에 있을 뿐 — 둘 다 sg-1을 쓰지 않는다.
const sg = n('sg', 'sg-1'), sg2 = n('sg', 'sg-2'), eni = n('eni', 'eni-1'), eni2 = n('eni', 'eni-2');
const web = n('instance', 'i-1', 'web'), api = n('instance', 'i-2', 'api'), alb = n('lb', 'lb-1', 'alb'), tg = n('tg', 'tg-1');
const data: GraphData = {
  nodes: [sg, sg2, eni, eni2, web, api, alb, tg],
  edges: [
    e(eni, sg, 'uses_sg'), e(web, eni, 'uses_eni'), e(alb, sg, 'uses_sg'), e(eni2, sg, 'uses_sg'),
    e(api, sg, 'uses_sg'), e(sg2, sg, 'allows_from'), e(tg, api, 'targets'),
  ],
  dropped: 0,
};
const stats = (warnings: string[] = []): BuildStats => ({ builtAt: '2026-10-28T00:00:00.000Z', nodeCounts: {}, edgeCount: data.edges.length, dropped: 0, warnings });

describe('impactSummary', () => {
  let s: GraphStore;
  beforeAll(async () => { s = await createGraphStore(data, stats()); });
  afterAll(async () => { await s.close(); });

  it('counts only real users (not allows_from sgs or tgs), sample ordered by type priority', async () => {
    expect(await impactSummary('sg-1', s)).toEqual({ count: 3, sample: ['api', 'web', 'alb'], builtAt: '2026-10-28T00:00:00.000Z', truncated: false });
  });
  it('returns null for unknown id or null store', async () => {
    expect(await impactSummary('sg-nope', s)).toBeNull();
    expect(await impactSummary('sg-1', null)).toBeNull();
  });
});

describe('impactSummary edge cases', () => {
  it('marks a capped walk as truncated', async () => {
    const hub = n('sg', 'sg-hub');
    const users = Array.from({ length: 301 }, (_, i) => n('instance', `i-${String(i).padStart(3, '0')}`));
    const g: GraphData = { nodes: [hub, ...users], edges: users.map((u) => e(u, hub, 'uses_sg')), dropped: 0 };
    const s = await createGraphStore(g, stats());
    try {
      const r = await impactSummary('sg-hub', s);
      expect(r).toMatchObject({ count: 300, truncated: true });
    } finally {
      await s.close();
    }
  });

  it('returns null when a kind the count depends on failed to load', async () => {
    const s = await createGraphStore(data, stats());
    // Same store, different build warnings. / 같은 저장소에 경고만 바꿔 본다.
    const withWarnings = (w: string[]): GraphStore => ({ ...s, stats: () => stats(w) });
    try {
      for (const w of ['sg', 'eni', 'instance', 'alb', 'nlb', 'clb', 'rds', 'lambda', 'nat']) {
        expect(await impactSummary('sg-1', withWarnings([w])), w).toBeNull();
      }
      // Other kinds failing does not affect the count. / 상관없는 종류 실패는 괜찮다.
      expect(await impactSummary('sg-1', withWarnings(['s3', 'rolePolicy']))).toMatchObject({ count: 3 });
    } finally {
      await s.close();
    }
  });
});
