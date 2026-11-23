import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import Redis from 'ioredis';
import { CONFIG } from '../src/config';
import { RedisRateLimitStore, createApiRateLimiter, rateLimitKey, type RateLimitRedis } from '../src/rateLimit';
import { rateLimitStoreErrorsTotal } from '../src/metrics';
import { validateIndexerEnv } from '../src/configValidation';

/**
 * Proxied and distributed rate limiting (#1446). Each case builds an app the
 * way createApp() does (trust proxy, then the limiter) so the real
 * X-Forwarded-For resolution is exercised, with a small limit.
 */

const config = CONFIG as unknown as {
  rateLimitMax: number;
  rateLimitWindowMs: number;
  rateLimitWhitelist: string[];
  trustProxyHops: number;
  redisUrl: string | undefined;
};
const saved = { ...config, rateLimitWhitelist: [...CONFIG.rateLimitWhitelist] };

beforeEach(() => {
  config.rateLimitMax = 3;
  config.rateLimitWindowMs = 60_000;
  config.rateLimitWhitelist = ['127.0.0.1'];
  config.trustProxyHops = 1;
  config.redisUrl = undefined;
});

afterEach(() => Object.assign(config, saved));

function appWith(store?: RedisRateLimitStore): Express {
  const app = express();
  app.set('trust proxy', config.trustProxyHops);
  app.use(createApiRateLimiter({ store }));
  app.get('/stats', (req, res) => res.json({ ip: req.ip }));
  return app;
}

async function hitUntilLimited(send: () => request.Test, max = 10): Promise<number> {
  for (let i = 1; i <= max; i++) {
    if ((await send()).status === 429) return i;
  }
  return -1;
}

describe('client identity behind proxies (#1446)', () => {
  it('charges the address the trusted proxy appended, not ones the client wrote', async () => {
    const app = appWith();
    // One trusted hop: Railway appends the real client (203.0.113.9) to
    // whatever the client sent. Rotating the forged part must not help.
    let n = 0;
    const blockedAt = await hitUntilLimited(() =>
      request(app).get('/stats').set('X-Forwarded-For', `10.0.0.${n++}, 203.0.113.9`)
    );
    expect(blockedAt).toBe(4);
  });

  it('cannot forge a whitelisted address through X-Forwarded-For', async () => {
    const app = appWith();
    const send = () => request(app).get('/stats').set('X-Forwarded-For', '127.0.0.1, 198.51.100.4');
    expect((await send()).body.ip).toBe('198.51.100.4');
    expect(await hitUntilLimited(send)).toBe(3); // already one hit above
  });

  it('keeps clients behind the same proxy in separate buckets (no false blocklisting)', async () => {
    const app = appWith();
    for (let i = 0; i < 3; i++) {
      await request(app).get('/stats').set('X-Forwarded-For', '198.51.100.1');
    }
    expect((await request(app).get('/stats').set('X-Forwarded-For', '198.51.100.1')).status).toBe(429);
    expect((await request(app).get('/stats').set('X-Forwarded-For', '198.51.100.2')).status).toBe(200);
  });

  it('with TRUST_PROXY_HOPS=0 ignores X-Forwarded-For entirely (directly exposed indexer)', async () => {
    config.trustProxyHops = 0;
    config.rateLimitWhitelist = [];
    const app = appWith();
    let n = 0;
    const res = await request(app).get('/stats').set('X-Forwarded-For', '203.0.113.50');
    expect(res.body.ip).toMatch(/127\.0\.0\.1$/);
    // Rotating the header does not create fresh buckets.
    expect(
      await hitUntilLimited(() => request(app).get('/stats').set('X-Forwarded-For', `203.0.113.${n++}`))
    ).toBe(3);
  });

  it('with TRUST_PROXY_HOPS=2 (CDN + platform proxy) finds the client, not the CDN', async () => {
    config.trustProxyHops = 2;
    const app = appWith();
    const res = await request(app).get('/stats').set('X-Forwarded-For', 'spoofed, 203.0.113.7, 192.0.2.10');
    expect(res.body.ip).toBe('203.0.113.7');
  });

  it('counts an IPv6 client per /64, so rotating addresses in its subnet is no bypass', async () => {
    const app = appWith();
    let n = 1;
    const blockedAt = await hitUntilLimited(() =>
      request(app).get('/stats').set('X-Forwarded-For', `2001:db8:1:2::${(n++).toString(16)}`)
    );
    expect(blockedAt).toBe(4);
    expect((await request(app).get('/stats').set('X-Forwarded-For', '2001:db8:1:3::1')).status).toBe(200);
  });

  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002::9', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '127.0.0.1'],
    ['not-an-ip', 'unknown'],
  ])('keys %s as %s', (ip, key) => {
    expect(rateLimitKey(ip)).toBe(key);
  });

  it('validates TRUST_PROXY_HOPS at startup', () => {
    const bad = validateIndexerEnv({ TRUST_PROXY_HOPS: '-1' }, { checkFilesystem: false });
    expect(bad.errors.some((e) => e.variable === 'TRUST_PROXY_HOPS')).toBe(true);
    const good = validateIndexerEnv({ TRUST_PROXY_HOPS: '2' }, { checkFilesystem: false });
    expect(good.errors.some((e) => e.variable === 'TRUST_PROXY_HOPS')).toBe(false);
  });
});

/** Minimal model of the Redis commands the store uses (the real script runs below with REDIS_TEST_URL). */
class FakeRedis {
  counters = new Map<string, { hits: number; expiresAt: number }>();
  failing = false;
  async eval(_script: string, _n: number, key: string, windowMs: number) {
    if (this.failing) throw new Error('connection refused');
    const now = Date.now();
    const entry = this.counters.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.counters.set(key, { hits: 1, expiresAt: now + Number(windowMs) });
      return [1, Number(windowMs)];
    }
    entry.hits += 1;
    return [entry.hits, entry.expiresAt - now];
  }
  async decr(key: string) {
    const entry = this.counters.get(key);
    if (entry) entry.hits -= 1;
    return entry?.hits ?? 0;
  }
  async del(key: string) {
    return this.counters.delete(key) ? 1 : 0;
  }
}

function sharedCounterContract(name: string, makeClient: () => Promise<RateLimitRedis>) {
  describe(`distributed rate limiting (#1446) - ${name}`, () => {
    it('enforces one limit across replicas sharing the store', async () => {
      const client = await makeClient();
      // Two indexer replicas behind one load balancer, same client, one prefix.
      const prefix = `rl-test-shared-${Date.now()}-${Math.random()}:`;
      const a = appWith(new RedisRateLimitStore(client, prefix));
      const b = appWith(new RedisRateLimitStore(client, prefix));
      const from = (app: Express) => request(app).get('/stats').set('X-Forwarded-For', '203.0.113.20');
      expect((await from(a)).status).toBe(200);
      expect((await from(b)).status).toBe(200);
      expect((await from(a)).status).toBe(200);
      const fourth = await from(b);
      expect(fourth.status).toBe(429);
      expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('reports the shared remaining count on every replica', async () => {
      const client = await makeClient();
      const prefix = `rl-test-remaining-${Date.now()}-${Math.random()}:`;
      const a = appWith(new RedisRateLimitStore(client, prefix));
      const b = appWith(new RedisRateLimitStore(client, prefix));
      await request(a).get('/stats').set('X-Forwarded-For', '203.0.113.21');
      const res = await request(b).get('/stats').set('X-Forwarded-For', '203.0.113.21');
      expect(res.headers['ratelimit-remaining']).toBe('1');
    });
  });
}

sharedCounterContract('in-memory client', async () => new FakeRedis() as unknown as RateLimitRedis);

// To run these cases against a real Redis server as well:
//   REDIS_TEST_URL=redis://127.0.0.1:6379/15 pnpm --filter iln-indexer test
// Use a dedicated database: the cache suite flushes it between cases.
const redisUrl = process.env.REDIS_TEST_URL;
describe.skipIf(!redisUrl)('against Redis (REDIS_TEST_URL)', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(redisUrl!);
  });
  afterAll(async () => {
    await redis?.quit();
  });
  sharedCounterContract('Redis', async () => redis);
});

describe('rate limit store failure (#1446)', () => {
  it('fails open, so a Redis outage cannot blocklist every client, and counts it', async () => {
    const fake = new FakeRedis();
    fake.failing = true;
    const app = appWith(new RedisRateLimitStore(fake as unknown as RateLimitRedis));
    const before = (await rateLimitStoreErrorsTotal.get()).values[0]?.value ?? 0;
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/stats').set('X-Forwarded-For', '203.0.113.30')).status).toBe(200);
    }
    expect((await rateLimitStoreErrorsTotal.get()).values[0]?.value ?? 0).toBe(before + 5);
  });
});
