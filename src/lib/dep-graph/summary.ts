// Impact summary for one resource, read from the in-memory graph only (never builds).
// 메모리 그래프에서 영향 요약만 읽는다 — 빌드를 일으키지 않는다.
import { getCurrentStore, type GraphStore } from './store';
import type { EdgeType, GraphImpact } from './types';

const TYPE_ORDER = ['instance', 'lb', 'rds', 'lambda', 'nat'];
const rank = (t: string) => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? TYPE_ORDER.length : i; };

// Only real users: sg ← (eni|instance|lb|rds|lambda) and eni ← (instance|lb|nat|lambda|rds).
// allows_from sgs and target groups in front of an instance do not use the sg.
// 진짜로 쓰는 것만 — allows_from 보안그룹이나 서버 앞의 대상 그룹은 이 보안그룹을 쓰지 않는다.
const USER_EDGES: EdgeType[] = ['uses_sg', 'uses_eni'];

// If any of these failed to load, the count would be wrong, so no line at all.
// 이 종류 중 하나라도 못 읽었으면 숫자가 틀리므로 줄을 내지 않는다.
const NEEDED = ['sg', 'eni', 'instance', 'alb', 'nlb', 'clb', 'rds', 'lambda', 'nat'];

export async function impactSummary(resourceId: string, store?: GraphStore | null): Promise<GraphImpact | null> {
  try {
    const s = store ?? getCurrentStore();
    if (!s) return null;
    const st = s.stats();
    if ((st.warnings ?? []).some(w => NEEDED.includes(w))) return null;
    const node = await s.nodeById(resourceId);
    if (!node) return null;
    const { nodes, truncated } = await s.impact(node.arn, 2, { edgeTypes: USER_EDGES });
    const users = nodes.filter(x => x.type !== 'eni' && x.arn !== node.arn);
    users.sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name));
    return { count: users.length, sample: users.slice(0, 3).map(x => x.name), builtAt: st.builtAt, truncated };
  } catch {
    return null;
  }
}
