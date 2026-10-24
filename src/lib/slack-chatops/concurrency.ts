// Small concurrency helpers for the Slack bot — cap parallel AI calls, drop redelivered events.
// Slack 봇용 동시성 도우미 — AI 동시 호출 제한, 재전송된 이벤트 무시.

/** Returns `limit(fn)` that runs at most `max` fns at once; the rest wait in FIFO order. */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const run = waiting.shift();
    if (run) { active += 1; run(); }
  };
  return <T>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    waiting.push(() => {
      fn().then(resolve, reject).finally(() => { active -= 1; next(); });
    });
    next();
  });
}

/** Bounded set of recently seen ids; `addIfNew` is true only the first time an id is seen. */
export function createRecentSet(size: number): { addIfNew(id: string): boolean } {
  const seen = new Set<string>();
  return {
    addIfNew(id: string) {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > size) seen.delete(seen.values().next().value as string);
      return true;
    },
  };
}
