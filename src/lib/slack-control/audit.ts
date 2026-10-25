// Append-only audit log of every control request state change (data/slack-control/audit.jsonl).
// CloudTrail also records the approver through the assumed role's SourceIdentity.
// 모든 제어 요청 상태 변화를 추가 전용으로 기록. CloudTrail에도 SourceIdentity로 승인자가 남는다.
import fs from 'node:fs';
import path from 'node:path';
import type { ControlRequest } from './types';

function auditFile(): string {
  const dir = process.env.SLACK_CONTROL_DATA_DIR || path.join(process.cwd(), 'data', 'slack-control');
  return path.join(dir, 'audit.jsonl');
}

/** Never throws — a full disk must not block an approval flow. */
export function appendAudit(req: ControlRequest, at: Date = new Date()): void {
  try {
    const file = auditFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = {
      at: at.toISOString(), id: req.id, status: req.status, action: req.action,
      instanceId: req.instance.id, instanceName: req.instance.name,
      requester: req.requesterId, decider: req.deciderId, result: req.result, channel: req.channel,
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.warn(`[slack-control] audit write failed (${e instanceof Error ? e.name : 'Error'})`);
  }
}
