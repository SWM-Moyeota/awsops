// Pure request parsing + dispatch for the read-only /api/graph route.
// /api/graph 요청 검사와 분기 — 읽기 전용, 순수 함수.
import { clampDepth, type GraphStore } from './store';
import { previewProject, type ProjectSeed } from './project';

export type GraphRequest =
  | { op: 'stats' } | { op: 'hubs'; accountId?: string } | { op: 'search'; q: string; accountId?: string }
  | { op: 'neighborhood' | 'impact' | 'deps'; arn: string; depth: number }
  | { op: 'project'; seed: ProjectSeed; accountId?: string };

const MAX_ARN = 1024, MAX_TEXT = 100, MAX_KEY = 128, MAX_VALUE = 256;
const err = (error: string) => ({ error });

function validArn(s: string | null): s is string {
  return !!s && s.startsWith('arn:') && s.length <= MAX_ARN;
}

export function parseGraphRequest(p: URLSearchParams): GraphRequest | { error: string } {
  const op = p.get('op');
  const acc = p.get('accountId');
  const accountId = acc && /^\d{12}$/.test(acc) ? acc : undefined; // bad ids are ignored / 잘못된 값은 무시
  const scoped = accountId ? { accountId } : {};
  switch (op) {
    case 'stats': return { op: 'stats' };
    case 'hubs': return { op: 'hubs', ...scoped };
    case 'search': {
      const q = (p.get('q') ?? '').trim();
      if (q.length > MAX_TEXT) return err('검색어는 100자까지예요');
      return { op: 'search', q, ...scoped };
    }
    case 'neighborhood':
    case 'impact':
    case 'deps': {
      const arn = p.get('arn');
      if (!validArn(arn)) return err('리소스 ARN이 올바르지 않아요');
      const depth = op === 'neighborhood' ? clampDepth(p.get('depth'), 2, 3) : clampDepth(p.get('depth'), 3, 6);
      return { op, arn, depth };
    }
    case 'project': {
      const tag = p.get('tag'), prefix = p.get('prefix'), vpc = p.get('vpc');
      if ([tag, prefix, vpc].filter(v => v !== null && v !== '').length !== 1) return err('태그·접두어·VPC 중 하나만 골라 주세요');
      if (tag) {
        const i = tag.indexOf('=');
        const key = i > 0 ? tag.slice(0, i) : '', value = i > 0 ? tag.slice(i + 1) : '';
        if (!key || !value || key.length > MAX_KEY || value.length > MAX_VALUE) return err('태그는 키=값 형식으로 적어 주세요');
        return { op: 'project', seed: { kind: 'tag', key, value }, ...scoped };
      }
      if (prefix) {
        if (prefix.length > MAX_TEXT) return err('접두어는 100자까지예요');
        return { op: 'project', seed: { kind: 'prefix', prefix }, ...scoped };
      }
      if (!validArn(vpc)) return err('리소스 ARN이 올바르지 않아요');
      return { op: 'project', seed: { kind: 'vpc', arn: vpc }, ...scoped };
    }
    default: return err('알 수 없는 요청이에요');
  }
}

export async function handleGraphRequest(req: GraphRequest, store: GraphStore | null): Promise<{ status: number; body: unknown }> {
  if (!store) return { status: 200, body: { status: 'building' } };
  const stats = store.stats();
  const builtAt = stats.builtAt;
  const ok = (body: object) => ({ status: 200, body: { builtAt, ...body } });
  const notFound = { status: 404, body: { error: 'not-found', builtAt } };
  switch (req.op) {
    case 'stats': return { status: 200, body: { status: 'ready', stats } };
    case 'hubs': return ok({ hubs: await store.hubs({ accountId: req.accountId }) });
    case 'search': return ok({ results: await store.search(req.q, { accountId: req.accountId }) });
    case 'neighborhood': {
      const n = await store.neighborhood(req.arn, req.depth);
      return n ? ok(n) : notFound;
    }
    case 'impact':
    case 'deps': {
      if (!(await store.node(req.arn))) return notFound;
      return ok(req.op === 'impact' ? await store.impact(req.arn, req.depth) : await store.dependencies(req.arn, req.depth));
    }
    case 'project': return ok(previewProject(store.data(), req.seed, { accountId: req.accountId }));
  }
}
