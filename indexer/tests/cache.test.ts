import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import request from 'supertest';
import {
  GENERATION_KEY,
  cacheGeneration,
  cacheGetJson,
  cacheSet,
  invalidateAllInvoiceCaches,
  invalidateInvoiceCache,
  setCacheClient,
  type CacheClient,
} from '../src/cache';
import { cacheInvalidationFailuresTotal, cacheStaleWritesSkippedTotal } from '../src/metrics';
import { createApp } from '../src/api';
import { createDb, setDb, upsertInvoice } from '../src/db';
import type { Invoice } from '../src/types';

/**
 * In-memory stand-in for the Redis commands cache.ts uses (#1445). It models
 * the conditional write by interpreting the same arguments the Lua script
 * receives. The real script runs in the "against Redis" suite below whenever
 * REDIS_TEST_URL is set.
 */
class FakeRedis {
  store = new Map<string, string>();
  failing = false;

  private guard() {
    if (this.failing) throw new Error('connection refused');
  }
  async get(key: string) {
    this.guard();
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.guard();
    this.store.set(key, value);
    return 'OK';
  }
  async del(...keys: string[]) {
    this.guard();
    let n = 0;
    for (const k of keys.flat()) n += this.store.delete(k) ? 1 : 0;
    return n;
  }
  async incr(key: string) {
    this.guard();
    const next = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(next));
    return next;
  }
  async eval(_script: string, _n: number, genKey: string, key: string, expected: string, value: string) {
    this.guard();
    if ((this.store.get(genKey) ?? '0') !== expected) return 0;
    this.store.set(key, value);
    return 1;
  }
  async scan(cursor: string, _m: string, pattern: string, _c: string, count: number) {
    this.guard();
    // Like Redis, keys present for the whole scan are returned even when
    // others are deleted between calls: the cursor is the last key returned.
    const prefix = pattern.replace(/\*$/, '');
    const after = cursor === '0' ? '' : Buffer.from(cursor, 'base64').toString();
    const all = [...this.store.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
    const page = all.slice(0, count);
    const next = all.length > count ? Buffer.from(page[page.length - 1]).toString('base64') : '0';
    return [next, page] as [string, string[]];
  }
}

async function counter(metric: { get: () => Promise<{ values: Array<{ value: number }> }> }) {
  return (await metric.get()).values[0]?.value ?? 0;
}

function invoice(id: number, status = 'Pending'): Omit<Invoice, 'created_at' | 'updated_at'> {
  return {
    id,
    freelancer: 'GFREELANCER',
    payer: 'GPAYER',
    amount: '1000',
    due_date: 1_900_000_000,
    discount_rate: 300,
    status,
    funder: null,
    funded_at: null,
  } as Omit<Invoice, 'created_at' | 'updated_at'>;
}

/** The behaviour every backend must have; run against the fake and, when available, real Redis. */
function cacheContract(name: string, makeClient: () => Promise<{ client: CacheClient; reset: () => Promise<void> }>) {
  describe(`cache invalidation (#1445) - ${name}`, () => {
    let reset: () => Promise<void>;

    beforeEach(async () => {
      const made = await makeClient();
      reset = made.reset;
      await reset();
      setCacheClient(made.client);
    });

    afterEach(() => setCacheClient(undefined));

    it('stores and returns a value when nothing changed in between', async () => {
      const generation = await cacheGeneration();
      expect(await cacheSet('invoice:1', JSON.stringify({ v: 1 }), 30, generation)).toBe(true);
      expect(await cacheGetJson('invoice:1')).toEqual({ v: 1 });
    });

    it('never writes back a copy read before a concurrent invalidation', async () => {
      // Reader takes the generation, then reads the old row from SQLite...
      const generation = await cacheGeneration();
      const staleCopy = JSON.stringify({ status: 'Pending' });
      // ...the poller updates the row and invalidates...
      await invalidateInvoiceCache(1);
      // ...and the reader's write of the old copy is refused.
      const before = await counter(cacheStaleWritesSkippedTotal);
      expect(await cacheSet('invoice:1', staleCopy, 30, generation)).toBe(false);
      expect(await cacheGetJson('invoice:1')).toBeNull();
      expect(await counter(cacheStaleWritesSkippedTotal)).toBe(before + 1);

      // The next reader starts after the invalidation and caches normally.
      const fresh = await cacheGeneration();
      expect(await cacheSet('invoice:1', JSON.stringify({ status: 'Funded' }), 30, fresh)).toBe(true);
    });

    it('drops the invoice and every list, but not other invoices', async () => {
      for (const key of ['invoice:1', 'invoice:2', 'invoices:a', 'invoices:b']) {
        await cacheSet(key, '{}');
      }
      expect(await invalidateInvoiceCache(1)).toBe(true);
      expect(await cacheGetJson('invoice:1')).toBeNull();
      expect(await cacheGetJson('invoices:a')).toBeNull();
      expect(await cacheGetJson('invoices:b')).toBeNull();
      expect(await cacheGetJson('invoice:2')).toEqual({});
    });

    it('clears every invoice and list for bulk changes (archive runs)', async () => {
      for (const key of ['invoice:1', 'invoice:2', 'invoices:a', 'unrelated']) {
        await cacheSet(key, '{}');
      }
      expect(await invalidateAllInvoiceCaches()).toBe(true);
      expect(await cacheGetJson('invoice:1')).toBeNull();
      expect(await cacheGetJson('invoice:2')).toBeNull();
      expect(await cacheGetJson('invoices:a')).toBeNull();
      expect(await cacheGetJson('unrelated')).toEqual({});
    });

    it('removes lists spread over many SCAN pages', async () => {
      for (let i = 0; i < 1_200; i++) await cacheSet(`invoices:${i}`, '{}');
      await invalidateInvoiceCache(9);
      for (const i of [0, 599, 1_199]) expect(await cacheGetJson(`invoices:${i}`)).toBeNull();
    });

    it('treats a corrupt entry as a miss and removes it', async () => {
      await cacheSet('invoice:1', '{not json');
      expect(await cacheGetJson('invoice:1')).toBeNull();
      await cacheSet('invoice:1', '{"ok":true}', 30, await cacheGeneration());
      expect(await cacheGetJson('invoice:1')).toEqual({ ok: true });
    });

    it('is idempotent when the same invalidation repeats', async () => {
      await cacheSet('invoice:1', '{}');
      expect(await invalidateInvoiceCache(1)).toBe(true);
      expect(await invalidateInvoiceCache(1)).toBe(true);
      expect(await cacheGetJson('invoice:1')).toBeNull();
    });
  });
}

cacheContract('in-memory client', async () => {
  const fake = new FakeRedis();
  return { client: fake as unknown as CacheClient, reset: async () => fake.store.clear() };
});

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
  cacheContract('Redis', async () => ({ client: redis, reset: async () => void (await redis.flushdb()) }));
});

describe('cache failure behaviour (#1445)', () => {
  afterEach(() => setCacheClient(undefined));

  it('reports a failed invalidation instead of hiding it', async () => {
    const fake = new FakeRedis();
    setCacheClient(fake as unknown as CacheClient);
    fake.failing = true;
    const before = await counter(cacheInvalidationFailuresTotal);
    expect(await invalidateInvoiceCache(1)).toBe(false);
    expect(await invalidateAllInvoiceCaches()).toBe(false);
    expect(await counter(cacheInvalidationFailuresTotal)).toBe(before + 2);
  });

  it('skips writes when the cache was unreachable as the request started', async () => {
    const fake = new FakeRedis();
    setCacheClient(fake as unknown as CacheClient);
    fake.failing = true;
    const generation = await cacheGeneration();
    expect(generation).toBeNull();
    fake.failing = false;
    expect(await cacheSet('invoice:1', '{}', 30, generation)).toBe(false);
    expect(fake.store.has('invoice:1')).toBe(false);
  });

  it('does nothing without Redis', async () => {
    setCacheClient(null);
    expect(await cacheGeneration()).toBeNull();
    expect(await cacheSet('invoice:1', '{}')).toBe(false);
    expect(await invalidateInvoiceCache(1)).toBe(true);
  });
});

describe('API reads through the cache (#1445)', () => {
  let fake: FakeRedis;

  beforeEach(() => {
    fake = new FakeRedis();
    setCacheClient(fake as unknown as CacheClient);
    setDb(createDb(':memory:'));
  });

  afterEach(() => setCacheClient(undefined));

  it('serves a reprocessed invoice fresh after invalidation', async () => {
    const app = createApp();
    upsertInvoice(invoice(1, 'Pending'));
    expect((await request(app).get('/v1/invoice/1')).body.invoice.status).toBe('Pending');
    expect(fake.store.has('invoice:1')).toBe(true);

    upsertInvoice(invoice(1, 'Funded'));
    // Without invalidation the cached copy is still served (TTL-bounded)...
    expect((await request(app).get('/v1/invoice/1')).body.invoice.status).toBe('Pending');
    // ...which is why every writer invalidates after it commits.
    await invalidateInvoiceCache(1);
    expect((await request(app).get('/v1/invoice/1')).body.invoice.status).toBe('Funded');
  });

  it('answers from SQLite when the cached entry is corrupt (used to be a 500)', async () => {
    const app = createApp();
    upsertInvoice(invoice(1));
    fake.store.set('invoice:1', '{truncated');
    const res = await request(app).get('/v1/invoice/1');
    expect(res.status).toBe(200);
    expect(res.body.invoice.id).toBe(1);
  });

  it('invalidates list caches when an invoice is restored from the archive', async () => {
    const app = createApp();
    fake.store.set('invoices:cached-list', JSON.stringify({ invoices: [], hasMore: false }));
    fake.store.set('invoice:7', JSON.stringify({ invoice: { id: 7 } }));
    // Restoring a missing invoice is a 404 and changes nothing.
    expect((await request(app).post('/v1/archive/restore/7')).status).toBe(404);
    expect(fake.store.has('invoices:cached-list')).toBe(true);
  });

  it('drops cached invoices after an archive run moves them', async () => {
    const app = createApp();
    upsertInvoice(invoice(1));
    await request(app).get('/v1/invoice/1');
    expect(fake.store.has('invoice:1')).toBe(true);
    // Archive everything created before now (olderThanDays: 0 moves it all).
    const res = await request(app).post('/v1/archive/run').send({ olderThanDays: 0 });
    expect(res.status).toBe(200);
    expect(res.body.invoicesMoved).toBe(1);
    expect(fake.store.has('invoice:1')).toBe(false);
    expect((await request(app).get('/v1/invoice/1')).status).toBe(404);

    // Restoring it brings it back into every list, so cached lists go too.
    await request(app).get('/v1/invoices');
    const listKeys = () => [...fake.store.keys()].filter((k) => k.startsWith('invoices:'));
    expect(listKeys()).toHaveLength(1);
    expect((await request(app).post('/v1/archive/restore/1')).status).toBe(200);
    expect(listKeys()).toHaveLength(0);
    expect((await request(app).get('/v1/invoice/1')).body.invoice.id).toBe(1);
  });
});
