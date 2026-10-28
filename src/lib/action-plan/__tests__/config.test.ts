import { describe, it, expect, vi, beforeEach } from 'vitest';

let config: Record<string, unknown> = {};
vi.mock('@/lib/app-config', () => ({ getConfig: () => config }));

import { getActionPlanConfig } from '../config';
import { createApprovalStore } from '@/lib/slack-control/requests';
import { getControlConfig } from '@/lib/slack-control/handle';
import type { ActionRequest } from '../types';

describe('getActionPlanConfig', () => {
  beforeEach(() => {
    config = { actionPlan: { enabled: true }, slackControl: { approverIds: ['UREQ', 'UAPP'], allowSelfApproval: true } };
  });

  it('neverAllowsSelfApprovalEvenWhenSlackControlDoes', () => {
    expect(getControlConfig()?.allowSelfApproval).toBe(true); // slack-control keeps its own behaviour
    const cfg = getActionPlanConfig()!;
    expect(cfg.approval.allowSelfApproval).toBe(false);
    expect(cfg.approval.approverIds).toEqual(['UREQ', 'UAPP']);

    // The shared store enforces it: the requester (also a listed approver) cannot give the final approval.
    const store = createApprovalStore<ActionRequest>();
    const req = store.create({ requesterId: 'UREQ', channel: 'C1', threadTs: '1.1' } as never);
    expect(store.confirm(req.id, 'UREQ', cfg.approval.ttlMs).ok).toBe(true);
    const self = store.beginApproval(req.id, 'UREQ', cfg.approval);
    expect(self.ok).toBe(false);
    expect(store.beginApproval(req.id, 'UAPP', cfg.approval).ok).toBe(true);
  });

  it('isNullWhenDisabledOrWithoutApprovers', () => {
    config = { actionPlan: { enabled: false }, slackControl: { approverIds: ['UAPP'] } };
    expect(getActionPlanConfig()).toBeNull();
    config = { actionPlan: { enabled: true }, slackControl: { approverIds: [] } };
    expect(getActionPlanConfig()).toBeNull();
  });
});
