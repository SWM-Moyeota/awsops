// Collects edges: dedupes, ignores self loops, counts edges with a missing end.
// 간선 수집기 — 중복은 한 번만, 자기 자신은 무시, 끝점이 없으면 dropped로 센다.
import type { EdgeType, GraphEdge } from './types';

export class EdgeSink {
  private seen = new Set<string>();
  private edges: GraphEdge[] = [];
  private dropped = 0;

  add(src: string | undefined, dst: string | undefined, type: EdgeType): void {
    if (!src || !dst) { this.dropped++; return; }
    if (src === dst) return;
    const key = `${src}\u0000${dst}\u0000${type}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.edges.push({ src, dst, type });
  }

  result(): { edges: GraphEdge[]; dropped: number } {
    return { edges: this.edges, dropped: this.dropped };
  }
}
