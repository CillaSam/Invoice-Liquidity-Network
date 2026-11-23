import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

const resolverSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/db', async () => {
  const actual = await vi.importActual<typeof import('../src/db')>('../src/db');
  return {
    ...actual,
    getProtocolStats: (...args: unknown[]) => {
      resolverSpy(...args);
      return actual.getProtocolStats();
    },
  };
});

import { createApp } from '../src/api';
import { createDb, setDb, upsertInvoice, getDb } from '../src/db';
import {
  EVENTS_UNFILTERED_CAP,
  MAX_GRAPHQL_COST,
  MAX_GRAPHQL_DEPTH,
  createGraphQLHandler,
  decodeInvoiceCursor,
} from '../src/graphql';
import type { Invoice } from '../src/types';

let app: Express;

function invoice(id: number): Invoice {
  return {
    id,
    freelancer: 'GFREELANCER',
    payer: 'GPAYER',
    amount: String(1000 * id),
    due_date: 1_900_000_000,
    discount_rate: 300,
    status: 'Pending',
    funder: null,
    funded_at: null,
    created_at: 1_700_000_000 + id,
    updated_at: 1_700_000_000 + id,
  } as Invoice;
}

beforeEach(() => {
  resolverSpy.mockReset();
  setDb(createDb(':memory:'));
  app = createApp();
});

/** POST through the real Express app, exactly like a client. */
function post(query: string, variables?: Record<string, unknown>) {
  return request(app)
    .post('/graphql')
    .set('content-type', 'application/json')
    .set('accept', 'application/graphql-response+json')
    .send({ query, variables });
}

const FULL_NODE = 'id freelancer payer amount dueDate discountRate status funder fundedAt createdAt updatedAt';

describe('GraphQL over HTTP (#1444)', () => {
  it('answers ordinary queries through the Express app (they used to hang)', async () => {
    upsertInvoice(invoice(1));
    const res = await post('{ invoice(id: 1) { id amount status } protocolStats { totalInvoices } }');
    expect(res.status).toBe(200);
    expect(res.body.data.invoice).toEqual({ id: 1, amount: '1000', status: 'Pending' });
    expect(res.body.data.protocolStats.totalInvoices).toBe(1);
  });

  it('accepts a full invoices page with every field', async () => {
    const res = await post(
      `{ invoices(first: 100) { edges { cursor node { ${FULL_NODE} } } pageInfo { hasNextPage endCursor } } }`
    );
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it('returns 400 for a malformed query instead of throwing', async () => {
    const res = await post('{ invoice(');
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toMatch(/Syntax Error/);
  });
});

describe('GraphQL depth and cost limits (#1444)', () => {
  it('rejects multiplying full pages through aliases before any resolver runs', async () => {
    const page = `invoices(first: 100) { edges { node { ${FULL_NODE} } } }`;
    const res = await post(`{ a: ${page} b: ${page} c: protocolStats { totalInvoices } }`);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
    expect(res.body.errors[0].extensions.cost).toBeGreaterThan(MAX_GRAPHQL_COST);
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  it('counts fragments, so moving fields into one does not hide their cost', async () => {
    const res = await post(`
      fragment Full on Invoice { ${FULL_NODE} }
      { a: invoices { edges { node { ...Full } } } b: invoices { edges { node { ...Full } } } }
    `);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('assumes the worst case when the page size comes from a variable', async () => {
    const page = `invoices(first: $n) { edges { node { ${FULL_NODE} } } }`;
    const res = await post(`query($n: Int) { a: ${page} b: ${page} }`, { n: 1 });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('prices small pages cheaply, so many of them are allowed', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => `p${i}: invoices(first: 5) { edges { node { id amount } } }`);
    const res = await post(`{ ${pages.join(' ')} }`);
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it('applies the same limits to GET requests', async () => {
    const page = `invoices(first: 100) { edges { node { ${FULL_NODE} } } }`;
    const res = await request(app)
      .get('/graphql')
      .query({ query: `{ a: ${page} b: ${page} }` })
      .set('accept', 'application/graphql-response+json');
    expect(res.status).toBe(400);
    expect(res.body.errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('rejects queries nested beyond the depth limit', async () => {
    // Introspection is the only way to nest deeply in this schema; it has its
    // own allowance, so go past that one.
    let nested = 'name';
    for (let i = 0; i < 16; i++) nested = `ofType { ${nested} }`;
    const res = await post(`{ __type(name: "Invoice") { fields { type { ${nested} } } } }`);
    expect(res.status).toBe(400);
    expect(res.body.errors[0].extensions.code).toBe('QUERY_TOO_DEEP');
  });

  it('allows GraphiQL-style introspection', async () => {
    const res = await post(
      '{ __schema { types { name fields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } } } } }'
    );
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
  });

  it('keeps the field depth limit above the schema\'s deepest real path', () => {
    // invoices { edges { node { id } } } is depth 4.
    expect(MAX_GRAPHQL_DEPTH).toBeGreaterThanOrEqual(4);
  });

  it('is also a Fetch handler for direct use', async () => {
    const res = await createGraphQLHandler().fetch(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ protocolStats { totalInvoices } }' }),
      })
    );
    expect(res.status).toBe(200);
  });
});

describe('GraphQL pagination invariants (#1444)', () => {
  beforeEach(() => {
    for (let id = 1; id <= 5; id++) upsertInvoice(invoice(id));
  });

  const page = (args: string) =>
    post(`{ invoices(${args}) { edges { cursor node { id } } pageInfo { hasNextPage endCursor } } }`);

  it('pages through every invoice exactly once', async () => {
    const seen: number[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await page(after ? `first: 2, after: "${after}"` : 'first: 2');
      expect(res.status).toBe(200);
      const { edges, pageInfo } = res.body.data.invoices;
      seen.push(...edges.map((e: { node: { id: number } }) => e.node.id));
      if (!pageInfo.hasNextPage) break;
      expect(pageInfo.endCursor).toBe(edges[edges.length - 1].cursor);
      after = pageInfo.endCursor;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it.each(['0', '-5'])('rejects first: %s instead of crashing or returning every row', async (first) => {
    const res = await page(`first: ${first}`);
    expect(res.body.data).toBeNull();
    expect(res.body.errors[0].extensions).toMatchObject({ code: 'BAD_USER_INPUT', argument: 'first' });
  });

  it('rejects an after cursor that does not decode instead of restarting from the first invoice', async () => {
    const res = await page('first: 2, after: "not-a-cursor!"');
    expect(res.body.data).toBeNull();
    expect(res.body.errors[0].extensions).toMatchObject({ code: 'BAD_USER_INPUT', argument: 'after' });
  });

  it('serves first above the maximum as a full page and says so', async () => {
    const res = await page('first: 1000');
    expect(res.status).toBe(200);
    expect(res.body.data.invoices.edges).toHaveLength(5);
    expect(res.body.extensions.warnings).toEqual([
      expect.objectContaining({ code: 'PAGE_SIZE_CLAMPED', field: 'first', requested: 1000, served: 100 }),
    ]);
  });

  it('sends no warnings for an ordinary page', async () => {
    const res = await page('first: 2');
    expect(res.body.extensions?.warnings).toBeUndefined();
  });

  it.each(['0', '-1'])('rejects topLPs(limit: %s), which SQLite would read as no limit', async (limit) => {
    const res = await post(`{ topLPs(limit: ${limit}) { address } }`);
    expect(res.body.errors[0].extensions).toMatchObject({ code: 'BAD_USER_INPUT', argument: 'limit' });
  });

  it('decodes only cursors it issued', () => {
    expect(decodeInvoiceCursor(Buffer.from('42').toString('base64'))).toBe(42);
    expect(decodeInvoiceCursor(Buffer.from('4x2').toString('base64'))).toBeNull();
    expect(decodeInvoiceCursor('###')).toBeNull();
  });
});

describe('unfiltered events are never silently short (#1444)', () => {
  it('warns with the total when the unfiltered list is capped', async () => {
    const insert = getDb().prepare(
      `INSERT INTO events (event_id, event_type, invoice_id, ledger, ledger_closed_at, created_at)
       VALUES (?, 'submitted', 1, ?, '2026-01-01T00:00:00Z', 0)`
    );
    getDb().transaction(() => {
      for (let i = 0; i < EVENTS_UNFILTERED_CAP + 5; i++) insert.run(`evt-${i}`, i);
    })();

    const res = await post('{ events { eventId } }');
    expect(res.status).toBe(200);
    expect(res.body.data.events).toHaveLength(EVENTS_UNFILTERED_CAP);
    expect(res.body.extensions.warnings).toEqual([
      expect.objectContaining({ code: 'RESULT_TRUNCATED', field: 'events', returned: 1000, total: 1005 }),
    ]);
  });
});
