// Testable handlers for /api/root-cause (list, get, manual analyze); the route file stays thin.
// /api/root-cause 처리기(목록·상세·수동 분석) — 라우트 파일은 얇게 유지한다.
import { getConfig } from '@/lib/app-config';
import { readIncidents } from './store';
import { manualAnalyze, type ManualDeps } from './analyze';
import type { Incident } from './types';

export interface ApiResult { status: number; body: unknown }
export interface ApiDeps {
  read?: () => Promise<Incident[]>;
  analyze?: (req: { accountId: string; resourceArn: string | null; at?: string; userId?: string }, deps?: ManualDeps) => Promise<Incident>;
  autoDetect?: () => boolean;
}

const MAX_LIST = 50;
const MAX_ARN = 2048;
const ACCOUNT_RE = /^\d{12}$/;
const ID_RE = /^rc-[a-z0-9]{10}$/;
const bad = (error: string): ApiResult => ({ status: 400, body: { error } });

// Keep only the top suspect in list rows. / 목록에는 1순위 용의자만 남긴다.
function summarize(inc: Incident): Incident {
  if (!inc.analysis) return inc;
  return { ...inc, analysis: { ...inc.analysis, suspects: inc.analysis.suspects.slice(0, 1) } };
}

export async function handleRootCauseGet(params: URLSearchParams, deps: ApiDeps = {}): Promise<ApiResult> {
  const read = deps.read ?? readIncidents;
  const op = params.get('op');
  try {
    if (op === 'list') {
      const accountId = params.get('accountId') || '__all__';
      if (accountId !== '__all__' && !ACCOUNT_RE.test(accountId)) return bad('accountId는 12자리 숫자이거나 __all__이어야 합니다');
      const list = (await read()).filter((i) => accountId === '__all__' || i.accountId === accountId).slice(0, MAX_LIST).map(summarize);
      const autoDetect = deps.autoDetect ? deps.autoDetect() : getConfig().rootCause?.autoDetect !== false;
      return { status: 200, body: { incidents: list, autoDetect } };
    }
    if (op === 'get') {
      const id = params.get('id') || '';
      if (!ID_RE.test(id)) return bad('id 형식이 올바르지 않습니다');
      const found = (await read()).find((i) => i.id === id);
      return found ? { status: 200, body: { incident: found } } : { status: 404, body: { error: 'not-found' } };
    }
    return bad('op는 list 또는 get이어야 합니다');
  } catch (e) {
    return { status: 500, body: { error: e instanceof Error ? e.name : 'Error' } };
  }
}

export async function handleRootCausePost(body: unknown, userId: string | null, deps: ApiDeps = {}): Promise<ApiResult> {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!b || b.op !== 'analyze') return bad('op는 analyze여야 합니다');
  if (typeof b.accountId !== 'string' || !ACCOUNT_RE.test(b.accountId)) return bad('accountId는 12자리 숫자여야 합니다');
  const arn = b.resourceArn ?? null;
  if (arn !== null && (typeof arn !== 'string' || !arn.startsWith('arn:') || arn.length > MAX_ARN)) return bad('resourceArn 형식이 올바르지 않습니다');
  if (b.at !== undefined && (typeof b.at !== 'string' || Number.isNaN(new Date(b.at).getTime()))) return bad('at은 ISO 시각이어야 합니다');
  try {
    const incident = await (deps.analyze ?? manualAnalyze)({
      accountId: b.accountId, resourceArn: arn as string | null,
      ...(b.at !== undefined ? { at: b.at as string } : {}), ...(userId ? { userId } : {}),
    });
    return { status: 200, body: { incident } };
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    if (name === 'RateLimited') return { status: 429, body: { error: name } };
    if (name === 'NotFound') return { status: 404, body: { error: name } };
    if (name === 'BadTime') return { status: 400, body: { error: name } };
    if (name === 'Timeout') return { status: 202, body: { status: 'running' } };
    return { status: 500, body: { error: name } };
  }
}
