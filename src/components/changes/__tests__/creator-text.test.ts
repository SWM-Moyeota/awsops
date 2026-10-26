import { describe, it, expect } from 'vitest';
import { creatorText } from '../creator-text';
import type { CreatorLookup } from '@/lib/change-timeline/types';

describe('creatorText', () => {
  it('creatorTextFound', () => {
    const l: CreatorLookup = { key: '1:b', status: 'found', actor: { kind: 'person', name: 'sungyoon' }, time: '2026-10-26T03:00:00Z', tool: 'console' };
    expect(creatorText(l)).toBe('sungyoon님이 만들었어요 · 10월 26일 · 콘솔');
  });
  it('creatorTextFoundAuto', () => {
    const l: CreatorLookup = { key: '1:b', status: 'found', actor: { kind: 'auto', name: 'asg' }, time: '2026-09-02T03:00:00Z', tool: 'terraform' };
    expect(creatorText(l)).toBe('asg이(가) 만들었어요 · 9월 2일 · Terraform');
  });
  it('creatorTextTooOld', () => {
    expect(creatorText({ key: 'k', status: 'too-old' })).toBe('90일보다 오래돼서 기록이 없어요');
  });
  it('creatorTextNone', () => {
    expect(creatorText({ key: 'k', status: 'none' })).toBe('기록 없음');
    expect(creatorText(undefined)).toBe('');
  });
  it('creatorTextDeleted', () => {
    const l: CreatorLookup = { key: '1:b', status: 'found', actor: { kind: 'person', name: 'jiwoo' }, time: '2026-09-02T03:00:00Z', tool: 'cli', deletedAt: '2026-10-01T03:00:00Z' };
    expect(creatorText(l)).toBe('jiwoo님이 만들었어요 · 9월 2일 · CLI · 10월 1일 삭제됨');
  });
  it('creatorTextVia', () => {
    const l: CreatorLookup = { key: '1:b', status: 'found', actor: { kind: 'person', name: 'a' }, time: '2026-09-02T03:00:00Z', tool: 'sdk', via: 'Lambda' };
    expect(creatorText(l)).toBe('a님이 만들었어요 · 9월 2일 · Lambda 통해');
  });
});
