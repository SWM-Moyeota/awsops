// Impact summary for one resource, read from the in-memory graph only (never builds).
// 메모리 그래프에서 영향 요약만 읽는다 — 빌드를 일으키지 않는다.
import { getCurrentStore, type GraphStore } from './store';
import type { GraphImpact } from './types';

const TYPE_ORDER = ['instance', 'lb', 'rds', 'lambda', 'nat', 'sg', 'tg'];
const rank = (t: string) => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? TYPE_ORDER.length : i; };

export async function impactSummary(resourceId: string, store?: GraphStore | null): Promise<GraphImpact | null> {
  try {
    const s = store ?? getCurrentStore();
    if (!s) return null;
    const node = await s.nodeById(resourceId);
    if (!node) return null;
    const { nodes } = await s.impact(node.arn, 2);
    const users = nodes.filter(x => x.type !== 'eni' && x.arn !== node.arn);
    users.sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name));
    return { count: users.length, sample: users.slice(0, 3).map(x => x.name), builtAt: s.stats().builtAt };
  } catch {
    return null;
  }
}
