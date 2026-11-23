/**
 * Archival range boundaries (issue #1442).
 *
 * Source of truth: `main.invoices` / `main.events` `created_at` (ms). A run
 * moves rows with `created_at < now - olderThanDays` into the attached
 * archive database in one transaction.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api';
import {
  archiveCutoffMs,
  archiveOldData,
  getArchiveDbConnection,
  getArchiveStats,
  purgeOldArchiveData,
  restoreInvoice,
} from '../src/archive';
import { createDb, getDb, setDb } from '../src/db';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 1);
const CUTOFF = NOW - 90 * DAY;

function seedInvoice(id: number, createdAt: number): void {
  getDb()
    .prepare(
      `INSERT INTO invoices
         (id, freelancer, payer, amount, due_date, discount_rate, status, funder, funded_at, created_at, updated_at)
       VALUES (?, 'GFREELANCER', 'GPAYER', '1000', 9999999999, 300, 'Pending', NULL, NULL, ?, ?)`
    )
    .run(id, createdAt, createdAt);
}

function seedEvent(id: string, invoiceId: number, createdAt: number): void {
  getDb()
    .prepare(
      `INSERT INTO events (event_id, event_type, invoice_id, ledger, ledger_closed_at, created_at)
       VALUES (?, 'submitted', ?, 1, '2024-01-01T00:00:00Z', ?)`
    )
    .run(id, invoiceId, createdAt);
}

function ids(table: string): number[] {
  return (getDb().prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: number }[]).map(
    (r) => r.id
  );
}

function eventIds(table: string): string[] {
  return (
    getDb().prepare(`SELECT event_id FROM ${table} ORDER BY event_id`).all() as {
      event_id: string;
    }[]
  ).map((r) => r.event_id);
}

beforeEach(() => {
  process.env.ARCHIVE_DB_PATH = ':memory:';
  setDb(createDb(':memory:'));
});

afterEach(() => {
  delete process.env.ARCHIVE_DB_PATH;
});

describe('archive cut-off boundary', () => {
  it('moves rows strictly older than the cut-off and keeps the row exactly at it', () => {
    seedInvoice(1, CUTOFF - 1);
    seedInvoice(2, CUTOFF);
    seedInvoice(3, CUTOFF + 1);
    seedEvent('e1', 1, CUTOFF - 1);
    seedEvent('e2', 2, CUTOFF);

    const result = archiveOldData(90, NOW);

    expect(result).toEqual({ invoicesMoved: 1, eventsMoved: 1 });
    expect(ids('main.invoices')).toEqual([2, 3]);
    expect(ids('archive.invoices')).toEqual([1]);
    expect(eventIds('main.events')).toEqual(['e2']);
    expect(eventIds('archive.events')).toEqual(['e1']);
  });

  it('partitions every row into exactly one database: no gaps, no duplicates', () => {
    for (let i = 1; i <= 50; i++) seedInvoice(i, CUTOFF + (i - 25) * 1000);

    archiveOldData(90, NOW);

    const main = ids('main.invoices');
    const archived = ids('archive.invoices');
    expect(main.filter((id) => archived.includes(id))).toEqual([]);
    expect([...main, ...archived].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1)
    );
    expect(archived).toHaveLength(24);
  });

  it('is a no-op when repeated with the same cut-off and records only one run', () => {
    seedInvoice(1, CUTOFF - DAY);

    expect(archiveOldData(90, NOW)).toEqual({ invoicesMoved: 1, eventsMoved: 0 });
    expect(archiveOldData(90, NOW)).toEqual({ invoicesMoved: 0, eventsMoved: 0 });

    const runs = getArchiveDbConnection()
      .prepare('SELECT run_time, invoices_moved FROM archive.archive_runs')
      .all();
    expect(runs).toEqual([{ run_time: NOW, invoices_moved: 1 }]);
    expect(getArchiveStats().totalArchivedInvoices).toBe(1);
  });

  it('records the run counts that match the rows actually moved', () => {
    seedInvoice(1, CUTOFF - DAY);
    seedInvoice(2, CUTOFF - 2 * DAY);
    seedEvent('e1', 1, CUTOFF - DAY);

    archiveOldData(90, NOW);

    const run = getArchiveDbConnection()
      .prepare('SELECT invoices_moved, events_moved FROM archive.archive_runs')
      .get();
    expect(run).toEqual({ invoices_moved: 2, events_moved: 1 });
  });

  it('a restored invoice is archived again by the next run without duplicating it', () => {
    seedInvoice(1, CUTOFF - DAY);
    seedEvent('e1', 1, CUTOFF - DAY);
    archiveOldData(90, NOW);

    expect(restoreInvoice(1)).toBe(true);
    expect(ids('main.invoices')).toEqual([1]);

    // created_at is preserved on restore, so the row is still past the cut-off.
    archiveOldData(90, NOW);
    expect(ids('main.invoices')).toEqual([]);
    expect(ids('archive.invoices')).toEqual([1]);
    expect(eventIds('archive.events')).toEqual(['e1']);
  });
});

describe('archive failure and invalid ranges', () => {
  it('rolls back the whole run when the archive write fails part-way', () => {
    seedInvoice(1, CUTOFF - DAY);
    seedEvent('e1', 1, CUTOFF - DAY);
    // Invoices copy fine, then the events copy fails.
    getArchiveDbConnection().exec('DROP TABLE archive.events');

    expect(() => archiveOldData(90, NOW)).toThrow(/no such table/);

    expect(ids('main.invoices')).toEqual([1]);
    expect(eventIds('main.events')).toEqual(['e1']);
    expect(ids('archive.invoices')).toEqual([]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects olderThanDays=%s instead of archiving every row or none',
    (days) => {
      seedInvoice(1, NOW);
      expect(() => archiveOldData(days, NOW)).toThrow(RangeError);
      expect(() => purgeOldArchiveData(days, NOW)).toThrow(RangeError);
      expect(ids('main.invoices')).toEqual([1]);
    }
  );

  it('accepts zero days (archive everything created before now)', () => {
    expect(archiveCutoffMs(0, NOW)).toBe(NOW);
    seedInvoice(1, NOW - 1);
    seedInvoice(2, NOW);
    expect(archiveOldData(0, NOW).invoicesMoved).toBe(1);
    expect(ids('main.invoices')).toEqual([2]);
  });

  it('purges archived rows with the same exclusive boundary', () => {
    const purgeNow = NOW + 2555 * DAY;
    seedInvoice(1, CUTOFF - 1);
    seedInvoice(2, NOW - 1);
    archiveOldData(0, NOW);

    // The purge cut-off is exactly NOW, and both archived invoices are older than it.
    expect(purgeOldArchiveData(2555, purgeNow)).toEqual({ invoicesPurged: 2, eventsPurged: 0 });

    seedInvoice(3, NOW);
    archiveOldData(0, NOW + 1);
    expect(purgeOldArchiveData(2555, purgeNow).invoicesPurged).toBe(0);
    expect(ids('archive.invoices')).toEqual([3]);
  });

  it('POST /v1/archive/run answers 400 for a negative retention and moves nothing', async () => {
    seedInvoice(1, Date.now());
    const app: Express = createApp();

    const res = await request(app).post('/v1/archive/run').send({ olderThanDays: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/olderThanDays/);
    expect(ids('main.invoices')).toEqual([1]);
  });
});
