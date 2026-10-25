// Slack approval-gated EC2 control — shared types.
// Slack 승인 기반 EC2 제어 공용 타입.

export type ControlAction = 'start' | 'stop' | 'reboot';

export interface ControllableInstance {
  id: string;
  name: string;
  state: string;
}

/**
 * proposed  → requester confirms the target (step 1) → pending
 * pending   → another approver approves (step 2)    → executing → executed | failed
 * proposed/pending can also end as cancelled, rejected or expired.
 */
export type RequestStatus =
  | 'proposed' | 'pending' | 'executing' | 'executed' | 'failed' | 'cancelled' | 'rejected' | 'expired';

export interface ControlRequest {
  id: string;
  action: ControlAction;
  instance: ControllableInstance;
  requesterId: string;
  channel: string;
  threadTs: string;
  cardTs?: string;
  status: RequestStatus;
  createdAt: number;
  confirmedAt?: number;
  /** Who approved, rejected or cancelled. */
  deciderId?: string;
  decidedAt?: number;
  /** Execution outcome, e.g. "running → stopping" or an error code. */
  result?: string;
}

export interface ControlConfig {
  approverIds: string[];
  allowSelfApproval: boolean;
  ttlMs: number;
}
