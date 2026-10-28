// Pure layout + colours for the dependency graph canvas (no React, unit-tested).
// 의존성 그래프 캔버스 배치·색 — 순수 함수(React 없음), 단위 테스트 대상.
import type { NodeType } from '@/lib/dep-graph/types';

export const COLUMN_GAP = 260;
export const ROW_GAP = 80;

// Theme accents only (+ gray): network cyan/green, compute purple, data orange, IAM red.
// 테마 강조색만 사용: 네트워크 cyan/green, 컴퓨팅 purple, 데이터 orange, IAM red, 그 밖은 gray.
export const TYPE_COLORS: Record<NodeType, string> = {
  vpc: '#00d4ff',
  subnet: '#00ff88',
  eni: '#00ff88',
  sg: '#00d4ff',
  nat: '#00d4ff',
  eip: '#00ff88',
  lb: '#00d4ff',
  tg: '#00ff88',
  cloudfront: '#00d4ff',
  instance: '#a855f7',
  lambda: '#a855f7',
  rds: '#f59e0b',
  ebs: '#f59e0b',
  s3: '#f59e0b',
  role: '#ef4444',
};

export const typeColor = (type: string): string => (TYPE_COLORS as Record<string, string>)[type] || '#6b7280';

export interface LayoutInputNode {
  arn: string;
  type: string;
  name: string;
  depth: number;
  side: 'center' | 'dependent' | 'dependency';
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Columns: center x=0, dependents (who use me) to the left, dependencies (what I use) to the right,
 * one column per depth. Inside a column sort by type then name, centred on y=0.
 * 열 배치: 중심 0, 나를 쓰는 쪽은 왼쪽, 내가 쓰는 쪽은 오른쪽, 깊이마다 한 열. 열 안은 종류→이름 순.
 */
export function layoutNeighborhood(nb: { nodes: LayoutInputNode[] }): Record<string, { x: number; y: number }> {
  const columns = new Map<number, LayoutInputNode[]>();
  for (const nd of nb.nodes) {
    const x = nd.side === 'center' ? 0 : (nd.side === 'dependent' ? -1 : 1) * nd.depth * COLUMN_GAP;
    if (!columns.has(x)) columns.set(x, []);
    columns.get(x)!.push(nd);
  }
  const out: Record<string, { x: number; y: number }> = {};
  columns.forEach((list, x) => {
    list.sort((a, b) => cmp(a.type, b.type) || cmp(a.name, b.name) || cmp(a.arn, b.arn));
    const half = ((list.length - 1) * ROW_GAP) / 2;
    list.forEach((nd, i) => { out[nd.arn] = { x, y: i * ROW_GAP - half }; });
  });
  return out;
}

/**
 * Cleanup order as columns: step i (0-based) at x = i*260, inside a step sorted by arn,
 * `y = j*80 - (count-1)*40`. Dependents (deleted first) sit left of what they use.
 * 정리 순서를 열로: i번째 단계(0부터)는 x = i*260, 단계 안은 arn 순, 위아래 가운데 정렬.
 */
export function layoutSteps(order: Array<{ step?: number; arns: string[]; cycle?: boolean }>): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  order.forEach((st, i) => {
    const list = [...st.arns].sort(cmp);
    const half = ((list.length - 1) * ROW_GAP) / 2;
    list.forEach((arn, j) => { out[arn] = { x: i * COLUMN_GAP, y: j * ROW_GAP - half }; });
  });
  return out;
}
