import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import type { Express } from 'express';
import { CONFIG } from '../src/config';
import { createApp } from '../src/api';
import { createDb, setDb, getDb } from '../src/db';
import { HSTS_HEADER, SECURITY_HEADERS } from '../src/securityHeaders';

/**
 * Security headers on the real indexer app (#1447). security-headers.test.ts
 * pins the middleware on a stand-in app; this file checks every kind of
 * response createApp() actually produces: REST, GraphQL (POST, GET, GraphiQL,
 * errors, preflight), the dashboard, Swagger UI, 404s, Express's own error
 * page, rate-limit 429s and a database-down 503.
 */

const config = CONFIG as unknown as { rateLimitMax: number; rateLimitWhitelist: string[] };

let app: Express;

beforeEach(() => {
  config.rateLimitMax = 1_000;
  config.rateLimitWhitelist = [];
  setDb(createDb(':memory:'));
  app = createApp();
});

function expectPolicy(res: Response, { expressErrorPage = false } = {}) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // Express's built-in error page sets its own, stricter CSP.
    if (expressErrorPage && name === 'Content-Security-Policy') {
      expect(res.headers['content-security-policy']).toBe("default-src 'none'");
      continue;
    }
    expect(res.headers[name.toLowerCase()], `${name} on ${res.status}`).toBe(value);
  }
  expect(res.headers['x-powered-by']).toBeUndefined();
  // TM-2.2: no service grants cross-origin reads.
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
  expect(res.headers['access-control-allow-credentials']).toBeUndefined();
}

const EVIL = 'https://evil.example';
const gql = (query: string) =>
  request(app).post('/graphql').set('content-type', 'application/json').set('origin', EVIL).send({ query });

describe('indexer security headers on every surface (#1447)', () => {
  it('REST success and 404', async () => {
    expectPolicy(await request(app).get('/v1/stats').set('origin', EVIL));
    const missing = await request(app).get('/v1/nope');
    expect(missing.status).toBe(404);
    expectPolicy(missing);
  });

  it('GraphQL POST, GET, errors and limit rejections', async () => {
    expectPolicy(await gql('{ protocolStats { totalInvoices } }'));
    expectPolicy(await gql('{ nope'));
    const page = 'invoices(first: 100) { edges { node { id freelancer payer amount status } } }';
    const tooComplex = await gql(`{ a: ${page} b: ${page} c: ${page} d: ${page} e: ${page} }`);
    expect(tooComplex.body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
    expectPolicy(tooComplex);
    expectPolicy(
      await request(app)
        .get('/graphql')
        .query({ query: '{ protocolStats { totalInvoices } }' })
        .set('origin', EVIL)
    );
  });

  it('GraphiQL page (non-production)', async () => {
    const res = await request(app).get('/graphql').set('accept', 'text/html');
    expect(res.status).toBe(200);
    expectPolicy(res);
  });

  it('does not grant CORS to arbitrary origins on /graphql (Yoga used to reflect them with credentials)', async () => {
    const preflight = await request(app)
      .options('/graphql')
      .set('origin', EVIL)
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'content-type');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    expect(preflight.headers['access-control-allow-methods']).toBeUndefined();
    expect(preflight.headers['x-frame-options']).toBe('DENY');
  });

  it('dashboard and Swagger UI', async () => {
    expectPolicy(await request(app).get('/dashboard'));
    const docs = await request(app).get('/docs/');
    expect(docs.status).toBe(200);
    expectPolicy(docs);
  });

  it("Express's own error page for a malformed JSON body", async () => {
    const res = await request(app)
      .post('/v1/archive/run')
      .set('content-type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expectPolicy(res, { expressErrorPage: true });
  });

  it('rate-limit 429s', async () => {
    config.rateLimitMax = 1;
    const limited = createApp();
    await request(limited).get('/v1/stats');
    const res = await request(limited).get('/v1/stats');
    expect(res.status).toBe(429);
    expectPolicy(res);
  });

  it('database-down 503 from the health check', async () => {
    getDb().close();
    const res = await request(app).get('/v1/health');
    expect(res.status).toBe(503);
    expectPolicy(res);
  });

  it('HSTS only on HTTPS requests through the trusted proxy', async () => {
    const https = await request(app).get('/v1/stats').set('X-Forwarded-Proto', 'https');
    expect(https.headers['strict-transport-security']).toBe(HSTS_HEADER);
    expect((await request(app).get('/v1/stats')).headers['strict-transport-security']).toBeUndefined();
  });
});
