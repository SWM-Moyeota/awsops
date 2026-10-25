import { describe, it, expect } from 'vitest';
import { detectAction, parseControlRequest } from '../parse';
import type { ControllableInstance } from '../types';

const k8s: ControllableInstance = { id: 'i-0aaa1111bbbb2222c', name: 'k8s-practice', state: 'running' };
const api: ControllableInstance = { id: 'i-0ddd3333eeee4444f', name: 'api-dev', state: 'stopped' };
const apiTwo: ControllableInstance = { id: 'i-0fff5555aaaa6666b', name: 'api-dev-2', state: 'running' };

describe('detectAction', () => {
  it('readsKoreanAndEnglishCommands', () => {
    expect(detectAction('k8s-practice 꺼줘')).toBe('stop');
    expect(detectAction('k8s-practice 꺼 주세요')).toBe('stop');
    expect(detectAction('api-dev 정지해')).toBe('stop');
    expect(detectAction('api-dev 켜줘')).toBe('start');
    expect(detectAction('api-dev 시작해줘')).toBe('start');
    expect(detectAction('please stop api-dev')).toBe('stop');
    expect(detectAction('start api-dev')).toBe('start');
  });
  it('prefersRebootOverStartForRestart', () => {
    expect(detectAction('api-dev 재시작해줘')).toBe('reboot');
    expect(detectAction('api-dev 재부팅')).toBe('reboot');
    expect(detectAction('reboot api-dev')).toBe('reboot');
  });
  it('ignoresQuestionsAboutState', () => {
    expect(detectAction('지금 켜진 EC2 뭐 있어?')).toBeNull();
    expect(detectAction('k8s-practice 켜져 있어?')).toBeNull();
    expect(detectAction('꺼진 서버 알려줘')).toBeNull();
    expect(detectAction('비용 얼마나 나와?')).toBeNull();
  });
});

describe('parseControlRequest', () => {
  const all = [k8s, api, apiTwo];
  it('returnsNoneWithoutACommand', () => {
    expect(parseControlRequest('k8s-practice 상태 어때?', all)).toEqual({ kind: 'none' });
  });
  it('matchesByName', () => {
    expect(parseControlRequest('k8s-practice 꺼줘', all)).toEqual({ kind: 'request', action: 'stop', instance: k8s });
  });
  it('matchesByInstanceId', () => {
    expect(parseControlRequest('i-0ddd3333eeee4444f 켜줘', all)).toEqual({ kind: 'request', action: 'start', instance: api });
  });
  it('prefersExactNameOverPrefix', () => {
    expect(parseControlRequest('api-dev 켜줘', all)).toEqual({ kind: 'request', action: 'start', instance: api });
    expect(parseControlRequest('api-dev-2 꺼줘', all)).toEqual({ kind: 'request', action: 'stop', instance: apiTwo });
  });
  it('reportsAmbiguousWhenTwoNamesAppear', () => {
    const r = parseControlRequest('k8s-practice 랑 api-dev 꺼줘', all);
    expect(r.kind).toBe('ambiguous');
  });
  it('reportsNoTargetForUnknownServer', () => {
    expect(parseControlRequest('moyeota-backend-prod-a 꺼줘', all)).toEqual({ kind: 'no-target', action: 'stop' });
  });
});
