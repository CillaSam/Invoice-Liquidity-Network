import { invalidateAllInvoiceCaches } from './cache';
import { getDb, type InvoiceFilter } from './db';
import type { Invoice, ILNEvent } from './types';

/**
 * Connections that already have the archive database attached. Tracked per
 * connection (not a module-level boolean) so a replaced connection — e.g.
 * after `setDb()` — gets the archive attached instead of failing with
 * "no such table: archive.invoices".
 */
const attachedConnections = new WeakSet<object>();

/**
 * Return the database connection with the archive database attached.
 * Configured via process.env.ARCHIVE_DB_PATH (defaults to "archive.db").
 */
export function getArchiveDbConnection(): ReturnType<typeof getDb> {
  const db = getDb();
  if (!attachedConnections.has(db)) {
    const archivePath = process.env.ARCHIVE_DB_PATH || 'archive.db';

    // Attach the archive database file
    db.prepare(`ATTACH DATABASE ? AS archive`).run(archivePath);

    // Initialize the archive tables if they don't already exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive.invoices (
        id            INTEGER PRIMARY KEY,
        freelancer    TEXT    NOT NULL,
        payer         TEXT    NOT NULL,
        amount        TEXT    NOT NULL,
        due_date      INTEGER NOT NULL,
        discount_rate INTEGER NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'Pending',
        funder        TEXT,
        funded_at     INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS archive.events (
        event_id         TEXT    PRIMARY KEY,
        event_type       TEXT    NOT NULL,
        invoice_id       INTEGER NOT NULL,
        ledger           INTEGER NOT NULL,
        ledger_closed_at TEXT    NOT NULL,
        created_at       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS archive.idx_archive_invoices_created_at ON invoices(created_at);
      CREATE INDEX IF NOT EXISTS archive.idx_archive_invoices_status ON invoices(status);
      CREATE INDEX IF NOT EXISTS archive.idx_archive_events_invoice_id ON events(invoice_id);
      CREATE INDEX IF NOT EXISTS archive.idx_archive_events_created_at ON events(created_at);

      CREATE TABLE IF NOT EXISTS archive.archive_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        run_time      INTEGER NOT NULL,
        invoices_moved INTEGER NOT NULL,
        events_moved   INTEGER NOT NULL
      );
    `);

    attachedConnections.add(db);
  }
  return db;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Exclusive cut-off (ms) for an archival or purge run: rows with
 * `created_at < cutoff` are eligible, a row at exactly the cut-off is not.
 *
 * Rejects retention values that would silently widen or empty the range:
 * a negative value would put the cut-off in the future and move every row
 * (including rows written after the run started), and NaN/Infinity would
 * make the comparison false for every row.
 */
export function archiveCutoffMs(olderThanDays: number, now: number = Date.now()): number {
  if (typeof olderThanDays !== 'number' || !Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new RangeError(
      `olderThanDays must be a finite, non-negative number of days (got ${String(olderThanDays)})`
    );
  }
  if (!Number.isFinite(now)) {
    throw new RangeError(`now must be a finite timestamp in ms (got ${String(now)})`);
  }
  return now - olderThanDays * DAY_MS;
}

/**
 * Archive invoices and events older than the specified retention threshold (in days).
 * Moves eligible rows to the attached archive database and deletes them from the main database
 * within a single atomic transaction.
 *
 * Range boundaries (issue #1442):
 *  - The cut-off is computed once per run and every copy, delete and count in
 *    the transaction uses the same value, so a row cannot be copied without
 *    being deleted (duplicate) or deleted without being copied (gap).
 *  - The cut-off is exclusive (`created_at < cutoff`); `purgeOldArchiveData`
 *    uses the same rule.
 *  - Counts come from the INSERT statements' `changes`, not a separate
 *    COUNT, so the returned totals and `archive_runs` always match what was moved.
 *  - Re-running with the same cut-off is a no-op: moved rows are no longer in main.
 *  - Any failure rolls back the whole run; main keeps every row.
 *
 * `now` exists for deterministic tests and replays; production callers omit it.
 */
export function archiveOldData(
  olderThanDays: number = 90,
  now: number = Date.now()
): {
  invoicesMoved: number;
  eventsMoved: number;
} {
  const db = getArchiveDbConnection();
  const thresholdMs = archiveCutoffMs(olderThanDays, now);

  const txn = db.transaction(() => {
    // 1. Calculate how many records will be moved
    const invoicesToMove = db
      .prepare('SELECT COUNT(*) as count FROM main.invoices WHERE created_at < ?')
      .get(thresholdMs) as { count: number };
    const eventsToMove = db
      .prepare('SELECT COUNT(*) as count FROM main.events WHERE created_at < ?')
      .get(thresholdMs) as { count: number };

    if (invoicesToMove.count === 0 && eventsToMove.count === 0) {
      return { invoicesMoved: 0, eventsMoved: 0 };
    }

    // 2. Insert records into the archive database
    const invoicesCopied = db
      .prepare(
        `
      INSERT OR REPLACE INTO archive.invoices
      SELECT * FROM main.invoices WHERE created_at < ?
    `
      )
      .run(thresholdMs).changes;

    const eventsCopied = db
      .prepare(
        `
      INSERT OR REPLACE INTO archive.events
      SELECT * FROM main.events WHERE created_at < ?
    `
      )
      .run(thresholdMs).changes;

    // 3. Delete records from the main database
    const invoicesDeleted = db
      .prepare('DELETE FROM main.invoices WHERE created_at < ?')
      .run(thresholdMs).changes;
    const eventsDeleted = db
      .prepare('DELETE FROM main.events WHERE created_at < ?')
      .run(thresholdMs).changes;

    // Every row copied must be the row deleted; anything else would leave a
    // gap or a duplicate, so abort (and roll back) instead of committing it.
    if (invoicesCopied !== invoicesDeleted || eventsCopied !== eventsDeleted) {
      throw new Error(
        `[archive] range mismatch: copied ${invoicesCopied}/${eventsCopied} but deleted ${invoicesDeleted}/${eventsDeleted} (invoices/events)`
      );
    }

    // 4. Log the archival run
    db.prepare(
      `
      INSERT INTO archive.archive_runs (run_time, invoices_moved, events_moved)
      VALUES (?, ?, ?)
    `
    ).run(now, invoicesCopied, eventsCopied);

    return {
      invoicesMoved: invoicesCopied,
      eventsMoved: eventsCopied,
    };
  });

  return txn();
}

/**
 * Query the archived invoices using filters similar to active database queries.
 */
export function queryArchiveInvoices(filter: InvoiceFilter): Invoice[] {
  const db = getArchiveDbConnection();
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.freelancer) {
    clauses.push('freelancer = ?');
    params.push(filter.freelancer);
  }
  if (filter.payer) {
    clauses.push('payer = ?');
    params.push(filter.payer);
  }
  if (filter.funder) {
    clauses.push('funder = ?');
    params.push(filter.funder);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM archive.invoices ${where} ORDER BY id ASC`)
    .all(...params) as Invoice[];
}

/**
 * Query the archived events, optionally filtered by invoice_id.
 */
export function queryArchiveEvents(invoiceId?: number): ILNEvent[] {
  const db = getArchiveDbConnection();
  if (invoiceId !== undefined) {
    return db
      .prepare('SELECT * FROM archive.events WHERE invoice_id = ? ORDER BY ledger ASC')
      .all(invoiceId) as ILNEvent[];
  }
  return db
    .prepare('SELECT * FROM archive.events ORDER BY ledger ASC LIMIT 1000')
    .all() as ILNEvent[];
}

/**
 * Restore an invoice and its associated events from the archive database back to the main database.
 */
export function restoreInvoice(id: number): boolean {
  const db = getArchiveDbConnection();

  const txn = db.transaction(() => {
    // Check if the invoice exists in the archive database
    const invoice = db.prepare('SELECT * FROM archive.invoices WHERE id = ?').get(id) as
      | Invoice
      | undefined;
    if (!invoice) {
      return false;
    }

    // 1. Insert invoice back into main database
    db.prepare(
      `
      INSERT OR REPLACE INTO main.invoices
      SELECT * FROM archive.invoices WHERE id = ?
    `
    ).run(id);

    // 2. Insert associated events back into main database
    db.prepare(
      `
      INSERT OR REPLACE INTO main.events
      SELECT * FROM archive.events WHERE invoice_id = ?
    `
    ).run(id);

    // 3. Delete from archive database
    db.prepare('DELETE FROM archive.invoices WHERE id = ?').run(id);
    db.prepare('DELETE FROM archive.events WHERE invoice_id = ?').run(id);

    return true;
  });

  return txn();
}


/**
 * Purge invoices and events from the archive database older than the specified retention threshold (in days).
 * This permanently deletes data in accordance with the data-minimization and legal-hold lifecycle policy (e.g. 7 years).
 */
export function purgeOldArchiveData(
  olderThanDays: number = 2555,
  now: number = Date.now()
): {
  invoicesPurged: number;
  eventsPurged: number;
} {
  const db = getArchiveDbConnection();
  const thresholdMs = archiveCutoffMs(olderThanDays, now);

  const txn = db.transaction(() => {
    // 1. Calculate how many records will be purged
    const invoicesToPurge = db
      .prepare('SELECT COUNT(*) as count FROM archive.invoices WHERE created_at < ?')
      .get(thresholdMs) as { count: number };
    const eventsToPurge = db
      .prepare('SELECT COUNT(*) as count FROM archive.events WHERE created_at < ?')
      .get(thresholdMs) as { count: number };

    if (invoicesToPurge.count === 0 && eventsToPurge.count === 0) {
      return { invoicesPurged: 0, eventsPurged: 0 };
    }

    // 2. Permanently delete from archive database
    db.prepare('DELETE FROM archive.invoices WHERE created_at < ?').run(thresholdMs);
    db.prepare('DELETE FROM archive.events WHERE created_at < ?').run(thresholdMs);
    
    return {
      invoicesPurged: invoicesToPurge.count,
      eventsPurged: eventsToPurge.count,
    };
  });

  return txn();
}

export interface ArchiveStats {
  totalArchivedInvoices: number;
  totalArchivedEvents: number;
  lastArchivedAt: number | null;
  archivedVolume: string;
}

/**
 * Fetch statistics summarizing the state of the archived data.
 */
export function getArchiveStats(): ArchiveStats {
  const db = getArchiveDbConnection();

  const invoicesCount = db.prepare('SELECT COUNT(*) as count FROM archive.invoices').get() as {
    count: number;
  };
  const eventsCount = db.prepare('SELECT COUNT(*) as count FROM archive.events').get() as {
    count: number;
  };

  const lastRun = db
    .prepare('SELECT run_time FROM archive.archive_runs ORDER BY id DESC LIMIT 1')
    .get() as { run_time: number } | undefined;

  const volumeRow = db
    .prepare('SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) as total FROM archive.invoices')
    .get() as { total: number };

  return {
    totalArchivedInvoices: invoicesCount.count,
    totalArchivedEvents: eventsCount.count,
    lastArchivedAt: lastRun?.run_time ?? null,
    archivedVolume: volumeRow.total.toString(),
  };
}

let schedulerInterval: NodeJS.Timeout | null = null;

/**
 * Start the background archival scheduling loop.
 */
export function startArchivalScheduler(intervalMs = 86400000, olderThanDays = 90, purgeOlderThanDays = 2555) {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  const runTasks = () => {
    try {
      const res = archiveOldData(olderThanDays);
      if (res.invoicesMoved > 0) {
        // Archived invoices left the main table; drop their cached copies (#1445).
        void invalidateAllInvoiceCaches();
      }
      if (res.invoicesMoved > 0 || res.eventsMoved > 0) {
        console.log(
          `[archive] Automatic archive run completed. Archived ${res.invoicesMoved} invoices and ${res.eventsMoved} events.`
        );
      }
      const purgeRes = purgeOldArchiveData(purgeOlderThanDays);
      if (purgeRes.invoicesPurged > 0 || purgeRes.eventsPurged > 0) {
        console.log(
          `[archive] Automatic purge run completed. Permanently deleted ${purgeRes.invoicesPurged} invoices and ${purgeRes.eventsPurged} events.`
        );
      }
    } catch (err: any) {
      console.error(`[archive] Automatic archive/purge run failed: ${err.message}`);
    }
  };

  // Run once immediately on startup
  runTasks();

  // Schedule periodic runs
  schedulerInterval = setInterval(runTasks, intervalMs);
}
