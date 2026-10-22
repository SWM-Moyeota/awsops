import { Pool, Client } from 'pg';
import { execFileSync } from 'child_process';
import NodeCache from 'node-cache';
import { getConfig, isMultiAccount, getAccounts, ALL_ACCOUNTS } from '@/lib/app-config';
import type { AccountConfig } from '@/lib/app-config';

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

function getSpPassword(): string {
  return getConfig().steampipePassword || process.env.STEAMPIPE_PASSWORD || 'steampipe';
}

// Steampipe 비밀번호: config에서 읽기, 환경변수 폴백
// Steampipe password: from config, env var fallback
function createPool(): Pool {
  return new Pool({
    host: '127.0.0.1',
    port: 9193,
    database: 'steampipe',
    user: 'steampipe',
    password: getSpPassword(),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    statement_timeout: 30000,
    // Postgres-side guard for idle-in-transaction backends (independent of FDW hangs)
    idle_in_transaction_session_timeout: 60000,
  });
}

let pool = createPool();

// Client-side hard timeout for a single query / 단일 쿼리에 대한 클라이언트 측 하드 타임아웃
// pool statement_timeout(30s)을 넘기는 쿼리는 거의 확실히 Steampipe FDW 행 → 40s에서 강제 회수
// statement_timeout(30s) is server-side; FDW network calls IGNORE it, so anything past ~40s is a hang.
const QUERY_HARD_TIMEOUT_MS = 40000;

// Acquire a pooled client, run sql with a client-side timeout, and ALWAYS free the pool slot.
// 풀 클라이언트를 얻어 클라이언트 측 타임아웃과 함께 실행하고, 어떤 경우에도 풀 슬롯을 회수.
// On timeout we release(err) to DESTROY the client — the FDW-hung server backend cannot be killed
// by pg_terminate_backend, but destroying the JS client frees the pool slot immediately so the app
// stays available even while a zombie backend lingers server-side (reaped later by the watchdog).
async function execWithTimeout(sql: string, searchPath: string): Promise<unknown[]> {
  const client = await pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The actual work. Kept as a single promise so we can race it against the timeout.
  const work = (async () => {
    if (searchPath) await client.query(`SET search_path TO ${searchPath}`);
    const result = await client.query(sql);
    return result.rows || [];
  })();
  // If the timeout wins the race, `work` will later reject (connection destroyed). Swallow it
  // here so it never surfaces as an unhandledRejection.
  work.catch(() => { /* handled via race / release below */ });

  let timedOut = false;
  try {
    const rows = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Query exceeded ${QUERY_HARD_TIMEOUT_MS}ms client-side timeout (likely Steampipe FDW hang)`));
        }, QUERY_HARD_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    // Success: reset search_path (local, cannot hang) then return the client to the pool.
    if (searchPath) {
      try { await client.query('RESET search_path'); client.release(); }
      catch { client.release(true); }
    } else {
      client.release();
    }
    return rows as unknown[];
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      // FDW hang: destroy the client so the pool slot is freed even though the backend lingers.
      client.release(err instanceof Error ? err : new Error(String(err)));
    } else {
      // Normal SQL error: the connection is still healthy, so reset & return it; destroy if reset fails.
      try {
        if (searchPath) await client.query('RESET search_path');
        client.release();
      } catch {
        client.release(true);
      }
    }
    throw err;
  }
}

// Kill zombie PostgreSQL connections on startup and periodically
// 앱 시작 시 + 주기적으로 좀비 PostgreSQL 연결 정리
// Threshold lowered: Steampipe FDW (Cost Explorer, Lambda tags, IAM summary) can hang past statement_timeout
// 임계값 단축: Steampipe FDW 호출은 statement_timeout으로 끊기지 않을 수 있음
const ZOMBIE_MAX_SECONDS = 90;
// When this many stuck FDW backends SURVIVE pg_terminate_backend, restart Steampipe to reap them.
// pg_terminate can't kill backends blocked in an FDW network syscall; only a daemon restart can.
// 10 of pool max 10 is clearly pathological while leaving huge headroom under max_connections(100).
const ZOMBIE_RESTART_THRESHOLD = 10;
let zombieCleanupStarted = false;
let watchdogRestarting = false;

// Shared predicate for "stuck Steampipe FDW backend" / "고착된 Steampipe FDW 백엔드" 공통 조건
const STUCK_BACKEND_PREDICATE = `
  datname = 'steampipe'
  AND pid != pg_backend_pid()
  AND client_addr IS NOT NULL
  AND state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')
  AND regexp_replace(query, '^\\s+', '') ILIKE 'SELECT%'
  AND query NOT ILIKE '%pg_terminate_backend%'
  AND query NOT ILIKE '%pg_stat_activity%'
  AND age(now(), COALESCE(query_start, state_change)) > INTERVAL '${ZOMBIE_MAX_SECONDS} seconds'`;

function newDiagClient(): Client {
  // Dedicated short-lived Client (NOT the pool) — survives pool exhaustion.
  // 풀 고갈 상황에서도 동작하도록 전용 Client 사용
  return new Client({
    host: '127.0.0.1',
    port: 9193,
    database: 'steampipe',
    user: 'steampipe',
    password: getSpPassword(),
    statement_timeout: 5000,
    connectionTimeoutMillis: 3000,
  });
}

// Health probe: `select 1` on a dedicated short-lived Client — bypasses the pool, cache and 40s
// hard timeout so it answers "is Steampipe up?" even when the pool is exhausted. Never throws.
// 헬스 점검용 — 풀/캐시를 거치지 않는 단기 Client로 `select 1`. 예외를 던지지 않는다.
const PING_HARD_TIMEOUT_MS = 8000;

export async function pingSteampipe(): Promise<{ ok: boolean; message: string }> {
  const client = newDiagClient();
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const probe = (async () => {
      await client.connect();
      await client.query('select 1');
    })();
    const hardTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`ping timed out after ${PING_HARD_TIMEOUT_MS}ms`)), PING_HARD_TIMEOUT_MS);
    });
    await Promise.race([probe, hardTimeout]);
    return { ok: true, message: `select 1 ok (${Date.now() - started}ms)` };
  } catch (err) {
    // AggregateError (dual-stack connect) has an empty message — fall back to its code (ECONNREFUSED).
    const code = (err as { code?: string } | null)?.code;
    const message = err instanceof Error ? err.message || code || err.name : String(err);
    return { ok: false, message: message || 'unknown error' };
  } finally {
    if (timer) clearTimeout(timer);
    try { await client.end(); } catch { /* ignore */ }
  }
}

// Attempt to terminate stuck backends. NOTE: pg_terminate_backend returns true once the signal is
// SENT, not once the backend dies — FDW-hung backends ignore it and survive. So the returned count
// is "termination attempts", not confirmed kills. Survivors are reaped by the watchdog restart.
async function cleanupZombieConnections(): Promise<number> {
  const client = newDiagClient();
  try {
    await client.connect();
    const result = await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ${STUCK_BACKEND_PREDICATE}`
    );
    const attempted = result.rowCount || 0;
    if (attempted > 0) {
      console.log(`[Pool] Attempted termination of ${attempted} stuck backend(s) (>${ZOMBIE_MAX_SECONDS}s); FDW-hung ones may survive`);
    }
    return attempted;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.warn(`[Pool] Zombie cleanup failed: ${message}`);
    return 0;
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

// Count stuck backends that remain AFTER a termination attempt (i.e. real FDW hangs).
// 종료 시도 후에도 남은 고착 백엔드(진짜 FDW 행) 카운트
async function countStuckBackends(): Promise<number> {
  const client = newDiagClient();
  try {
    await client.connect();
    const result = await client.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${STUCK_BACKEND_PREDICATE}`
    );
    return (result.rows[0] as { n: number } | undefined)?.n ?? 0;
  } catch {
    return 0;
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

// Restart Steampipe, preferring the systemd unit (steampipe.service) when the host has one.
// systemd 유닛이 있으면 systemctl로 재시작 — CLI restart는 새 프로세스를 awsops cgroup에 띄워
// steampipe.service와 충돌하므로, 유닛 관리 호스트에서는 반드시 systemctl을 사용해야 한다.
// Requires a sudoers grant: `ec2-user ALL=(root) NOPASSWD: /usr/bin/systemctl restart steampipe.service`
// (installed by scripts/13-setup-steampipe-systemd.sh). Hosts without the unit fall back to the CLI.
function restartSteampipeService(): void {
  try {
    execFileSync('sudo', ['-n', '/usr/bin/systemctl', 'restart', 'steampipe.service'], { timeout: 90000, encoding: 'utf-8' });
    return;
  } catch {
    // No unit / no sudoers grant on this host — fall back to the Steampipe CLI.
  }
  execFileSync('steampipe', ['service', 'restart', '--force'], { timeout: 60000, encoding: 'utf-8' });
}

// Watchdog: when FDW hangs survive termination and pile up, restart Steampipe + reset the pool.
// This is the only reliable reaper for OS-level FDW hangs. Runs as the awsops service user (ec2-user).
async function restartSteampipeIfStuck(stuck: number): Promise<void> {
  if (stuck < ZOMBIE_RESTART_THRESHOLD || watchdogRestarting) return;
  watchdogRestarting = true;
  console.error(`[Watchdog] ${stuck} stuck FDW backend(s) survived termination (>= ${ZOMBIE_RESTART_THRESHOLD}); restarting Steampipe to free pool slots`);
  try {
    restartSteampipeService();
    await resetPool();
    console.log('[Watchdog] Steampipe restarted and pool reset');
  } catch (err) {
    console.error(`[Watchdog] Steampipe restart failed: ${err instanceof Error ? err.message : 'unknown'}`);
  } finally {
    watchdogRestarting = false;
  }
}

// One maintenance tick: try to terminate stuck backends, then reap surviving FDW hangs via restart.
async function poolMaintenanceTick(): Promise<void> {
  await cleanupZombieConnections();
  const stuck = await countStuckBackends();
  if (stuck > 0) {
    console.warn(`[Pool] ${stuck} stuck FDW backend(s) still present after termination attempt`);
    await restartSteampipeIfStuck(stuck);
  }
}

export function startZombieCleanup(): void {
  if (zombieCleanupStarted) return;
  zombieCleanupStarted = true;
  // Initial tick after 3s / 3초 후 초기 실행
  setTimeout(() => { void poolMaintenanceTick(); }, 3000);
  // Periodic tick every 60 seconds / 60초마다 주기 실행
  setInterval(() => { void poolMaintenanceTick(); }, 60 * 1000);
}

const ALLOWED_PATTERN = /^\s*SELECT\s/i;

function validateQuery(sql: string): void {
  if (!ALLOWED_PATTERN.test(sql.trim())) {
    throw new Error('Only SELECT queries are allowed');
  }
  if (/[&`]/.test(sql) || /(?<!\|)\|(?!\|)/.test(sql)) {
    throw new Error('Query contains forbidden characters');
  }
}

// Build search_path for account-scoped queries / 계정별 search_path 생성
function buildSearchPath(accountId?: string): string {
  if (!accountId || accountId === ALL_ACCOUNTS) return '';
  if (!isMultiAccount()) return '';
  const sanitized = accountId.replace(/[^0-9]/g, '');
  if (sanitized.length !== 12) return '';
  const accounts = getAccounts();
  if (!accounts.some(a => a.accountId === sanitized)) return '';
  return `public, aws_${sanitized}, kubernetes, trivy`;
}

export async function runQuery<T = Record<string, unknown>>(
  sql: string,
  opts?: boolean | { bustCache?: boolean; accountId?: string; ttl?: number }
): Promise<{ rows: T[]; error?: string }> {
  const { bustCache = false, accountId, ttl } = typeof opts === 'boolean'
    ? { bustCache: opts, accountId: undefined, ttl: undefined }
    : (opts || {});
  const cacheKey = `sp:${accountId || ALL_ACCOUNTS}:${sql}`;

  if (!bustCache) {
    const cached = cache.get<{ rows: T[] }>(cacheKey);
    if (cached) return cached;
  }

  try {
    validateQuery(sql);
    const searchPath = buildSearchPath(accountId);

    // Unified path: always acquire an explicit client so a client-side timeout can free the
    // pool slot on FDW hangs. (Previously the non-searchPath branch used pool.query() which
    // hid the client handle — a hung query there leaked a pool slot permanently.)
    const rows = (await execWithTimeout(sql, searchPath)) as T[];

    const data = { rows };
    if (ttl) {
      cache.set(cacheKey, data, ttl);
    } else {
      cache.set(cacheKey, data);
    }
    return data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { rows: [], error: message };
  }
}

export async function batchQuery(
  queries: Record<string, string>,
  opts?: boolean | { bustCache?: boolean; accountId?: string; ttl?: number }
): Promise<Record<string, { rows: unknown[]; error?: string }>> {
  const normalizedOpts = typeof opts === 'boolean'
    ? { bustCache: opts }
    : (opts || {});

  const results: Record<string, { rows: unknown[]; error?: string }> = {};
  const entries = Object.entries(queries);

  // Run in sequential batches of 8 (leaves 2 pool slots for other requests)
  // 8개씩 병렬 실행 (다른 요청을 위해 풀 슬롯 2개 여유)
  const BATCH_SIZE = 8;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(([, sql]) => runQuery(sql, normalizedOpts))
    );
    batch.forEach(([key], j) => {
      const s = settled[j];
      if (s.status === 'fulfilled') {
        results[key] = s.value;
      } else {
        results[key] = { rows: [], error: s.reason?.message || 'Query failed' };
      }
    });
  }

  return results;
}

export function clearCache(): void {
  cache.flushAll();
}

// Cost Explorer availability probe / Cost Explorer 가용성 확인
// 설치 시 config로 MSP 판별 → 런타임에 Steampipe 쿼리 스킵
const COST_CACHE_TTL = 3600; // 1시간

export async function checkCostAvailability(
  bustCache = false,
  accountId?: string
): Promise<{ available: boolean; reason?: string; checkedAt?: string }> {
  // 설치 시 판별된 config 확인 — MSP Payer면 쿼리 없이 즉시 반환
  const config = getConfig();
  if (!config.costEnabled) {
    return {
      available: false,
      reason: 'Cost Explorer disabled (MSP/Payer account — configured at install)',
      checkedAt: new Date().toISOString(),
    };
  }

  const costCacheKey = `cost:available:${accountId || ALL_ACCOUNTS}`;

  if (!bustCache) {
    const cached = cache.get<{ available: boolean; reason?: string; checkedAt?: string }>(costCacheKey);
    if (cached) return cached;
  }

  const searchPath = buildSearchPath(accountId);
  let client;
  try {
    client = await pool.connect();
    if (searchPath) {
      await client.query(`SET search_path TO ${searchPath}`);
    }
    await client.query("SET statement_timeout = '10000'"); // 10초 전용 타임아웃
    await client.query('SELECT 1 FROM aws_cost_by_service_monthly LIMIT 1');
    const result = { available: true, checkedAt: new Date().toISOString() };
    cache.set(costCacheKey, result, COST_CACHE_TTL);
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const reason = /permission denied|AccessDenied|not authorized/i.test(message)
      ? 'Cost Explorer access denied (MSP/SCP restriction)'
      : /timeout|canceling statement/i.test(message)
        ? 'Cost Explorer query timed out'
        : /does not exist/i.test(message)
          ? 'Cost Explorer not enabled'
          : `Cost Explorer unavailable: ${message}`;
    const result = { available: false, reason, checkedAt: new Date().toISOString() };
    cache.set(costCacheKey, result, COST_CACHE_TTL);
    return result;
  } finally {
    if (client) {
      let released = false;
      try {
        await client.query('RESET statement_timeout');
      } catch {
        client.release(true);
        released = true;
      }
      if (!released && searchPath) {
        try { await client.query('RESET search_path'); } catch { client.release(true); released = true; }
      }
      if (!released) client.release();
    }
  }
}

// Run cost queries per-account, merge results with account tags / 계정별 비용 쿼리 실행 후 결과 병합
export async function runCostQueriesPerAccount(
  queries: Record<string, string>,
  accounts?: AccountConfig[]
): Promise<Record<string, { rows: unknown[]; error?: string }>> {
  const accts = (accounts || getAccounts()).filter(a => a.features.costEnabled);
  if (accts.length === 0) return batchQuery(queries);

  const ACCOUNT_BATCH_SIZE = 2;
  const perAccountResults: PromiseSettledResult<Record<string, { rows: unknown[]; error?: string }>>[] = [];
  for (let i = 0; i < accts.length; i += ACCOUNT_BATCH_SIZE) {
    const chunk = accts.slice(i, i + ACCOUNT_BATCH_SIZE);
    const chunkResults = await Promise.allSettled(
      chunk.map(acc => batchQuery(queries, { accountId: acc.accountId }))
    );
    perAccountResults.push(...chunkResults);
  }

  const merged: Record<string, { rows: unknown[]; error?: string }> = {};
  for (const key of Object.keys(queries)) {
    merged[key] = { rows: [] };
  }

  const failedAccounts: string[] = [];
  perAccountResults.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      const { accountId, alias } = accts[i];
      for (const [key, val] of Object.entries(result.value)) {
        if (val.rows) {
          const tagged = val.rows.map((r: unknown) => ({ ...(r as Record<string, unknown>), account_id: accountId, account_alias: alias }));
          (merged[key].rows as unknown[]).push(...tagged);
        }
      }
    } else {
      failedAccounts.push(accts[i].accountId);
    }
  });

  if (failedAccounts.length > 0) {
    for (const key of Object.keys(queries)) {
      merged[key].error = `Partial: failed accounts ${failedAccounts.join(', ')}`;
    }
  }

  return merged;
}

// Reset pool and flush cache / 풀 리셋 및 캐시 초기화
export async function resetPool(): Promise<void> {
  try { await pool.end(); } catch { /* ignore */ }
  pool = createPool();
  cache.flushAll();
  for (let i = 0; i < 15; i++) {
    try { await pool.query('SELECT 1'); return; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
}
