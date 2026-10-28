// Pure request parsing + dispatch for the read-only /api/graph route.
// /api/graph 요청 검사와 분기 — 읽기 전용, 순수 함수.
import { clampDepth, type GraphStore } from './store';
import { previewProject, type ProjectSeed } from './project';
import type { NodeType } from './types';

export type GraphRequest =
  | { op: 'stats' } | { op: 'hubs'; accountId?: string } | { op: 'search'; q: string; accountId?: string; type?: NodeType }
  | { op: 'neighborhood' | 'impact' | 'deps'; arn: string; depth: number }
  | { op: 'project'; seed: ProjectSeed; accountId?: string };

const MAX_ARN = 1024, MAX_TEXT = 100, MAX_KEY = 128, MAX_VALUE = 256;
const err = (error: string) => ({ error });
const NODE_TYPES: readonly NodeType[] = ['vpc', 'subnet', 'eni', 'instance', 'sg', 'lb', 'tg', 'rds', 'lambda', 'role', 'nat', 'eip', 'ebs', 's3', 'cloudfront'];
const isNodeType = (v: string): v is NodeType => (NODE_TYPES as readonly string[]).includes(v);

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
      const type = p.get('type');
      if (type === null) return { op: 'search', q, ...scoped };
      if (!isNodeType(type)) return err('알 수 없는 리소스 종류예요');
      return { op: 'search', q, ...scoped, type };
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
      // Key, value and prefix are trimmed; whitespace-only is an error.
      // 키·값·접두어는 앞뒤 공백을 빼고, 공백뿐이면 오류.
      if (tag) {
        const i = tag.indexOf('=');
        const key = i >= 0 ? tag.slice(0, i).trim() : '', value = i >= 0 ? tag.slice(i + 1).trim() : '';
        if (!key || !value || key.length > MAX_KEY || value.length > MAX_VALUE) return err('태그는 키=값 형식으로 적어 주세요');
        return { op: 'project', seed: { kind: 'tag', key, value }, ...scoped };
      }
      if (prefix) {
        const pre = prefix.trim();
        if (!pre) return err('접두어를 적어 주세요');
        if (pre.length > MAX_TEXT) return err('접두어는 100자까지예요');
        return { op: 'project', seed: { kind: 'prefix', prefix: pre }, ...scoped };
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
    case 'search': return ok({ results: await store.search(req.q, { accountId: req.accountId, type: req.type }) });
    case 'neighborhood': {
      const n = await store.neighborhood(req.arn, req.depth);
      return n ? ok(n) : notFound;
    }
    case 'impact':
    case 'deps': {
      if (!(await store.node(req.arn))) return notFound;
      return ok(req.op === 'impact' ? await store.impact(req.arn, req.depth) : await store.dependencies(req.arn, req.depth));
    }
    case 'project': {
      if (req.seed.kind === 'vpc' && !(await store.node(req.seed.arn))) return notFound;
      // Failed kinds travel with the preview so the screen can warn. / 못 읽은 종류를 함께 보낸다.
      return ok({ ...previewProject(store.data(), req.seed, { accountId: req.accountId }), warnings: stats.warnings ?? [] });
    }
  }
}
