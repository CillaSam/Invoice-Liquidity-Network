/**
 * Streaming export cancellation and failure behavior (issue #1443).
 *
 * Verified behavior:
 *  - Partial exports: a page cut off by a row budget resumes with no gaps or
 *    duplicates, including when the cut lands inside a ledger that holds
 *    several events (events used to resume at `ledger > N` and drop the rest
 *    of ledger N).
 *  - Cancelled streams: if the sink throws mid-stream (client gone, socket
 *    destroyed) the SQLite iterator is released, so the shared connection is
 *    not left busy for the writers that follow.
 *  - Failed databases: an async job whose query throws is marked `failed`,
 *    keeps no partial content, and is evicted by the TTL sweep.
 *  - Repeated runs: processing a job that is no longer pending is a no-op.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import { createDb, getDb, setDb } from '../src/db';
import {
  _clearJobs,
  createExportJob,
  decodeExportCursor,
  encodeExportCursor,
  getExportContent,
  getExportJob,
  processExportJob,
  streamEventsExport,
  streamInvoicesExport,
  type ExportSink,
} from '../src/export';

const ENVS = ['EXPORT_PAGE_MAX_ROWS', 'EXPORT_JOB_TTL_SECONDS'] as const;
let saved: Record<string, string | undefined> = {};

function collectingSink(): ExportSink & { chunks: string[]; headers: Record<string, string> } {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  return {
    chunks,
    headers,
    write: (c: string) => chunks.push(c),
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  };
}

/** Five ledgers with three events each: ids `e-<ledger>-<n>`. */
function seedEventsSharingLedgers(): string[] {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO events (event_id, event_type, invoice_id, ledger, ledger_closed_at, created_at)
     VALUES (?, 'submitted', ?, ?, '2024-01-01T00:00:00Z', ?)`
  );
  const ids: string[] = [];
  db.transaction(() => {
    for (let ledger = 100; ledger < 105; ledger++) {
      // Inserted in reverse so rowid order differs from event_id order.
      for (let n = 3; n >= 1; n--) {
        const id = `e-${ledger}-${n}`;
        insert.run(id, ledger, ledger, Date.now());
        ids.push(id);
      }
    }
  })();
  return ids.sort();
}

function seedInvoices(count: number): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO invoices
       (id, freelancer, payer, amount, due_date, discount_rate, status, funder, funded_at, created_at, updated_at)
     VALUES (?, 'GFREELANCER', 'GPAYER', '100000000', 9999999999, 300, 'Pending', NULL, NULL, ?, ?)`
  );
  const now = Date.now();
  db.transaction(() => {
    for (let id = 1; id <= count; id++) insert.run(id, now, now);
  })();
}

function csvEventIds(text: string): string[] {
  return text
    .trim()
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => line.split(',')[0]);
}

beforeEach(() => {
  setDb(createDb(':memory:'));
  _clearJobs();
  saved = {};
  for (const key of ENVS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENVS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('event export cursor across a shared ledger', () => {
  it('keeps old two-part cursors decodable and round-trips event ids containing colons', () => {
    expect(decodeExportCursor(encodeExportCursor(7, 3))).toEqual({ id: 7, rowsBefore: 3 });
    expect(decodeExportCursor(encodeExportCursor(7, 0, 'a:b:c'))).toEqual({
      id: 7,
      rowsBefore: 0,
      afterKey: 'a:b:c',
    });
  });

  it('resumes a page cut mid-ledger with no gaps or duplicates (direct stream)', () => {
    const all = seedEventsSharingLedgers();
    const seen: string[] = [];
    let cursor: string | undefined;

    // 4 rows per page never lines up with the 3-events-per-ledger boundary.
    for (let page = 0; page < 10; page++) {
      const sink = collectingSink();
      const result = streamEventsExport(sink, { cursor }, 'csv', {
        maxRows: 4,
        maxBytes: 1e9,
        maxMs: 1e9,
        rowsBefore: decodeExportCursor(cursor)?.rowsBefore,
      });
      seen.push(...csvEventIds(sink.chunks.join('')));
      if (!result.truncated) break;
      expect(result.resumptionCursor).toBeDefined();
      cursor = result.resumptionCursor;
    }

    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(all.length);
  });

  it('resumes through GET /v1/export/events with no gaps or duplicates', async () => {
    const all = seedEventsSharingLedgers();
    process.env.EXPORT_PAGE_MAX_ROWS = '4';
    const app: Express = createApp();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res = await request(app).get(`/v1/export/events?format=csv${query}`);
      expect(res.status).toBe(200);
      seen.push(...csvEventIds(res.text));
      cursor = res.headers['x-export-resumption-cursor'];
      if (!cursor) break;
    }

    expect(seen).toEqual(all);
  });

  it('still honours a legacy ledger-only cursor (resumes after the whole ledger)', () => {
    seedEventsSharingLedgers();
    const sink = collectingSink();
    streamEventsExport(sink, { cursor: encodeExportCursor(102, 0) }, 'csv', {
      maxRows: 100,
      maxBytes: 1e9,
      maxMs: 1e9,
    });
    const ids = csvEventIds(sink.chunks.join(''));
    expect(ids[0]).toBe('e-103-1');
    expect(ids).toHaveLength(6);
  });
});

describe('cancelled streams', () => {
  it('releases the statement when the sink throws mid-stream (client disconnect)', () => {
    // Enough rows to pass the 64 KB flush threshold so the sink is touched mid-query.
    seedInvoices(2_000);
    let writes = 0;
    const sink: ExportSink = {
      write: () => {
        writes++;
        throw new Error('socket destroyed');
      },
      setHeader: () => undefined,
    };

    expect(() =>
      streamInvoicesExport(sink, {}, 'csv', { maxRows: 10_000, maxBytes: 1e9, maxMs: 1e9 })
    ).toThrow('socket destroyed');
    expect(writes).toBe(1);

    // A leaked iterator would leave the connection busy and block writes.
    expect(() => getDb().prepare('DELETE FROM invoices WHERE id = 1').run()).not.toThrow();
    expect(() => getDb().close()).not.toThrow();
    setDb(createDb(':memory:'));
  });
});

describe('async jobs on a failed database', () => {
  it('marks the job failed with no partial content and evicts it after the TTL', async () => {
    seedInvoices(5);
    const job = createExportJob('invoices', 'csv', {});
    getDb().exec('DROP TABLE invoices');

    await processExportJob(job.jobId);

    const failed = getExportJob(job.jobId);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/no such table/);
    expect(failed?.completedAt).toBeTypeOf('number');
    expect(getExportContent(job.jobId)).toBeUndefined();

    process.env.EXPORT_JOB_TTL_SECONDS = '0.001';
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(getExportJob(job.jobId)).toBeUndefined();
  });

  it('does not re-run or overwrite a job that already finished', async () => {
    seedInvoices(3);
    const job = createExportJob('invoices', 'csv', {});
    await processExportJob(job.jobId);
    const done = getExportJob(job.jobId);
    expect(done?.status).toBe('done');
    const content = getExportContent(job.jobId);
    const completedAt = done?.completedAt;

    // The database disappears; a repeated call must leave the finished job alone.
    getDb().exec('DROP TABLE invoices');
    await processExportJob(job.jobId);

    expect(getExportJob(job.jobId)?.status).toBe('done');
    expect(getExportJob(job.jobId)?.completedAt).toBe(completedAt);
    expect(getExportContent(job.jobId)).toBe(content);
  });
});
