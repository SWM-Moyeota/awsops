'use client';

// React Flow canvas for one neighborhood: dependents left, center middle, dependencies right.
// 주변 그래프 캔버스 — 나를 쓰는 쪽 왼쪽, 중심 가운데, 내가 쓰는 쪽 오른쪽. 노드를 누르면 그 노드가 중심이 된다.
import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MarkerType, Position, type Edge, type Node } from 'reactflow';
import 'reactflow/dist/style.css';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { layoutNeighborhood, typeColor } from './layout';
import type { NeighborhoodBody } from './api';

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
  nb: NeighborhoodBody;
  onPick: (arn: string) => void;
}

export default function GraphCanvas({ nb, onPick }: Props) {
  const { t } = useLanguage();

  const { nodes, edges } = useMemo(() => {
    const pos = layoutNeighborhood({ nodes: nb.nodes });
    const nodes: Node[] = nb.nodes.map((n) => {
      const color = typeColor(n.type);
      const isCenter = n.side === 'center' || n.arn === nb.center.arn;
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
          cursor: 'pointer',
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
        connectable: false,
      };
    });
    // src uses dst: dependents sit left of what they use, so arrows point rightwards.
    // src가 dst를 쓴다 — 쓰는 쪽이 왼쪽이라 화살표는 오른쪽을 향한다.
    const edges: Edge[] = nb.edges.map((e) => ({
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
  }, [nb, t]);

  return (
    <ReactFlow
      // Remount per center so fitView re-frames the new graph. / 중심이 바뀌면 다시 맞춰 보이도록 재마운트
      key={`${nb.center.arn}|${nb.nodes.length}`}
      nodes={nodes}
      edges={edges}
      onNodeClick={(_, node) => { if (node.id !== nb.center.arn) onPick(node.id); }}
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
