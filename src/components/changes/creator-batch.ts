// 배치/중복 요청 방지용 순수 함수 (useCreators에서 사용).
export const CLIENT_BATCH = 50;

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Unique, non-empty keys not yet requested.
export function pendingKeys(keys: string[], asked: Set<string>): string[] {
  return Array.from(new Set(keys)).filter((k) => k && !asked.has(k));
}
