// Runs every extractor over the query rows and returns the graph.
// 쿼리 행 전체에서 노드와 간선을 뽑아 그래프를 만든다.
import type { GraphData, Rows } from '../types';
import { buildNodes, buildIndex } from '../nodes';
import { EdgeSink } from '../sink';
import { networkEdges } from './network';
import { computeEdges } from './compute';
import { deliveryEdges } from './delivery';
import { iamEdges } from './iam';

export function extractGraph(rows: Rows): GraphData {
  const nodes = buildNodes(rows);
  const ix = buildIndex(nodes);
  const sink = new EdgeSink();
  networkEdges(rows, ix, sink);
  computeEdges(rows, ix, sink);
  deliveryEdges(rows, ix, sink);
  iamEdges(rows, ix, sink);
  const { edges, dropped } = sink.result();
  return { nodes, edges, dropped };
}
