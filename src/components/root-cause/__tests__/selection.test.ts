import { describe, it, expect } from 'vitest';
import { isForeign, isFresh, searchKeyAction, viewFor, type KeyState } from '../selection';

const base: KeyState = { open: true, count: 3, active: 0, fresh: true, onOption: false };

describe('searchKeyAction', () => {
  it('moves with arrows and wraps', () => {
    expect(searchKeyAction('ArrowDown', base)).toEqual({ type: 'move', index: 1 });
    expect(searchKeyAction('ArrowDown', { ...base, active: 2 })).toEqual({ type: 'move', index: 0 });
    expect(searchKeyAction('ArrowUp', base)).toEqual({ type: 'move', index: 2 });
  });
  it('picks the active result on Enter in the input when fresh', () => {
    expect(searchKeyAction('Enter', { ...base, active: 1 })).toEqual({ type: 'pick', index: 1 });
  });
  it('leaves Enter on a focused option to the button (Tab then Enter picks that option)', () => {
    expect(searchKeyAction('Enter', { ...base, active: 0, onOption: true })).toBeNull();
  });
  it('ignores Enter while results are stale (typed ahead of the debounce or still loading)', () => {
    expect(searchKeyAction('Enter', { ...base, fresh: false })).toBeNull();
  });
  it('clamps a stale active index', () => {
    expect(searchKeyAction('Enter', { ...base, count: 2, active: 5 })).toEqual({ type: 'pick', index: 1 });
  });
  it('closes on Escape and ignores keys with no results', () => {
    expect(searchKeyAction('Escape', { ...base, open: false })).toEqual({ type: 'close' });
    expect(searchKeyAction('Enter', { ...base, count: 0 })).toBeNull();
    expect(searchKeyAction('ArrowDown', { ...base, open: false })).toBeNull();
    expect(searchKeyAction('a', base)).toBeNull();
  });
});

describe('isFresh', () => {
  const p = { text: 'web', q: 'web', dataQ: 'web', loading: false, maxQ: 100 };
  it('is fresh only when text, query and loaded query agree and nothing loads', () => {
    expect(isFresh(p)).toBe(true);
    expect(isFresh({ ...p, text: ' web ' })).toBe(true);
    expect(isFresh({ ...p, text: 'web-2' })).toBe(false); // debounce pending / 디바운스 대기
    expect(isFresh({ ...p, dataQ: 'we' })).toBe(false); // results from the previous query / 이전 검색어 결과
    expect(isFresh({ ...p, loading: true })).toBe(false);
    expect(isFresh({ ...p, text: '', q: '', dataQ: '' })).toBe(false);
  });
  it('compares against the truncated text', () => {
    const long = 'x'.repeat(120);
    expect(isFresh({ ...p, text: long, q: 'x'.repeat(100), dataQ: 'x'.repeat(100) })).toBe(true);
  });
});

describe('viewFor', () => {
  it('hides data stored for another key and reports loading', () => {
    expect(viewFor({ data: 'old', loading: false, key: 'rc-a' }, 'rc-b')).toEqual({ data: null, loading: true, stale: true });
  });
  it('returns data for the same key', () => {
    expect(viewFor({ data: 'x', loading: true, key: 'rc-a' }, 'rc-a')).toEqual({ data: 'x', loading: true, stale: false });
  });
  it('is idle without a key', () => {
    expect(viewFor({ data: 'x', loading: false, key: 'rc-a' }, null)).toEqual({ data: null, loading: false, stale: false });
  });
});

describe('isForeign', () => {
  it('flags incidents outside a scoped account only', () => {
    expect(isForeign('111111111111', '222222222222')).toBe(true);
    expect(isForeign('111111111111', '111111111111')).toBe(false);
    expect(isForeign('111111111111', '__all__')).toBe(false);
  });
});
