import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendActionAudit, auditEntryFor, verifyAuditChain } from '../audit';
import type { ActionRequest } from '../types';

let dir: string;
const file = () => path.join(dir, 'audit.jsonl');
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-audit-')); process.env.ACTION_PLAN_DATA_DIR = dir; });
afterEach(() => { delete process.env.ACTION_PLAN_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

function seed() { for (let i = 0; i < 4; i++) appendActionAudit({ n: i, nested: { b: 1, a: [i] } }, new Date(1000 + i)); }
const lines = () => fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean);

describe('audit chain', () => {
  it('chainVerifiesAndDetectsEditedDeletedOrReorderedLines', () => {
    seed();
    expect(verifyAuditChain()).toEqual({ ok: true, lines: 4 });
    expect(JSON.parse(lines()[0]).prevHash).toBe('0');

    const orig = lines();
    const write = (l: string[]) => fs.writeFileSync(file(), l.join('\n') + '\n');

    write(orig.map((l, i) => (i === 1 ? l.replace('"n":1', '"n":9') : l)));
    expect(verifyAuditChain()).toEqual({ ok: false, brokenAt: 2 });

    write([orig[0], orig[2], orig[3]]);
    expect(verifyAuditChain()).toEqual({ ok: false, brokenAt: 2 });

    write([orig[0], orig[2], orig[1], orig[3]]);
    expect(verifyAuditChain()).toEqual({ ok: false, brokenAt: 2 });

    write(orig.slice(0, 3)); // truncating the tail is undetectable by a chain alone, but prefix stays valid
    expect(verifyAuditChain()).toEqual({ ok: true, lines: 3 });
    write(['not json']);
    expect(verifyAuditChain()).toEqual({ ok: false, brokenAt: 1 });
  });

  it('auditNeverThrowsOnUnwritableDir', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    process.env.ACTION_PLAN_DATA_DIR = path.join(blocker, 'sub');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => appendActionAudit({ a: 1 })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('auditEntryFor caps prompt and picks only spec fields', () => {
    const req = {
      id: 'x', requesterId: 'U1', channel: 'C', threadTs: '1', status: 'pending', createdAt: 1,
      prompt: 'p'.repeat(2000), summary: 's', plannerRaw: { kind: 'plan' }, changes: [], snapshot: {},
      policy: { ok: true, denials: [] }, permission: { ok: true }, token: 'xoxb-secret',
    } as unknown as ActionRequest;
    const e = auditEntryFor(req);
    expect((e.prompt as string).length).toBe(1000);
    expect(JSON.stringify(e)).not.toContain('xoxb-secret');
    expect(e).not.toHaveProperty('snapshot');
  });
});
