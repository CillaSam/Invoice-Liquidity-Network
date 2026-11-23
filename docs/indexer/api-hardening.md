# Indexer API hardening: verified behaviour

This page records what was verified, what changed and what risk remains for
four parts of the indexer's public surface:

| Issue | Module | Tests |
| --- | --- | --- |
| #1444 | GraphQL pagination and query limits (`indexer/src/graphql.ts`) | `tests/graphql.complexity.test.ts`, `tests/graphql-server.security.test.ts` |
| #1445 | Cache invalidation (`indexer/src/cache.ts`) | `tests/cache.test.ts` |
| #1446 | Rate limits behind proxies and across replicas (`indexer/src/rateLimit.ts`) | `tests/rateLimit.distributed.test.ts`, `tests/rateLimit*.test.ts` |
| #1447 | Security headers (`indexer/src/securityHeaders.ts`) | `tests/security-headers.app.test.ts`, `tests/security-headers.test.ts` |

The Redis-backed suites (`cache.test.ts`, `rateLimit.distributed.test.ts`)
run against an in-memory model of the Redis commands, and also against a real
Redis server when one is configured for tests; see the comments at the top of
those files.

## GraphQL (#1444)

**Source of truth:** SQLite, read by the resolvers in `graphql.ts`. HTTP
`/graphql` is served by Yoga (`createGraphQLHandler`). The Apollo server in
`graphql/server.ts` serves only the WebSocket transport: its HTTP middleware
is mounted after the REST router's catch-all 404 and never receives requests.

What was found on `main`:

- Every HTTP request to `/graphql` through the Express app hung. The handler
  wrapper read the request with Fetch APIs (`headers.get`), which Express
  requests do not have.
- The depth limit was 1, so even `{ invoice(id: 1) { id } }` was rejected.
  The check only ran for JSON POSTs: GET requests skipped it. A malformed
  query threw instead of returning an error.
- `first: 0` crashed cursor construction, and a negative `first` or
  `topLPs(limit:)` reached SQLite as a negative `LIMIT`, which means "no
  limit". REST `GET /invoices?limit=-5` had the same hole.
- An `after` cursor that did not decode was ignored, so paging restarted from
  the first invoice and returned rows the client already had.
- Unfiltered `events` returned at most 1 000 rows with no indication that
  more existed.

Behaviour now:

| Case | Result |
| --- | --- |
| Normal query | Served over POST and GET |
| Malformed query | `400` with the syntax error |
| Depth > 5 (> 15 inside introspection) | `QUERY_TOO_DEEP` before any resolver runs |
| Cost > 2 500 | `QUERY_TOO_COMPLEX` before any resolver runs |
| `first` / `limit` ≤ 0 or not an integer | `BAD_USER_INPUT` |
| `first` / `limit` above 100 | Served as 100, with a `PAGE_SIZE_CLAMPED` warning |
| `after` that does not decode | `BAD_USER_INPUT` |
| Unfiltered `events` beyond 1 000 rows | First 1 000, with a `RESULT_TRUNCATED` warning giving the total |
| Repeated paging with `endCursor` | Every invoice exactly once, in id order |
| Same query over the WebSocket | Same depth and cost limits |

Warnings are in the response's `extensions.warnings`, as
`{ code, field, message, ... }` objects.

**Cost model:** every field costs 1. A root list field (`invoices`, `topLPs`,
`events`, `history`) multiplies the cost of its selection by its page size:
the literal argument, the default when absent, or 100 when it comes from a
variable, because validation cannot see variable values. A full 100-invoice
page with every field costs about 1 400, so a dashboard query fits, while
three full pages through aliases do not. Fragments are counted.

**Residual risk / maintainer decisions:**

- `history` and filtered `events` are not paginated. They return every
  matching row, priced as 100 in the cost model. Adding connections for them
  is a schema change for the maintainers to decide.
- The limits are per query. They do not bound how many queries a client
  sends; that is the rate limiter's job.
- `/graphql` now sends no CORS headers (see #1447 below). A browser app on
  another origin would need an explicit allow-list.

## Cache invalidation (#1445)

**Source of truth:** the SQLite `invoices` table. Redis (only when `REDIS_URL`
is set) holds copies of two REST responses for at most 30 seconds:
`invoice:<id>` (found invoices only) and `invoices:<hash>` (one per
filter/limit/cursor combination). Protocol totals, LP and freelancer stats
(reputations), top LPs and history are not stored in Redis: they are computed
from SQLite on each request and only carry HTTP `Cache-Control`.

Who invalidates:

| Change | Invalidation |
| --- | --- |
| Processed event that changed an invoice (`processor.ts`) | That invoice and all lists |
| Reorg rollback, including recovery after a restart (`poller.ts`) | Every affected invoice and all lists |
| Reconciliation correcting an invoice (`reconciliation.ts`) | That invoice and all lists |
| Archive run, API or scheduler (new) | Every cached invoice and list |
| Restore from archive (new) | That invoice and all lists |

What was found and fixed:

- **Stale write-back race.** A request could read an invoice, lose the CPU
  while the poller updated and invalidated it, then write the stale copy back
  for the full TTL. Every invalidation now bumps a generation counter first,
  and a request's cache write only lands if the generation is unchanged since
  it started reading. One Lua script does the check and the write atomically.
- Archive runs and restores did not invalidate at all.
- A corrupt cached value made the endpoint return `500`. It is now a miss and
  is deleted.
- List keys were found with `KEYS`, which blocks Redis on a large keyspace.
  They are now found with `SCAN`.
- Invalidation failures were swallowed silently. They are now logged and
  counted in `iln_cache_invalidation_failures_total`. Skipped stale writes are
  counted in `iln_cache_stale_writes_skipped_total`.

| Case | Result |
| --- | --- |
| Normal read | Served from Redis within 30 s, else from SQLite and cached |
| Repeated invalidation | Idempotent |
| Redis unset | No caching; every read goes to SQLite |
| Redis down on read or write | Miss, or skipped write; the response comes from SQLite |
| Redis down when a request starts | The request does not write to the cache |
| Redis down during invalidation | Logged and counted; stale copies expire within 30 s |
| Process killed between the SQLite commit and invalidation | Stale copies expire within 30 s |

**Residual risk:** the last two rows. The cache is best-effort, and the
30-second TTL is the bound on staleness. Lowering it trades Redis hit rate
for freshness.

## Rate limits (#1446)

**Source of truth:** `req.ip`, which Express derives from `X-Forwarded-For` by
trusting exactly `TRUST_PROXY_HOPS` proxies (default 1, Railway's edge). The
counter store is Redis when `REDIS_URL` is set, otherwise process memory.

What was found:

- The single trusted hop is correct for Railway. Client-written
  `X-Forwarded-For` entries sit to the left of the one Railway appends and are
  ignored, so forging or rotating them neither escapes the limit nor claims a
  whitelisted IP. This is now tested.
- The hop count was hard-coded. Behind a CDN plus Railway (2 hops), every
  client would share the CDN's bucket; with the indexer exposed directly
  (0 hops), clients could pick their own IP. It is now `TRUST_PROXY_HOPS`,
  validated at startup (0–10).
- Counters were per process, so N replicas allowed N times the limit. With
  `REDIS_URL` they are now shared: a fixed window per client, `INCR` and
  `PEXPIRE` in one Lua script.
- An IPv6 client could rotate through addresses in its own /64. Clients are
  now counted per /64 network.

| Case | Result |
| --- | --- |
| Normal client | 100 requests per minute, `RateLimit-*` headers |
| Over the limit | `429` with `Retry-After` |
| Forged or rotated `X-Forwarded-For` | Same bucket as the real address |
| Two clients behind the same proxy | Separate buckets |
| Several replicas with Redis | One shared limit |
| Redis down | Request allowed (fail open), logged, `iln_rate_limit_store_errors_total` |
| Health probes | Never limited |

**Maintainer decisions:**

- Fail open on Redis errors was chosen so a Redis outage cannot blocklist
  every client. The cost is that limits are not enforced during the outage.
- Set `TRUST_PROXY_HOPS` to the actual number of proxies in front of the
  indexer. This is the main way the limiter can be misconfigured.

## Security headers (#1447)

**Source of truth:** `applySecurityHeaders(app)`, registered first in
`createApp()`. The file is byte-for-byte shared with oracle-service and was not
changed.

Verified on the real app: REST, GraphQL (POST, GET, errors, limit rejections,
GraphiQL), the dashboard, Swagger UI, 404s, `429`s, the database-down `503`,
and Express's own error page (which replaces the CSP with the stricter
`default-src 'none'`). HSTS is sent only on HTTPS through the trusted proxy.

**Found and fixed:** Yoga enables CORS by default and reflected any `Origin`
with `Access-Control-Allow-Credentials: true` on `/graphql`. That contradicted
TM-2.2 ("no service grants cross-origin reads"). It was hidden only because
HTTP GraphQL was hanging (see #1444). CORS is now disabled on `/graphql`,
matching the REST API.

**Residual risk:** the CSP deliberately does not restrict scripts, so Swagger
UI and GraphiQL keep working. GraphiQL is disabled when
`NODE_ENV=production`.
