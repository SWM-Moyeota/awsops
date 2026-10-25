// In-memory state machine for control requests — the single place that enforces the two-step approval
// and single-use execution. Kept in memory on purpose: a server restart drops pending requests (safe default).
// 2단계 승인과 1회 실행을 강제하는 유일한 곳. 서버 재시작 시 대기 요청은 사라진다 (안전한 기본값).
import { randomUUID } from 'node:crypto';
import type { ControlAction, ControlConfig, ControlRequest, ControllableInstance } from './types';

export type Transition = { ok: true; req: ControlRequest } | { ok: false; reason: string };

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_KEPT = 200;

export interface RequestStore {
  create(input: { action: ControlAction; instance: ControllableInstance; requesterId: string; channel: string; threadTs: string }): ControlRequest;
  get(id: string): ControlRequest | undefined;
  setCardTs(id: string, ts: string): void;
  /** Step 1: the requester confirms the parsed target. proposed → pending */
  confirm(id: string, userId: string, ttlMs?: number): Transition;
  /** Step 2: an approver (not the requester unless allowed) approves. pending → executing, exactly once. */
  beginApproval(id: string, userId: string, cfg: ControlConfig): Transition;
  finish(id: string, status: 'executed' | 'failed', result: string): void;
  reject(id: string, userId: string, cfg: ControlConfig): Transition;
  cancel(id: string, userId: string, cfg: ControlConfig): Transition;
}

const fail = (reason: string): Transition => ({ ok: false, reason });

export function createRequestStore(opts: { now?: () => number } = {}): RequestStore {
  const now = opts.now ?? Date.now;
  const requests = new Map<string, ControlRequest>();

  function load(id: string, ttlMs: number): ControlRequest | string {
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
      const req: ControlRequest = { ...input, id: randomUUID(), status: 'proposed', createdAt: now() };
      requests.set(req.id, req);
      // Bound memory: drop the oldest finished requests. / 오래된 요청부터 정리
      if (requests.size > MAX_KEPT) requests.delete(requests.keys().next().value as string);
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
      if (req.status === 'proposed') return fail('요청자가 먼저 1단계 확인을 해야 해요.');
      if (req.status !== 'pending') return fail('이미 처리된 요청이에요.');
      if (!cfg.allowSelfApproval && userId === req.requesterId) {
        return fail('요청한 본인은 최종 승인할 수 없어요. 다른 승인자가 승인해야 해요.');
      }
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
