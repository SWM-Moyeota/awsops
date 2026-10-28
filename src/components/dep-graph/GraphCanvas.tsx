'use client';

// React Flow canvas: the caller gives positions (neighborhood columns or cleanup steps).
// 그래프 캔버스 — 좌표는 부르는 쪽이 준다(주변 그래프 열 또는 정리 단계). 노드를 누르면 그 노드가 중심이 된다.
import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MarkerType, Position, type Edge, type Node } from 'reactflow';
import 'reactflow/dist/style.css';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import type { GraphEdge, GraphNode } from '@/lib/dep-graph/types';
import { typeColor } from './layout';

// First attr worth showing under the name. / 이름 아래에 보여 줄 첫 속성
const EXTRA_KEYS = ['state', 'status', 'cidr', 'instanceType', 'engine', 'publicIp', 'privateIp', 'dnsName', 'domainName'];

function extraOf(attrs: Record<string, unknown>): string | undefined {
  for (const k of EXTRA_KEYS) {
    const v = attrs?.[k];
    if (typeof v === 'string' || typeof v === 'number') return String(v).slice(0, 40);
  }
  return undefined;
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Record<string, { x: number; y: number }>;
  /** Highlighted node, if any; clicking it does nothing. / 강조할 중심 노드(있으면). */
  centerArn?: string;
  onPick?: (arn: string) => void;
  /** Changes when the graph should be re-framed. / 바뀌면 다시 맞춰 보인다. */
  frameKey: string;
}

export default function GraphCanvas({ nodes: inNodes, edges: inEdges, positions, centerArn, onPick, frameKey }: Props) {
  const { t } = useLanguage();

  const { nodes, edges } = useMemo(() => {
    const pos = positions;
    const nodes: Node[] = inNodes.map((n) => {
      const color = typeColor(n.type);
      const isCenter = n.arn === centerArn;
      const extra = extraOf(n.attrs);
      return {
        id: n.arn,
        position: pos[n.arn] ?? { x: 0, y: 0 },
        data: {
          label: (
            <div style={{ textAlign: 'center', fontSize: 11, lineHeight: 1.3 }} title={n.arn}>
              <div style={{ fontSize: 9, color, fontWeight: 600, letterSpacing: 0.5, marginBottom: 2 }}>{t(`depGraph.type.${n.type}`)}</div>
              <div style={{ color: '#e5e7eb', fontWeight: isCenter ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</div>
              {extra && <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 1 }}>{extra}</div>}
            </div>
          ),
        },
        style: {
          background: isCenter ? '#151d30' : '#0f1629',
          border: `${isCenter ? 3 : 1.5}px solid ${color}`,
          boxShadow: isCenter ? `0 0 14px ${color}55` : undefined,
          borderRadius: 8,
          padding: '8px 12px',
          width: 180,
          color: '#e5e7eb',
          cursor: onPick ? 'pointer' : 'default',
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
        connectable: false,
      };
    });
    // src uses dst: dependents sit left of what they use, so arrows point rightwards.
    // src가 dst를 쓴다 — 쓰는 쪽이 왼쪽이라 화살표는 오른쪽을 향한다.
    const edges: Edge[] = inEdges.map((e) => ({
      id: `${e.src}|${e.dst}|${e.type}`,
      source: e.src,
      target: e.dst,
      label: t(`depGraph.edge.${e.type}`),
      labelStyle: { fill: '#9ca3af', fontSize: 9 },
      labelBgStyle: { fill: '#0a0e1a' },
      style: { stroke: '#213052', strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#213052', width: 15, height: 15 },
      type: 'smoothstep',
    }));
    return { nodes, edges };
  }, [inNodes, inEdges, positions, centerArn, onPick, t]);

  return (
    <ReactFlow
      // Remount per frameKey so fitView re-frames the new graph. / 그래프가 바뀌면 다시 맞춰 보이도록 재마운트
      key={frameKey}
      nodes={nodes}
      edges={edges}
      onNodeClick={(_, node) => { if (onPick && node.id !== centerArn) onPick(node.id); }}
      nodesDraggable={false}
      nodesConnectable={false}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.1}
      maxZoom={2}
    >
      <Background color="#1a2540" gap={20} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
