// Testable handlers for /api/terraform-export; the route file stays thin.
// /api/terraform-export 처리기 — 라우트 파일은 얇게 유지한다.
import { JOB_ID, readStats } from './store';
import type { ExportSeed, JobRecord, ExportItem, Excluded } from './types';

export interface ApiResult { status: number; body: unknown; zip?: Buffer; text?: string; filename?: string }
export interface ApiDeps {
  recover?: () => Promise<unknown>;
  installed?: () => Promise<{ installed: boolean; version?: string }>;
  running?: () => string | null;
  start?: (req: { accountId: string; seed: ExportSeed; requestedBy: string | null }) => Promise<{ jobId: string }>;
  preview?: (accountId: string, seed: ExportSeed) => Promise<{ items: ExportItem[]; excluded: Excluded[] } | null>;
  getJob?: (id: string) => Promise<JobRecord | null>;
  listJobs?: () => Promise<JobRecord[]>;
  readFile?: (id: string, name: string) => Promise<string | null>;
  zip?: (id: string) => Promise<Buffer | null>;
  stats?: () => Promise<unknown>;
}

const ACCOUNT_RE = /^\d{12}$/;
const MAX_ARNS = 60;
const MAX_ARN_LEN = 2048;
const bad = (error: string): ApiResult => ({ status: 400, body: { error } });
const fail = (e: unknown): ApiResult => ({ status: 500, body: { error: e instanceof Error ? e.name : 'Error' } });

// Recover interrupted jobs once per process, before the first request / 프로세스당 한 번, 첫 요청 전에 중단된 작업 정리
let recovered: Promise<unknown> | null = null;
async function ensureRecovered(deps: ApiDeps): Promise<void> {
  if (deps.recover) { await deps.recover(); return; }
  if (!recovered) recovered = import('./job').then(j => j.recoverInterrupted()).catch(() => undefined);
  await recovered;
}

// Validate the request seed and map it to the internal shape / 요청 시드를 검증해 내부 형태로 변환
export function parseSeed(raw: unknown): ExportSeed | string {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!s) return 'seed가 필요합니다';
  const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max ? v.trim() : null);
  if (s.tag !== undefined) {
    const t = s.tag && typeof s.tag === 'object' ? (s.tag as Record<string, unknown>) : {};
    const key = str(t.key, 128), value = str(t.value, 128);
    return key && value ? { kind: 'tag', key, value } : '태그 키와 값은 1~128자여야 합니다';
  }
  if (s.prefix !== undefined) {
    const prefix = str(s.prefix, 64);
    return prefix ? { kind: 'prefix', prefix } : '이름 접두어는 1~64자여야 합니다';
  }
  if (s.vpc !== undefined) {
    return typeof s.vpc === 'string' && s.vpc.startsWith('arn:aws:ec2:') && s.vpc.length <= MAX_ARN_LEN ? { kind: 'vpc', arn: s.vpc } : 'VPC ARN 형식이 올바르지 않습니다';
  }
  if (s.arns !== undefined) {
    const a = s.arns;
    if (!Array.isArray(a) || a.length < 1 || a.length > MAX_ARNS) return `arns는 1~${MAX_ARNS}개여야 합니다`;
    if (!a.every(x => typeof x === 'string' && x.startsWith('arn:') && x.length <= MAX_ARN_LEN)) return 'ARN 형식이 올바르지 않습니다';
    return { kind: 'arns', arns: a as string[] };
  }
  return 'seed는 tag, prefix, vpc, arns 중 하나여야 합니다';
}

// Default preview: select against the current graph / 기본 미리 보기: 현재 그래프에서 고른다
async function defaultPreview(accountId: string, seed: ExportSeed) {
  const [{ getCurrentStore }, { getConfig }, { selectResources }] = await Promise.all([
    import('@/lib/dep-graph/store'), import('@/lib/app-config'), import('./select'),
  ]);
  const data = getCurrentStore()?.data();
  if (!data) return null;
  const cfg = getConfig();
  const acc = cfg.accounts?.find(a => a.accountId === accountId);
  const region = acc?.region ?? cfg.accounts?.find(a => a.isHost)?.region ?? (cfg as { region?: string }).region ?? 'ap-northeast-2';
  return selectResources({ accountId, seed, data, region });
}

export async function handleTerraformGet(params: URLSearchParams, deps: ApiDeps = {}): Promise<ApiResult> {
  const op = params.get('op');
  try {
    await ensureRecovered(deps);
    const job = deps.getJob ?? (async (id: string) => (await import('./job')).getJob(id));
    if (op === 'status') {
      const inst = await (deps.installed ?? (async () => (await import('./runner')).isInstalled()))();
      const running = deps.running ? deps.running() : (await import('./job')).runningJobId();
      return { status: 200, body: { installed: inst.installed, version: inst.version ?? null, running } };
    }
    if (op === 'list') {
      const list = await (deps.listJobs ?? (async () => (await import('./job')).listJobs()))();
      return { status: 200, body: { jobs: list.slice(0, 20) } };
    }
    if (op === 'stats') return { status: 200, body: { stats: await (deps.stats ?? readStats)() } };
    if (op === 'job' || op === 'file' || op === 'download') {
      const id = params.get('id') || '';
      if (!JOB_ID.test(id)) return bad('id 형식이 올바르지 않습니다');
      if (op === 'job') {
        const j = await job(id);
        return j ? { status: 200, body: { job: j } } : { status: 404, body: { error: 'NotFound' } };
      }
      if (op === 'file') {
        const name = params.get('name') || '';
        const j = await job(id);
        if (!j) return { status: 404, body: { error: 'NotFound' } };
        if (!name || !j.files?.includes(name)) return { status: 404, body: { error: 'NotFound' } };
        const text = await (deps.readFile ?? (async (i: string, n: string) => (await import('./job')).readBundleFile(i, n)))(id, name);
        return text === null ? { status: 404, body: { error: 'NotFound' } } : { status: 200, body: null, text };
      }
      const zip = await (deps.zip ?? (async (i: string) => (await import('./job')).bundleZip(i)))(id);
      return zip ? { status: 200, body: null, zip, filename: `terraform-${id}.zip` } : { status: 404, body: { error: 'NotFound' } };
    }
    return bad('op가 올바르지 않습니다');
  } catch (e) { return fail(e); }
}

export async function handleTerraformPost(body: unknown, userId: string | null, deps: ApiDeps = {}): Promise<ApiResult> {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!b || (b.op !== 'preview' && b.op !== 'start')) return bad('op는 preview 또는 start여야 합니다');
  if (typeof b.accountId !== 'string' || !ACCOUNT_RE.test(b.accountId)) return bad('accountId는 12자리 숫자여야 합니다');
  const seed = parseSeed(b.seed);
  if (typeof seed === 'string') return bad(seed);
  try {
    await ensureRecovered(deps);
    if (b.op === 'preview') {
      const r = await (deps.preview ?? defaultPreview)(b.accountId, seed);
      return r ? { status: 200, body: r } : { status: 404, body: { error: 'no-graph' } };
    }
    const start = deps.start ?? (async (req) => (await import('./job')).startJob(req));
    const { jobId } = await start({ accountId: b.accountId, seed, requestedBy: userId });
    return { status: 202, body: { jobId } };
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    const code = ({ Busy: 429, NotInstalled: 409, NotFound: 404, Empty: 400 } as Record<string, number>)[name];
    return { status: code ?? 500, body: { error: name } };
  }
}
