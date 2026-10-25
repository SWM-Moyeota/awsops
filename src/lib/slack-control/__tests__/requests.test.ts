import { describe, it, expect } from 'vitest';
import { createRequestStore } from '../requests';
import type { ControlConfig } from '../types';

const cfg: ControlConfig = { approverIds: ['UBOSS', 'UALICE'], allowSelfApproval: false, ttlMs: 15 * 60_000 };
const instance = { id: 'i-0aaa1111bbbb2222c', name: 'k8s-practice', state: 'running' };

function setup() {
  let t = 1_000_000;
  const store = createRequestStore({ now: () => t });
  const req = store.create({ action: 'stop', instance, requesterId: 'UALICE', channel: 'C1', threadTs: '1.0' });
  return { store, req, advance: (ms: number) => { t += ms; } };
}

describe('request store — two-step approval', () => {
  it('startsProposedWithUniqueId', () => {
    const { store, req } = setup();
    const other = store.create({ action: 'start', instance, requesterId: 'UBOB', channel: 'C1', threadTs: '2.0' });
    expect(req.status).toBe('proposed');
    expect(req.id).not.toBe(other.id);
    expect(store.get(req.id)?.status).toBe('proposed');
  });

  it('step1OnlyRequesterCanConfirm', () => {
    const { store, req } = setup();
    expect(store.confirm(req.id, 'UBOSS').ok).toBe(false);
    const r = store.confirm(req.id, 'UALICE');
    expect(r.ok).toBe(true);
    expect(store.get(req.id)?.status).toBe('pending');
  });

  it('step2RequiresApproverOtherThanRequester', () => {
    const { store, req } = setup();
    store.confirm(req.id, 'UALICE');
    const self = store.beginApproval(req.id, 'UALICE', cfg);
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.reason).toContain('본인');
    expect(store.beginApproval(req.id, 'URANDOM', cfg).ok).toBe(false);
    const ok = store.beginApproval(req.id, 'UBOSS', cfg);
    expect(ok.ok).toBe(true);
    expect(store.get(req.id)).toMatchObject({ status: 'executing', deciderId: 'UBOSS' });
  });

  it('allowsSelfApprovalOnlyWhenConfigured', () => {
    const { store, req } = setup();
    store.confirm(req.id, 'UALICE');
    expect(store.beginApproval(req.id, 'UALICE', { ...cfg, allowSelfApproval: true }).ok).toBe(true);
  });

  it('cannotApproveBeforeStep1', () => {
    const { store, req } = setup();
    expect(store.beginApproval(req.id, 'UBOSS', cfg).ok).toBe(false);
  });

  it('executesOnlyOnce', () => {
    const { store, req } = setup();
    store.confirm(req.id, 'UALICE');
    expect(store.beginApproval(req.id, 'UBOSS', cfg).ok).toBe(true);
    expect(store.beginApproval(req.id, 'UBOSS', cfg).ok).toBe(false);
    store.finish(req.id, 'executed', 'running → stopping');
    expect(store.beginApproval(req.id, 'UBOSS', cfg).ok).toBe(false);
    expect(store.get(req.id)).toMatchObject({ status: 'executed', result: 'running → stopping' });
  });

  it('expiresAfterTtl', () => {
    const { store, req, advance } = setup();
    store.confirm(req.id, 'UALICE');
    advance(cfg.ttlMs + 1);
    const r = store.beginApproval(req.id, 'UBOSS', cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('만료');
    expect(store.get(req.id)?.status).toBe('expired');
  });

  it('expiresBeforeConfirmToo', () => {
    const { store, req, advance } = setup();
    advance(cfg.ttlMs + 1);
    expect(store.confirm(req.id, 'UALICE', cfg.ttlMs).ok).toBe(false);
  });

  it('rejectByApproverAndCancelByRequester', () => {
    const a = setup();
    a.store.confirm(a.req.id, 'UALICE');
    expect(a.store.reject(a.req.id, 'URANDOM', cfg).ok).toBe(false);
    expect(a.store.reject(a.req.id, 'UBOSS', cfg).ok).toBe(true);
    expect(a.store.get(a.req.id)?.status).toBe('rejected');

    const b = setup();
    expect(b.store.cancel(b.req.id, 'UBOSS', cfg).ok).toBe(false);
    expect(b.store.cancel(b.req.id, 'UALICE', cfg).ok).toBe(true);
    expect(b.store.get(b.req.id)?.status).toBe('cancelled');
    expect(b.store.confirm(b.req.id, 'UALICE').ok).toBe(false);
  });

  it('unknownIdIsRejected', () => {
    const { store } = setup();
    expect(store.confirm('nope', 'UALICE').ok).toBe(false);
  });

  it('evictsOnlyFinishedRequestsWhenFull', () => {
    const { store, req } = setup();
    store.confirm(req.id, 'UALICE');
    store.beginApproval(req.id, 'UBOSS', cfg);          // executing — must survive
    for (let i = 0; i < 205; i += 1) {
      const r = store.create({ action: 'stop', instance, requesterId: 'USPAM', channel: 'C1', threadTs: `${i}` });
      store.cancel(r.id, 'USPAM', cfg);
    }
    expect(store.get(req.id)?.status).toBe('executing');
  });
});
