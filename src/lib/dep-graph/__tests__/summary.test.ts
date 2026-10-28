import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGraphStore, type GraphStore } from '../store';
import { impactSummary } from '../summary';
import type { BuildStats, GraphData, GraphEdge, GraphNode, NodeType } from '../types';

const n = (type: NodeType, id: string, name = id): GraphNode =>
  ({ arn: `arn:aws:test:r:1:${type}/${id}`, type, id, name, accountId: '1', region: 'r', attrs: {} });
const e = (s: GraphNode, d: GraphNode, type: GraphEdge['type']): GraphEdge => ({ src: s.arn, dst: d.arn, type });

const sg = n('sg', 'sg-1'), eni = n('eni', 'eni-1'), eni2 = n('eni', 'eni-2');
const web = n('instance', 'i-1', 'web'), alb = n('lb', 'lb-1', 'alb');
const data: GraphData = {
  nodes: [sg, eni, eni2, web, alb],
  edges: [e(eni, sg, 'uses_sg'), e(web, eni, 'uses_eni'), e(alb, sg, 'uses_sg'), e(eni2, sg, 'uses_sg')],
  dropped: 0,
};
const stats: BuildStats = { builtAt: '2026-10-28T00:00:00.000Z', nodeCounts: {}, edgeCount: 4, dropped: 0, warnings: [] };

describe('impactSummary', () => {
  let s: GraphStore;
  beforeAll(async () => { s = await createGraphStore(data, stats); });
  afterAll(async () => { await s.close(); });

  it('counts non-eni users, sample ordered by type priority', async () => {
    expect(await impactSummary('sg-1', s)).toEqual({ count: 2, sample: ['web', 'alb'], builtAt: stats.builtAt });
  });
  it('returns null for unknown id or null store', async () => {
    expect(await impactSummary('sg-nope', s)).toBeNull();
    expect(await impactSummary('sg-1', null)).toBeNull();
  });
});
