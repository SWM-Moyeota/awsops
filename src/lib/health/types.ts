// Health monitor types — shared by state machine, checks and Slack delivery.
// 헬스 모니터 공용 타입 — 상태 머신, 점검, Slack 전송에서 공유.

export type CheckId = 'steampipe' | 'bedrock' | 'agentcore-runtime' | 'agentcore-invoke' | 'lambda' | 'cross-account';
export type CheckStatus = 'ok' | 'fail' | 'unknown';

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  message: string;
}

export interface ItemState {
  status: CheckStatus;
  consecutiveFailures: number;
  lastChecked: string | null;
  message: string;
  /** ISO time of the last status change. */
  since: string | null;
}

export type HealthState = Record<CheckId, ItemState>;

export interface Transition {
  id: CheckId;
  from: CheckStatus;
  to: 'ok' | 'fail';
  message: string;
  at: string;
}

export const CHECK_IDS: CheckId[] = ['steampipe', 'bedrock', 'agentcore-runtime', 'agentcore-invoke', 'lambda', 'cross-account'];
