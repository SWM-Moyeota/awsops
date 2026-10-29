// Shared time cap for promises / 프로미스 공용 시간 상한
function timeoutError(): Error { const e = new Error('Timeout'); e.name = 'Timeout'; return e; }

// Settle within capMs: reject with Timeout, leave the job running unawaited. / capMs 안에 끝나지 않으면 Timeout — 작업은 기다리지 않고 둔다.
export function withCap<T>(fn: () => Promise<T>, capMs: number): Promise<T> {
  const job = Promise.resolve().then(fn);
  job.catch(() => undefined); // late rejection after the cap is not unhandled / 상한 뒤 늦은 실패 처리
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), capMs);
    timer.unref?.();
  });
  return Promise.race([job, cap]).finally(() => clearTimeout(timer));
}
