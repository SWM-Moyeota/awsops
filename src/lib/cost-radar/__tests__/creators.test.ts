import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ctSend = vi.fn();
const ctCtor = vi.fn();
const stsSend = vi.fn();
vi.mock('@aws-sdk/client-cloudtrail', () => ({
  CloudTrailClient: class { constructor(c: unknown) { ctCtor(c); } send = ctSend; },
  LookupEventsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class { send = stsSend; },
  AssumeRoleCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@/lib/app-config', () => ({
  getConfig: () => ({
    crossAccountExternalId: 'ext-1',
    accounts: [{ accountId: '111', isHost: true }, { accountId: '222', isHost: false }],
  }),
}));

import { lookupCreators, resetCreatorState } from '../creators';

let dir: string;
const NOW = new Date('2026-10-24T00:00:00Z');
const ev = (t: string, user = 'alice') => ({ EventName: 'RunInstances', EventTime: new Date(t), Username: user });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'));
  process.env.COST_RADAR_DATA_DIR = dir;
  ctSend.mockReset(); ctCtor.mockReset(); stsSend.mockReset(); resetCreatorState();
});
afterEach(() => { vi.useRealTimers(); delete process.env.COST_RADAR_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

const item = (id: string, accountId = '111') => ({ resourceId: id, accountId, region: 'ap-northeast-2' });

describe('creators', () => {
  it('picks the earliest create event', async () => {
    ctSend.mockResolvedValue({ Events: [ev('2026-10-02T00:00:00Z', 'late'), ev('2026-10-01T00:00:00Z', 'early')] });
    const [r] = await lookupCreators([item('i-1')], { now: NOW });
    expect(r).toEqual({ resourceId: 'i-1', user: 'early', eventTime: '2026-10-01T00:00:00.000Z', status: 'found' });
  });

  it('foundCreatorIsCachedForever', async () => {
    ctSend.mockResolvedValue({ Events: [ev('2026-10-01T00:00:00Z')] });
    await lookupCreators([item('i-1')], { now: NOW });
    ctSend.mockClear();
    const [r] = await lookupCreators([item('i-1')], { now: new Date('2027-10-24T00:00:00Z') });
    expect(ctSend).not.toHaveBeenCalled();
    expect(r.status).toBe('found');
  });

  it('throttledLookupBecomesUnknownAndIsRetriedLater', async () => {
    const err = Object.assign(new Error('slow'), { name: 'ThrottlingException' });
    ctSend.mockRejectedValue(err);
    const [r] = await lookupCreators([item('i-1')], { now: NOW });
    expect(r).toEqual({ resourceId: 'i-1', user: null, eventTime: null, status: 'unknown' });
    ctSend.mockClear();
    await lookupCreators([item('i-1')], { now: new Date(NOW.getTime() + 3600_000) });
    expect(ctSend).not.toHaveBeenCalled();
  });

  it('unknownIsRetriedAfter24h', async () => {
    ctSend.mockResolvedValueOnce({ Events: [] });
    const [a] = await lookupCreators([item('i-1')], { now: NOW });
    expect(a.status).toBe('unknown');
    ctSend.mockResolvedValueOnce({ Events: [ev('2026-10-01T00:00:00Z')] });
    const [b] = await lookupCreators([item('i-1')], { now: new Date(NOW.getTime() + 25 * 3600_000) });
    expect(b.status).toBe('found');
  });

  it('falls back to userIdentity arn tail', async () => {
    ctSend.mockResolvedValue({ Events: [{ EventName: 'CreateVolume', EventTime: new Date('2026-10-01T00:00:00Z'),
      CloudTrailEvent: JSON.stringify({ userIdentity: { arn: 'arn:aws:sts::1:assumed-role/Admin/bob' } }) }] });
    const [r] = await lookupCreators([item('vol-1')], { now: NOW });
    expect(r.user).toBe('bob');
  });

  it('targetAccountAssumesRoleWithExternalId', async () => {
    stsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 900_000) } });
    ctSend.mockResolvedValue({ Events: [ev('2026-10-01T00:00:00Z')] });
    await lookupCreators([item('i-9', '222')], { now: NOW });
    const input = (stsSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({ RoleArn: 'arn:aws:iam::222:role/AWSopsReadOnlyRole', ExternalId: 'ext-1', DurationSeconds: 900 });
    expect(ctCtor.mock.calls[0][0]).toMatchObject({ region: 'ap-northeast-2', credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' } });
  });

  it('AssumeRole failure becomes unknown', async () => {
    stsSend.mockRejectedValue(Object.assign(new Error('x'), { name: 'AccessDenied' }));
    const [r] = await lookupCreators([item('i-9', '222')], { now: NOW });
    expect(r.status).toBe('unknown');
    expect(ctSend).not.toHaveBeenCalled();
  });

  it('callsArePacedOnePerSecondPerAccount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const times: number[] = [];
    ctSend.mockImplementation(async () => { times.push(Date.now()); return { Events: [] }; });
    const p = lookupCreators([item('a'), item('b'), item('c')], { now: NOW });
    const settle = async (n: number) => { while (times.length < n || vi.getTimerCount() === 0) { if (times.length >= 3) return; await new Promise((r) => setImmediate(r)); } };
    for (let n = 1; n <= 2; n++) {
      await settle(n); // real file IO finishes; the pace timer is pending
      await vi.advanceTimersByTimeAsync(999);
      expect(times).toHaveLength(n);
      await vi.advanceTimersByTimeAsync(1);
    }
    await p;
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
    expect(times[2] - times[0]).toBeGreaterThanOrEqual(2000);
  });

  it('cache write failure does not throw', async () => {
    process.env.COST_RADAR_DATA_DIR = path.join(dir, 'file-not-dir', 'x');
    fs.writeFileSync(path.join(dir, 'file-not-dir'), 'x');
    ctSend.mockResolvedValue({ Events: [ev('2026-10-01T00:00:00Z')] });
    const [r] = await lookupCreators([item('i-1')], { now: NOW });
    expect(r.status).toBe('found');
  });

  it('concurrent calls for the same id make one SDK call', async () => {
    ctSend.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 20)); return { Events: [ev('2026-10-01T00:00:00Z')] }; });
    const [a, b] = await Promise.all([lookupCreators([item('i-1')], { now: NOW }), lookupCreators([item('i-1')], { now: NOW })]);
    expect(ctSend).toHaveBeenCalledTimes(1);
    expect(a[0].status).toBe('found');
    expect(b[0]).toEqual(a[0]);
  });

  it('concurrent calls do not lose or downgrade cache entries', async () => {
    ctSend.mockImplementation(async (cmd: { input: { LookupAttributes: { AttributeValue: string }[] } }) => {
      const id = cmd.input.LookupAttributes[0].AttributeValue;
      await new Promise((r) => setTimeout(r, id === 'i-a' ? 5 : 30));
      if (id === 'i-b') throw Object.assign(new Error('t'), { name: 'ThrottlingException' });
      return { Events: [ev('2026-10-01T00:00:00Z')] };
    });
    await Promise.all([
      lookupCreators([item('i-a')], { now: NOW }),
      lookupCreators([item('i-b')], { now: NOW }),
    ]);
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'creators.json'), 'utf8'));
    expect(file['111:i-a'].status).toBe('found');
    expect(file['111:i-b'].status).toBe('unknown');
    // a late 'unknown' must never replace an existing 'found'
    fs.writeFileSync(path.join(dir, 'creators.json'), JSON.stringify({ ...file, '111:i-b': { ...file['111:i-a'], resourceId: 'i-b' } }));
    ctSend.mockRejectedValue(Object.assign(new Error('t'), { name: 'ThrottlingException' }));
    await lookupCreators([item('i-b')], { now: new Date(NOW.getTime() + 48 * 3600_000) });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'creators.json'), 'utf8'))['111:i-b'].status).toBe('found');
  });

  it('pacing holds across concurrent calls on one account', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const times: number[] = [];
    ctSend.mockImplementation(async () => { times.push(Date.now()); return { Events: [] }; });
    const p = Promise.all([lookupCreators([item('a')], { now: NOW }), lookupCreators([item('b')], { now: NOW })]);
    while (times.length < 1) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
  });

  it('credentials are re-fetched after expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    stsSend.mockImplementation(async () => ({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 900_000) } }));
    ctSend.mockResolvedValue({ Events: [] });
    await lookupCreators([item('x1', '222')], { now: NOW });
    expect(stsSend).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 850_000); // inside the 1-minute refresh margin
    await lookupCreators([item('x2', '222')], { now: NOW });
    expect(stsSend).toHaveBeenCalledTimes(2);
  });
});
