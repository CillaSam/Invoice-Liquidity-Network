import Redis from 'ioredis';
import { CONFIG } from './config';
import { cacheInvalidationFailuresTotal, cacheStaleWritesSkippedTotal } from './metrics';

/**
 * Redis read-through cache for invoice responses (#1445).
 *
 * Source of truth: the SQLite `invoices` table. Redis only holds copies of two
 * REST responses, each for at most INVOICE_TTL_SECONDS:
 *
 *   invoice:<id>        GET /invoice/:id  (found invoices only; 404s are not cached)
 *   invoices:<sha256>   GET /invoices     (one key per filter/limit/cursor combination)
 *
 * Protocol totals, LP/freelancer stats (reputations), top LPs and history are
 * not stored in Redis: they are computed from SQLite on every request and only
 * carry HTTP Cache-Control (short/medium max-age), so they need no
 * invalidation here.
 *
 * Invalidation and the stale write-back race
 * ------------------------------------------
 * A reader can load a row from SQLite, lose the CPU while the poller updates
 * that row and invalidates the cache, then write its now-stale copy back,
 * where it would be served for the full TTL. To prevent that, every
 * invalidation first increments a generation counter (GENERATION_KEY) and then
 * deletes the keys. A reader takes the generation *before* reading SQLite
 * (`cacheGeneration()`) and passes it to `cacheSet`, which writes only if the
 * generation is unchanged, atomically (one Lua script). A copy read before an
 * invalidation therefore can never land after it.
 *
 * Failure behaviour
 * -----------------
 * - Redis unset (no REDIS_URL): every call is a no-op; reads always miss.
 * - Redis unreachable on read or write: treated as a miss / skipped write.
 * - A cached value that is not valid JSON: treated as a miss and deleted.
 * - Invalidation failure: logged and counted
 *   (`iln_cache_invalidation_failures_total`); the stale copy then lives at
 *   most INVOICE_TTL_SECONDS. This is the residual risk of a best-effort
 *   cache, and the reason the TTL is short.
 */

export const INVOICE_TTL_SECONDS = 30;
export const GENERATION_KEY = 'cache:generation';

/** The Redis commands this module uses, so tests can supply their own client. */
export type CacheClient = Pick<Redis, 'get' | 'set' | 'del' | 'incr' | 'eval' | 'scan'>;

let _client: CacheClient | null = null;
let _injected = false;

function getClient(): CacheClient | null {
  if (_injected) return _client;
  if (!CONFIG.redisUrl) return null;
  if (!_client) {
    const redis = new Redis(CONFIG.redisUrl);
    redis.on('error', (err: Error) => {
      console.error('[cache] Redis error:', err.message);
    });
    _client = redis;
  }
  return _client;
}

/** Use `client` instead of REDIS_URL (tests). Pass `null` to disable the cache, `undefined` to reset. */
export function setCacheClient(client: CacheClient | null | undefined): void {
  _client = client ?? null;
  _injected = client !== undefined;
}

/**
 * The current cache generation, to pass to `cacheSet`. Call it before reading
 * the data you intend to cache. Returns null when the cache is unavailable.
 */
export async function cacheGeneration(): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  try {
    return (await client.get(GENERATION_KEY)) ?? '0';
  } catch {
    return null;
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    return (await getClient()?.get(key)) ?? null;
  } catch {
    return null;
  }
}

/** Parse a cached JSON value. A corrupt entry is a miss and is removed. */
export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const raw = await cacheGet(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`[cache] Discarding unparsable entry ${key}`);
    await cacheDelete(key);
    return null;
  }
}

// KEYS[1] = generation key, KEYS[2] = value key; ARGV = expected generation, value, ttl.
const SET_IF_GENERATION = `
local current = redis.call('GET', KEYS[1])
if current == false then current = '0' end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;

/**
 * Store `value` for `ttlSeconds`. With `generation` (from `cacheGeneration()`),
 * the write is skipped if any invalidation happened since, so a stale read can
 * never overwrite a fresh invalidation. Returns whether the value was stored.
 */
export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds = INVOICE_TTL_SECONDS,
  generation?: string | null
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;
  try {
    if (generation === undefined) {
      await client.set(key, value, 'EX', ttlSeconds);
      return true;
    }
    // The cache was unavailable when the reader started: do not write now.
    if (generation === null) return false;
    const stored = Number(await client.eval(SET_IF_GENERATION, 2, GENERATION_KEY, key, generation, value, ttlSeconds));
    if (stored !== 1) {
      try {
        cacheStaleWritesSkippedTotal.inc();
      } catch {
        /* metrics failure is non-fatal */
      }
    }
    return stored === 1;
  } catch {
    // Non-fatal: the next request will simply miss the cache.
    return false;
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    await getClient()?.del(key);
  } catch {
    // Non-fatal.
  }
}

/** Delete every key matching `pattern`, using SCAN (KEYS blocks Redis on large keyspaces). */
async function deletePattern(client: CacheClient, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    if (keys.length > 0) await client.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}

export async function cacheDeletePattern(pattern: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await deletePattern(client, pattern);
  } catch {
    // Non-fatal.
  }
}

function recordInvalidationFailure(scope: string, err: unknown): void {
  console.error(`[cache] Invalidation failed for ${scope}; stale entries expire within ${INVOICE_TTL_SECONDS}s:`, err);
  try {
    cacheInvalidationFailuresTotal.inc();
  } catch {
    /* metrics failure is non-fatal */
  }
}

/**
 * Invalidate one invoice and every cached invoice list. Bumps the generation
 * first, so readers already in flight cannot write stale copies back. Returns
 * false (after logging and counting) when Redis could not be updated.
 */
export async function invalidateInvoiceCache(id: number): Promise<boolean> {
  const client = getClient();
  if (!client) return true;
  try {
    await client.incr(GENERATION_KEY);
    await client.del(`invoice:${id}`);
    await deletePattern(client, 'invoices:*');
    return true;
  } catch (err) {
    recordInvalidationFailure(`invoice ${id}`, err);
    return false;
  }
}

/**
 * Invalidate every cached invoice and list, for bulk changes such as an
 * archive run that moves many invoices at once.
 */
export async function invalidateAllInvoiceCaches(): Promise<boolean> {
  const client = getClient();
  if (!client) return true;
  try {
    await client.incr(GENERATION_KEY);
    await deletePattern(client, 'invoice:*');
    await deletePattern(client, 'invoices:*');
    return true;
  } catch (err) {
    recordInvalidationFailure('all invoices', err);
    return false;
  }
}
