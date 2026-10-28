import { describe, it, expect } from 'vitest';
import { undoSteps, checkUndo, isUndoAvailable } from '../undo';
import type { ExecutionRecord, ResolvedStep, Snapshot, StepResult } from '../types';

const inst = { type: 'instance' as const, id: 'i-1', name: 'web' };
const sg = { type: 'security-group' as const, id: 'sg-1', name: 'web-sg' };
const rule = { protocol: 'tcp' as const, fromPort: 22, toPort: 22, source: '10.0.0.0/8' };

const startInv: ResolvedStep = { action: 'ec2.start', target: inst };
const tagInv: ResolvedStep = { action: 'tag.set', target: inst, key: 'env', value: 'dev' };
const ruleInv: ResolvedStep = { action: 'sg.ingress.remove', target: sg, ruleId: 'sgr-9' };

function rec(results: StepResult[], executedAt = '2026-10-28T00:00:00Z'): ExecutionRecord {
  return { id: 'e1', executedAt, requesterId: 'U1', approverId: 'U2', channel: 'C', threadTs: '1', results };
}

const results: StepResult[] = [
  { index: 0, status: 'done', inverse: startInv, after: { kind: 'instance-state', id: 'i-1', states: ['stopping', 'stopped'] } },
  { index: 1, status: 'done', inverse: tagInv, after: { kind: 'tag', id: 'i-1', key: 'env', value: 'prod' } },
  { index: 2, status: 'done', inverse: ruleInv, after: { kind: 'rule-present', sgId: 'sg-1', ruleId: 'sgr-9' } },
  { index: 3, status: 'failed', error: 'X' },
  { index: 4, status: 'not-run' },
];

const okSnap = (): Snapshot => ({
  'i-1': { ...inst, tags: { env: 'prod' }, state: 'stopped' },
  'sg-1': { ...sg, tags: {}, ingress: [{ ...rule, ruleId: 'sgr-9' }] },
});

describe('undo', () => {
  it('undoReversesOrderAndUsesInverses', () => {
    expect(undoSteps(rec(results))).toEqual([ruleInv, tagInv, startInv]);
    expect(checkUndo(rec(results), okSnap())).toEqual({ steps: [ruleInv, tagInv, startInv], skipped: [] });
  });

  it('undoSkipsStepsWhoseStateChangedSince', () => {
    const snap = okSnap();
    snap['i-1'] = { ...snap['i-1'], tags: { env: 'staging' }, state: 'running' };
    snap['sg-1'] = { ...snap['sg-1'], ingress: [] };
    const out = checkUndo(rec(results), snap);
    expect(out.steps).toEqual([]);
    expect(out.skipped).toHaveLength(3);
    expect(out.skipped.every(s => s.startsWith('그 사이 다른 변경이 있어서 되돌리지 않아요'))).toBe(true);

    const onlyTag = okSnap();
    onlyTag['i-1'] = { ...onlyTag['i-1'], tags: {} };
    expect(checkUndo(rec(results), onlyTag).steps).toEqual([ruleInv, startInv]);
    const onlyState = okSnap();
    onlyState['i-1'] = { ...onlyState['i-1'], state: 'running' };
    expect(checkUndo(rec(results), onlyState).steps).toEqual([ruleInv, tagInv]);
    const onlyRule = okSnap();
    onlyRule['sg-1'] = { ...onlyRule['sg-1'], ingress: [] };
    expect(checkUndo(rec(results), onlyRule).steps).toEqual([tagInv, startInv]);
  });

  it('checks tag removal (null) and rule-absent', () => {
    const addInv: ResolvedStep = { action: 'sg.ingress.add', target: sg, rule };
    const removeInv: ResolvedStep = { action: 'tag.set', target: inst, key: 'k', value: 'v' };
    const r = rec([
      { index: 0, status: 'done', inverse: addInv, after: { kind: 'rule-absent', sgId: 'sg-1', rule } },
      { index: 1, status: 'done', inverse: removeInv, after: { kind: 'tag', id: 'i-1', key: 'k', value: null } },
    ]);
    const snap: Snapshot = { 'i-1': { ...inst, tags: {} }, 'sg-1': { ...sg, tags: {}, ingress: [] } };
    expect(checkUndo(r, snap).steps).toEqual([removeInv, addInv]);
    snap['sg-1'].ingress = [{ ...rule, ruleId: 'sgr-x' }];
    snap['i-1'].tags = { k: 'z' };
    expect(checkUndo(r, snap).steps).toEqual([]);
  });

  it('undoExpiresAfterUndoHours', () => {
    const r = rec(results, '2026-10-28T00:00:00Z');
    expect(isUndoAvailable(r, 24, new Date('2026-10-28T23:59:00Z'))).toBe(true);
    expect(isUndoAvailable(r, 24, new Date('2026-10-29T00:01:00Z'))).toBe(false);
    expect(isUndoAvailable(rec([{ index: 0, status: 'failed' }]), 24, new Date('2026-10-28T01:00:00Z'))).toBe(false);
  });
});
