import { rateLimit, type RateLimitRequestHandler, type Store, type Options, type ClientRateLimitInfo } from 'express-rate-limit';
import type { Request } from 'express';
import { isIP } from 'node:net';
import Redis from 'ioredis';
import { CONFIG } from './config';
import { rateLimitStoreErrorsTotal } from './metrics';

/**
 * Builds a per-client rate limiter for the public indexer API.
 *
 * This is a factory (rather than a module-level singleton) so each
 * `createApp()` call gets its own independent counter store - matching
 * `createApp`'s own "fresh app per call" design and keeping tests that
 * create multiple apps from leaking rate-limit state into each other.
 *
 * Defaults to 100 requests/minute per client (configurable via
 * RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX). Blocked requests get a 429 with
 * a Retry-After header; every response carries RateLimit-Limit,
 * RateLimit-Remaining, and RateLimit-Reset headers.
 *
 * Who is a client (#1446)
 * -----------------------
 * The client address is `req.ip`, which Express derives from X-Forwarded-For
 * by trusting exactly TRUST_PROXY_HOPS proxies (api.ts). With the right hop
 * count the address is the one the outermost trusted proxy saw; entries a
 * client adds itself sit further left and are ignored, so rotating or forging
 * X-Forwarded-For neither escapes the limit nor claims a whitelisted address.
 * A wrong hop count is the main residual risk: too high lets clients choose
 * their IP, too low makes every client share the proxy's bucket.
 *
 * IPv6 clients are counted per /64 network (the usual smallest allocation),
 * so cycling through addresses in one's own subnet is no bypass.
 *
 * Shared counters
 * ---------------
 * With REDIS_URL set, counts live in Redis, so N indexer replicas enforce one
 * limit instead of N. If Redis fails the request is allowed (fail open, so an
 * outage cannot blocklist everyone), logged, and counted in
 * `iln_rate_limit_store_errors_total`. Without Redis, each process counts on
 * its own.
 *
 * IPs listed in RATE_LIMIT_WHITELIST (comma-separated) bypass the limiter
 * entirely, so internal services and monitoring are never throttled. This is
 * intentionally an exact, parsed IP match against the same resolved client
 * address.
 */
export function createApiRateLimiter(options: { store?: Store } = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: CONFIG.rateLimitWindowMs,
    limit: CONFIG.rateLimitMax,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    keyGenerator: (req: Request) => rateLimitKey(req.ip ?? ''),
    store: options.store ?? defaultStore(),
    // Fail open on store errors: see "Shared counters" above.
    passOnStoreError: true,
    skip: (req: Request) => {
      // Health probes must never be throttled, or the orchestrator restarts a
      // healthy instance under load (docs/indexer/deployment.md).
      if (req.path === '/health' || req.path === '/v1/health') return true;
      // Normalize ::ffff:x.x.x.x (IPv4-mapped IPv6) and ::1 to their IPv4
      // equivalents, then require a real IP before matching the whitelist.
      const normalized = normalizeIp(req.ip ?? '');
      return isIP(normalized) !== 0 && CONFIG.rateLimitWhitelist.includes(normalized);
    },
    message: {
      error: 'Too many requests - please slow down and try again shortly.',
    },
  });
}

/** Normalize only valid IP spellings; never treat arbitrary identifiers as addresses. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4) {
    return trimmed.slice(7);
  }
  return trimmed === '::1' ? '127.0.0.1' : trimmed;
}

/**
 * The counter a request is charged to: the IPv4 address, or the /64 network
 * of an IPv6 address. Anything that is not an IP shares one bucket.
 */
export function rateLimitKey(ip: string): string {
  const normalized = normalizeIp(ip);
  const family = isIP(normalized);
  if (family === 4) return normalized;
  if (family === 6) return `${ipv6Prefix64(normalized)}::/64`;
  return 'unknown';
}

/** The first four 16-bit groups of an IPv6 address, fully expanded. */
function ipv6Prefix64(address: string): string {
  const [head, tail = ''] = address.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  // An embedded IPv4 tail (::ffff:1.2.3.4 style) occupies two groups.
  const groupsOf = (parts: string[]) => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0);
  const missing = 8 - groupsOf(left) - groupsOf(right);
  const groups = address.includes('::') ? [...left, ...Array(Math.max(0, missing)).fill('0'), ...right] : left;
  return groups
    .slice(0, 4)
    .map((g) => (g.includes('.') ? '0' : String(parseInt(g || '0', 16).toString(16))))
    .join(':');
}

// ─── Redis store ──────────────────────────────────────────────────────────────

/** The Redis command the store needs, so tests can supply their own client. */
export type RateLimitRedis = Pick<Redis, 'eval' | 'decr' | 'del'>;

// KEYS[1] = counter; ARGV[1] = window ms. Returns { hits, ms until reset }.
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/**
 * express-rate-limit store sharing fixed-window counters through Redis. The
 * window starts at a client's first hit, exactly like the default memory
 * store, and INCR + PEXPIRE run atomically in one script.
 */
export class RedisRateLimitStore implements Store {
  windowMs = 60_000;
  readonly prefix: string;
  readonly localKeys = false;

  constructor(
    private readonly client: RateLimitRedis,
    prefix = 'ratelimit:'
  ) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      const [hits, ttl] = (await this.client.eval(INCREMENT, 1, this.prefix + key, this.windowMs)) as [number, number];
      return { totalHits: Number(hits), resetTime: new Date(Date.now() + Number(ttl)) };
    } catch (err) {
      console.error('[rateLimit] Redis store unavailable; allowing request:', err instanceof Error ? err.message : err);
      try {
        rateLimitStoreErrorsTotal.inc();
      } catch {
        /* metrics failure is non-fatal */
      }
      throw err; // passOnStoreError lets the request through
    }
  }

  async decrement(key: string): Promise<void> {
    await this.client.decr(this.prefix + key);
  }

  async resetKey(key: string): Promise<void> {
    await this.client.del(this.prefix + key);
  }
}

let sharedRedis: Redis | null = null;

/** Redis-backed counters when REDIS_URL is set; otherwise the per-process memory store. */
function defaultStore(): Store | undefined {
  if (!CONFIG.redisUrl) return undefined;
  if (!sharedRedis) {
    sharedRedis = new Redis(CONFIG.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    sharedRedis.on('error', (err: Error) => console.error('[rateLimit] Redis error:', err.message));
  }
  return new RedisRateLimitStore(sharedRedis);
}
