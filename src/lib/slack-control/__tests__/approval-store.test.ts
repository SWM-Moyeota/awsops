import { describe, it, expect } from 'vitest';
import { createApprovalStore } from '../requests';
import type { ApprovalRecord } from '../types';

type Custom = ApprovalRecord & { prompt: string };
const cfg = { approverIds: ['U_REQ', 'U_APP'], allowSelfApproval: false, ttlMs: 60_000 };

describe('createApprovalStore', () => {
  it('genericStoreRunsSameTwoStepRulesOnCustomPayload', () => {
    const store = createApprovalStore<Custom>();
    const r = store.create({ prompt: 'stop it', requesterId: 'U_REQ', channel: 'C1', threadTs: '1.1' });
    expect(r.prompt).toBe('stop it');
    expect(r.status).toBe('proposed');

    const before = store.beginApproval(r.id, 'U_REQ', cfg);
    expect(before.ok).toBe(false);
    expect(!before.ok && before.reason).toContain('요청한 본인은 최종 승인할 수 없어요');

    expect(store.confirm(r.id, 'U_REQ').ok).toBe(true);
    const after = store.beginApproval(r.id, 'U_REQ', cfg);
    expect(after.ok).toBe(false);
    expect(!after.ok && after.reason).toContain('요청한 본인은 최종 승인할 수 없어요');

    const ok = store.beginApproval(r.id, 'U_APP', cfg);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.req.prompt).toBe('stop it');
    expect(store.beginApproval(r.id, 'U_APP', cfg).ok).toBe(false);
  });
});
