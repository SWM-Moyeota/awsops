import { describe, it, expect } from 'vitest';
import { chunk, pendingKeys, CLIENT_BATCH } from '../creator-batch';
import { toIsoOrUndefined, creatorKey } from '../creator-text';

describe('creator-batch', () => {
  it('chunkSplitsIntoFifties', () => {
    const ids = Array.from({ length: 120 }, (_, i) => `k${i}`);
    expect(CLIENT_BATCH).toBe(50);
    expect(chunk(ids, CLIENT_BATCH).map((c) => c.length)).toEqual([50, 50, 20]);
  });
  it('pendingKeysSkipsAskedAndDuplicates', () => {
    expect(pendingKeys(['a', 'b', 'a', ''], new Set(['b']))).toEqual(['a']);
  });
  it('pendingKeysReturnsReleasedKeysAgain', () => {
    const asked = new Set(['a', 'b']);
    asked.delete('b');
    expect(pendingKeys(['a', 'b'], asked)).toEqual(['b']);
  });
});

describe('toIsoOrUndefined', () => {
  it('toIsoValid', () => expect(toIsoOrUndefined('2026-10-26T03:00:00Z')).toBe('2026-10-26T03:00:00.000Z'));
  it('toIsoInvalidDoesNotThrow', () => {
    expect(toIsoOrUndefined('garbage')).toBeUndefined();
    expect(toIsoOrUndefined(null)).toBeUndefined();
  });
  it('creatorKeyDropsBadDate', () => {
    expect(creatorKey('123456789012', 'b', 'nope')).toBe('123456789012:b');
    expect(creatorKey('123456789012', 'b', '2026-10-26T03:00:00Z')).toBe('123456789012:b|2026-10-26T03:00:00.000Z');
    expect(creatorKey(undefined, 'b')).toBeNull();
  });
});
