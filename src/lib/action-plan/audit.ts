// Append-only, hash-chained audit log of every action-plan state change (data/action-plan/audit.jsonl).
// hash = sha256(prevHash + canonicalJson(entry + at + prevHash)); the first line's prevHash is "0".
// 액션 플랜 상태 변화를 해시 체인으로 추가 전용 기록한다. 쓰기 실패는 승인 흐름을 막지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionRequest } from './types';

export function actionPlanDir(): string {
  return process.env.ACTION_PLAN_DATA_DIR || path.join(process.cwd(), 'data', 'action-plan');
}

function auditFile(): string {
  return path.join(actionPlanDir(), 'audit.jsonl');
}

/** JSON with keys sorted recursively, so the hash does not depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const parts = Object.keys(o).sort().filter(k => o[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function chainHash(prevHash: string, body: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(prevHash + canonicalJson(body)).digest('hex');
}

function lastHash(file: string): string {
  if (!fs.existsSync(file)) return '0';
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  if (!lines.length) return '0';
  return String(JSON.parse(lines[lines.length - 1]).hash);
}

/** Never throws — a full disk or unwritable dir must not block an approval flow. Sync, so appends are serialized in-process. */
export function appendActionAudit(entry: Record<string, unknown>, at: Date = new Date()): void {
  try {
    const file = auditFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prevHash = lastHash(file);
    const body = { ...entry, at: at.toISOString(), prevHash };
    fs.appendFileSync(file, JSON.stringify({ ...body, hash: chainHash(prevHash, body) }) + '\n');
  } catch (e) {
    console.warn(`[action-plan] audit write failed (${e instanceof Error ? e.name : 'Error'})`);
  }
}

export function verifyAuditChain(file: string = auditFile()): { ok: true; lines: number } | { ok: false; brokenAt: number } {
  if (!fs.existsSync(file)) return { ok: true, lines: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  let prev = '0';
  for (let i = 0; i < lines.length; i++) {
    try {
      const { hash, ...body } = JSON.parse(lines[i]) as Record<string, unknown>;
      if (body.prevHash !== prev || hash !== chainHash(prev, body)) return { ok: false, brokenAt: i + 1 };
      prev = String(hash);
    } catch {
      return { ok: false, brokenAt: i + 1 };
    }
  }
  return { ok: true, lines: lines.length };
}

/** Spec §3.10 fields only (explicit picks, so nothing credential-like can leak in). CIDRs stay as planned. */
export function auditEntryFor(req: ActionRequest): Record<string, unknown> {
  return {
    id: req.id,
    status: req.status,
    prompt: req.prompt.slice(0, 1000),
    plannerRaw: req.plannerRaw,
    summary: req.summary,
    changes: req.changes,
    policy: req.policy,
    permission: req.permission,
    requesterId: req.requesterId,
    deciderId: req.deciderId,
    channel: req.channel,
    threadTs: req.threadTs,
    result: req.result,
    results: req.results,
    undoOf: req.undoOf,
    skippedForDrift: req.skippedForDrift,
  };
}
