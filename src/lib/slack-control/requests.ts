// In-memory state machine for control requests — the single place that enforces the two-step approval
// and single-use execution. Kept in memory on purpose: a server restart drops pending requests (safe default).
// 2단계 승인과 1회 실행을 강제하는 유일한 곳. 서버 재시작 시 대기 요청은 사라진다 (안전한 기본값).
import { randomUUID } from 'node:crypto';
import type { ApprovalRecord, ControlConfig, ControlRequest } from './types';

export type Transition<R extends ApprovalRecord = ControlRequest> = { ok: true; req: R } | { ok: false; reason: string };

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_KEPT = 200;
const FINAL = new Set(['executed', 'failed', 'cancelled', 'rejected', 'expired']);

export interface ApprovalStore<R extends ApprovalRecord> {
  create(input: Omit<R, keyof ApprovalRecord> & Pick<ApprovalRecord, 'requesterId' | 'channel' | 'threadTs'>): R;
  get(id: string): R | undefined;
  setCardTs(id: string, ts: string): void;
  /** Step 1: the requester confirms the parsed target. proposed → pending */
  confirm(id: string, userId: string, ttlMs?: number): Transition<R>;
  /** Step 2: an approver (not the requester unless allowed) approves. pending → executing, exactly once. */
  beginApproval(id: string, userId: string, cfg: ControlConfig): Transition<R>;
  finish(id: string, status: 'executed' | 'failed', result: string): void;
  reject(id: string, userId: string, cfg: ControlConfig): Transition<R>;
  cancel(id: string, userId: string, cfg: ControlConfig): Transition<R>;
}

export type RequestStore = ApprovalStore<ControlRequest>;

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export function createApprovalStore<R extends ApprovalRecord>(opts: { now?: () => number } = {}): ApprovalStore<R> {
  const now = opts.now ?? Date.now;
  const requests = new Map<string, R>();

  function load(id: string, ttlMs: number): R | string {
    const req = requests.get(id);
    if (!req) return '요청을 찾을 수 없어요. 서버가 재시작됐거나 오래된 요청이에요.';
    if ((req.status === 'proposed' || req.status === 'pending') && now() - req.createdAt > ttlMs) {
      req.status = 'expired';
    }
    if (req.status === 'expired') return '요청이 만료됐어요. 다시 요청해 주세요.';
    return req;
  }

  const isApprover = (userId: string, cfg: ControlConfig) => cfg.approverIds.includes(userId);

  return {
    create(input) {
      // input omits the ApprovalRecord fields we fill in here; TS can't see that R is exactly input + those. / 입력에 빠진 공용 필드를 여기서 채움
      const req = { ...input, id: randomUUID(), status: 'proposed', createdAt: now() } as unknown as R;
      requests.set(req.id, req);
      // Bound memory: drop the oldest *finished* request — never one that is still pending or executing.
      // 메모리 상한: 끝난 요청만 오래된 순으로 정리한다 (진행 중인 요청은 절대 지우지 않는다)
      if (requests.size > MAX_KEPT) {
        const oldestFinished = Array.from(requests.values()).find(r => FINAL.has(r.status));
        if (oldestFinished) requests.delete(oldestFinished.id);
      }
      return req;
    },
    get: id => requests.get(id),
    setCardTs(id, ts) {
      const req = requests.get(id);
      if (req) req.cardTs = ts;
    },
    confirm(id, userId, ttlMs = DEFAULT_TTL_MS) {
      const req = load(id, ttlMs);
      if (typeof req === 'string') return fail(req);
      if (req.status !== 'proposed') return fail('이미 처리된 단계예요.');
      if (userId !== req.requesterId) return fail('1단계 확인은 요청한 사람만 할 수 있어요.');
      req.status = 'pending';
      req.confirmedAt = now();
      return { ok: true, req };
    },
    beginApproval(id, userId, cfg) {
      const req = load(id, cfg.ttlMs);
      if (typeof req === 'string') return fail(req);
      // Self-approval is refused at every stage, including before step 1. / 1단계 전에도 본인 승인은 거절
      if ((req.status === 'proposed' || req.status === 'pending') && !cfg.allowSelfApproval && userId === req.requesterId) {
        return fail('요청한 본인은 최종 승인할 수 없어요. 다른 승인자가 승인해야 해요.');
      }
      if (req.status === 'proposed') return fail('요청자가 먼저 1단계 확인을 해야 해요.');
      if (req.status !== 'pending') return fail('이미 처리된 요청이에요.');
      if (!isApprover(userId, cfg)) return fail('최종 승인 권한이 없어요. 지정된 승인자만 승인할 수 있어요.');
      // Synchronous check-and-set: a second click can never see 'pending' again. / 동기 전이라 두 번 실행 불가
      req.status = 'executing';
      req.deciderId = userId;
      req.decidedAt = now();
      return { ok: true, req };
    },
    finish(id, status, result) {
      const req = requests.get(id);
      if (!req || req.status !== 'executing') return;
      req.status = status;
      req.result = result;
    },
    reject(id, userId, cfg) {
      const req = load(id, cfg.ttlMs);
      if (typeof req === 'string') return fail(req);
      if (req.status !== 'pending') return fail('거절할 수 있는 단계가 아니에요.');
      if (!isApprover(userId, cfg)) return fail('거절 권한이 없어요.');
      req.status = 'rejected';
      req.deciderId = userId;
      req.decidedAt = now();
      return { ok: true, req };
    },
    cancel(id, userId, cfg) {
      const req = load(id, cfg.ttlMs);
      if (typeof req === 'string') return fail(req);
      if (req.status !== 'proposed' && req.status !== 'pending') return fail('취소할 수 있는 단계가 아니에요.');
      if (userId !== req.requesterId) return fail('취소는 요청한 사람만 할 수 있어요.');
      req.status = 'cancelled';
      req.deciderId = userId;
      req.decidedAt = now();
      return { ok: true, req };
    },
  };
}

export function createRequestStore(opts: { now?: () => number } = {}): RequestStore {
  return createApprovalStore<ControlRequest>(opts);
}
