// Tests for CloudTrail write-event parsing. / CloudTrail 쓰기 이벤트 파싱 시험.
import { describe, it, expect } from 'vitest';
import { NOISE_EVENTS, toWriteEvent, extractRefs, sanitizeParams } from '../events';

const base = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventID: 'e1', eventTime: '2026-10-29T05:00:00Z', eventName: 'RevokeSecurityGroupIngress',
  eventSource: 'ec2.amazonaws.com', awsRegion: 'ap-northeast-2', sourceIPAddress: '203.0.113.9',
  userAgent: 'aws-cli/2.15 secret-ua-string',
  userIdentity: { type: 'IAMUser', userName: 'kim', accessKeyId: 'AKIAEXAMPLE' },
  requestParameters: { groupId: 'sg-1' }, ...o,
});

describe('NOISE_EVENTS', () => {
  it('has the spec list', () => {
    expect(NOISE_EVENTS.size).toBe(22);
    expect(NOISE_EVENTS.has('SendCommand')).toBe(true);
    expect(NOISE_EVENTS.has('Encrypt')).toBe(true);
  });
});

describe('toWriteEvent', () => {
  it('drops noise, failures, read-only, incomplete and non-objects', () => {
    expect(toWriteEvent(base({ eventName: 'PutLogEvents' }), 'a')).toBeNull();
    expect(toWriteEvent(base({ errorCode: 'AccessDenied' }), 'a')).toBeNull();
    expect(toWriteEvent(base({ readOnly: true }), 'a')).toBeNull();
    expect(toWriteEvent(base({ eventID: undefined }), 'a')).toBeNull();
    expect(toWriteEvent(base({ eventTime: undefined }), 'a')).toBeNull();
    expect(toWriteEvent(null, 'a')).toBeNull();
    expect(toWriteEvent('x', 'a')).toBeNull();
  });
  it('maps fields and never leaks IP or user agent', () => {
    const e = toWriteEvent(base(), '111')!;
    expect(e.eventId).toBe('e1');
    expect(e.time).toBe('2026-10-29T05:00:00.000Z');
    expect(e.region).toBe('ap-northeast-2');
    expect(e.accountId).toBe('111');
    expect(e.actor).toEqual({ kind: 'person', name: 'kim' });
    expect(e.tool).toBe('cli');
    expect(e.refs).toEqual([{ type: 'sg', id: 'sg-1' }]);
    const all = JSON.stringify(e);
    expect(all).not.toContain('203.0.113.9');
    expect(all).not.toContain('secret-ua-string');
    expect(all).not.toContain('AKIAEXAMPLE');
  });
  it('strips Lambda API-version suffixes from eventName', () => {
    expect(toWriteEvent(base({ eventName: 'UpdateFunctionConfiguration20150331v2' }), 'a')!.eventName).toBe('UpdateFunctionConfiguration');
    expect(toWriteEvent(base({ eventName: 'TagResource20170331v2' }), 'a')!.eventName).toBe('TagResource');
    expect(toWriteEvent(base({ eventName: 'AddPermission20150331' }), 'a')!.eventName).toBe('AddPermission');
  });
});

describe('extractRefs', () => {
  it('finds instances and eni + sg refs at depth', () => {
    expect(extractRefs({ requestParameters: { instancesSet: { items: [{ instanceId: 'i-1' }, { instanceId: 'i-2' }] } } }))
      .toEqual([{ type: 'instance', id: 'i-1' }, { type: 'instance', id: 'i-2' }]);
    expect(extractRefs({ requestParameters: { networkInterfaceId: 'eni-1', groupSet: { items: [{ groupId: 'sg-9' }] } } }))
      .toEqual([{ type: 'eni', id: 'eni-1' }, { type: 'sg', id: 'sg-9' }]);
  });
  it('keeps only sg- values in securityGroups', () => {
    expect(extractRefs({ requestParameters: { securityGroups: ['sg-1', 'web'] } })).toEqual([{ type: 'sg', id: 'sg-1' }]);
  });
  it('maps listener/rule ARNs to the load balancer and target groups', () => {
    const lb = { type: 'lb', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:111:loadbalancer/app/mo/abc' };
    expect(extractRefs({ requestParameters: { listenerArn: 'arn:aws:elasticloadbalancing:ap-northeast-2:111:listener/app/mo/abc/def' } })).toEqual([lb]);
    expect(extractRefs({ requestParameters: { ruleArn: 'arn:aws:elasticloadbalancing:ap-northeast-2:111:listener-rule/app/mo/abc/def/ghi' } })).toEqual([lb]);
    const tg = 'arn:aws:elasticloadbalancing:ap-northeast-2:111:targetgroup/t/1';
    expect(extractRefs({ requestParameters: { targetGroupArn: tg } })).toEqual([{ type: 'tg', arn: tg }]);
  });
  it('handles lambda name and ARN, roles, buckets', () => {
    expect(extractRefs({ requestParameters: { functionName: 'f' } })).toEqual([{ type: 'lambda', id: 'f' }]);
    const arn = 'arn:aws:lambda:ap-northeast-2:111:function:f';
    expect(extractRefs({ requestParameters: { functionName: arn } })).toEqual([{ type: 'lambda', id: 'f', arn }]);
    expect(extractRefs({ requestParameters: { roleName: 'r' } })).toEqual([{ type: 'role', id: 'r' }]);
    const ra = 'arn:aws:iam::111:role/path/r2';
    expect(extractRefs({ requestParameters: { roleArn: ra } })).toEqual([{ type: 'role', id: 'r2', arn: ra }]);
    expect(extractRefs({ requestParameters: { bucketName: 'b' } })).toEqual([{ type: 's3', id: 'b' }]);
  });
  it('uses cloudfront id only for the cloudfront source', () => {
    expect(extractRefs({ eventSource: 'cloudfront.amazonaws.com', requestParameters: { id: 'E1' } })).toEqual([{ type: 'cloudfront', id: 'E1' }]);
    expect(extractRefs({ eventSource: 'cloudfront.amazonaws.com', requestParameters: { distributionId: 'E2' } })).toEqual([{ type: 'cloudfront', id: 'E2' }]);
    expect(extractRefs({ eventSource: 'ec2.amazonaws.com', requestParameters: { id: 'E1' } })).toEqual([]);
  });
  it('takes resources[].ARN and dedupes', () => {
    const r = extractRefs({ requestParameters: { groupId: 'sg-1' }, responseElements: { groupId: 'sg-1' }, resources: [{ ARN: 'arn:aws:x:::y' }, { ARN: 'arn:aws:x:::y' }] });
    expect(r).toEqual([{ type: 'sg', id: 'sg-1' }, { type: null, arn: 'arn:aws:x:::y' }]);
  });
});

describe('sanitizeParams', () => {
  it('hides secret-like values at any depth', () => {
    const s = sanitizeParams({ masterUserPassword: 'x', nested: { SessionToken: 'y' }, ok: 'z' });
    expect(s).not.toContain('"x"');
    expect(s).not.toContain('"y"');
    expect(JSON.parse(s)).toEqual({ masterUserPassword: '[숨김]', nested: { SessionToken: '[숨김]' }, ok: 'z' });
  });
  it('hides access key IDs by key and by value', () => {
    const ev = toWriteEvent(base({ eventName: 'DeleteAccessKey', eventSource: 'iam.amazonaws.com', requestParameters: { userName: 'kim', accessKeyId: 'AKIAABCDEFGHIJKLMNOP' } }), 'a')!;
    expect(ev.params).not.toContain('AKIA');
    expect(JSON.parse(ev.params).accessKeyId).toBe('[숨김]');
    const s = sanitizeParams({ note: { list: ['ok', 'ASIAABCDEFGHIJKLMNOP'] } });
    expect(s).not.toContain('ASIA');
    expect(JSON.parse(s).note.list).toEqual(['ok', '[숨김]']);
  });
  it('caps at 600 chars with an ellipsis', () => {
    const s = sanitizeParams({ a: 'q'.repeat(2000) });
    expect(s.length).toBeLessThanOrEqual(600);
    expect(s.endsWith('…')).toBe(true);
  });
  it('returns empty for null/undefined', () => {
    expect(sanitizeParams(null)).toBe('');
    expect(sanitizeParams(undefined)).toBe('');
  });
});
