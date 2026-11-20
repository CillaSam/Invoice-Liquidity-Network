#!/usr/bin/env node
/**
 * Redemption simulation for stressed liquidity (#1313).
 *
 * Reference: docs/trust-liquidity-model.md §6 (Simultaneous LP Withdrawal
 * Stress Analysis). That section publishes a normalized withdrawal-stress
 * table against a hypothetical pooled deployment. This script reproduces
 * those numbers from first principles, extends them with the FCFS vs.
 * pro-rata allocation branch called out in §6.2, and exits non-zero if the
 * computed outcomes drift from the published model — turning the docs
 * table into an executable, versioned regression check instead of a
 * frozen paragraph.
 *
 * Usage
 *   node scripts/redemption-stress-simulation.mjs [--json] [--out FILE]
 *     --json   Emit machine-readable JSON instead of the pretty table.
 *     --out F  Write the output to F (default: stdout).
 *
 * This runs offline in CI (no network, no Stellar RPC, no DB). It is a
 * liquidity-accounting simulation, not a forecast. It excludes defaults,
 * fees, token depegs, and secondary-market sales — matching the explicit
 * scope of §6.2 so the outputs are directly comparable.
 */

import { writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';

/**
 * Baseline pool from §6.2:
 *   - 100 units of LP capital immediately before a panic.
 *   - 60 units committed to invoices (locked).
 *   - 40 units idle cash.
 * No repayments, asset sales, or new deposits during the window.
 */
export const BASELINE_POOL = Object.freeze({
  totalCapital: 100,
  committed: 60,
  idleCash: 40,
});

/** Published scenarios from the §6.2 table. */
export const PUBLISHED_SCENARIOS = Object.freeze([
  { severity: 0.25, requestSize: 25, immediatelyPayable: 25, remaining: 0, immediateFulfilment: 1.0 },
  { severity: 0.5,  requestSize: 50, immediatelyPayable: 40, remaining: 10, immediateFulfilment: 0.8 },
  { severity: 0.75, requestSize: 75, immediatelyPayable: 40, remaining: 35, immediateFulfilment: 0.5333333333 },
  { severity: 0.9,  requestSize: 90, immediatelyPayable: 40, remaining: 50, immediateFulfilment: 0.4444444444 },
]);

/**
 * Pro-rata allocation: every caller gets the same fraction of their
 * request. This matches §7.4 (Epoch Processing Algorithm) and §7.1.2 (Pro
 * rata fairness). Returns a flat allocation plan.
 *
 * @param {number} idleCash
 * @param {Array<{id: string, amount: number}>} requests
 * @returns {{paid: Record<string, number>, totalPaid: number, totalRequested: number, fillRatio: number}}
 */
export function proRataAllocation(idleCash, requests) {
  const totalRequested = requests.reduce((acc, r) => acc + r.amount, 0);
  const payable = Math.min(idleCash, totalRequested);
  const ratio = totalRequested === 0 ? 1 : payable / totalRequested;
  const paid = Object.fromEntries(requests.map((r) => [r.id, r.amount * ratio]));
  return { paid, totalPaid: payable, totalRequested, fillRatio: ratio };
}

/**
 * First-come-first-served allocation: callers are satisfied fully in
 * submission order until cash is exhausted. §6.2 flags this as the worst
 * case for late callers.
 */
export function fcfsAllocation(idleCash, requests) {
  let remaining = idleCash;
  const paid = {};
  let totalPaid = 0;
  for (const r of requests) {
    const grant = Math.min(remaining, r.amount);
    paid[r.id] = grant;
    totalPaid += grant;
    remaining -= grant;
  }
  const totalRequested = requests.reduce((acc, r) => acc + r.amount, 0);
  return {
    paid,
    totalPaid,
    totalRequested,
    fillRatio: totalRequested === 0 ? 1 : totalPaid / totalRequested,
  };
}

/**
 * Reproduce one row of the §6.2 table from the baseline pool using an
 * equal-size pro-rata model (every LP requests `requestSize / N` and gets
 * the same fill ratio). The "immediately payable" column is the floor of
 * the idle cash and total requested; "remaining" is what gets queued.
 */
export function computeStressRow(severity, { idleCash = BASELINE_POOL.idleCash } = {}) {
  const requestSize = Math.round(severity * BASELINE_POOL.totalCapital);
  const immediatelyPayable = Math.min(idleCash, requestSize);
  const remaining = Math.max(0, requestSize - immediatelyPayable);
  const immediateFulfilment = requestSize === 0 ? 1 : immediatelyPayable / requestSize;
  return { severity, requestSize, immediatelyPayable, remaining, immediateFulfilment };
}

/**
 * Compare computed row against the published row. Returns `null` when
 * they agree within tolerance, or a diff object otherwise.
 */
export function diffRow(published, computed, tolerance = 1e-9) {
  const fields = ['requestSize', 'immediatelyPayable', 'remaining', 'immediateFulfilment'];
  const diffs = {};
  for (const f of fields) {
    if (Math.abs(published[f] - computed[f]) > tolerance) {
      diffs[f] = { published: published[f], computed: computed[f] };
    }
  }
  return Object.keys(diffs).length === 0 ? null : diffs;
}

/**
 * Full stress sweep. Reproduces the §6.2 table, plus a 100% severity row
 * (everyone exits simultaneously — the hardest case) and a FCFS branch so
 * the first/last caller asymmetry is explicit in the output.
 */
export function runStressSweep({ pool = BASELINE_POOL } = {}) {
  const severities = [0.25, 0.5, 0.75, 0.9, 1.0];
  const rows = severities.map((s) => computeStressRow(s, pool));

  // Reproduce published rows exactly.
  const reconciliation = PUBLISHED_SCENARIOS.map((p) => {
    const c = rows.find((r) => r.severity === p.severity);
    return { severity: p.severity, diff: diffRow(p, c) };
  });

  // FCFS branch: 4 equal-size callers at 90% total severity.
  const fcfsRequests = Array.from({ length: 4 }, (_, i) => ({
    id: `lp-${i + 1}`,
    amount: (0.9 * pool.totalCapital) / 4,
  }));
  const fcfs = fcfsAllocation(pool.idleCash, fcfsRequests);
  const prorata = proRataAllocation(pool.idleCash, fcfsRequests);

  return { pool, rows, reconciliation, fcfs, prorata };
}

function formatTable(rows) {
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  const lines = [
    '| severity | request | immediately payable | remaining queued | immediate fulfilment |',
    '|---------:|--------:|--------------------:|-----------------:|---------------------:|',
  ];
  for (const r of rows) {
    lines.push(
      `| ${pct(r.severity)} | ${r.requestSize.toFixed(0)} | ${r.immediatelyPayable.toFixed(2)} | ${r.remaining.toFixed(2)} | ${pct(r.immediateFulfilment)} |`,
    );
  }
  return lines.join('\n');
}

function formatReport(result) {
  const lines = [];
  lines.push('# Redemption stress simulation (§6.2)');
  lines.push('');
  lines.push(`Pool: total ${result.pool.totalCapital}, committed ${result.pool.committed}, idle ${result.pool.idleCash}.`);
  lines.push('');
  lines.push(formatTable(result.rows));
  lines.push('');
  lines.push('## Reconciliation against docs/trust-liquidity-model.md §6.2');
  for (const r of result.reconciliation) {
    const ok = r.diff === null;
    lines.push(`- severity ${(r.severity * 100).toFixed(0)}%: ${ok ? 'MATCH' : 'DRIFT'} ${ok ? '' : JSON.stringify(r.diff)}`);
  }
  lines.push('');
  lines.push('## FCFS vs pro-rata branch (90% severity, 4 equal callers)');
  lines.push('');
  lines.push('### Pro-rata (§7.1.2 fairness invariant)');
  for (const [id, paid] of Object.entries(result.prorata.paid)) {
    lines.push(`- ${id}: paid ${paid.toFixed(2)}`);
  }
  lines.push(`- total paid: ${result.prorata.totalPaid.toFixed(2)}`);
  lines.push(`- fill ratio: ${(result.prorata.fillRatio * 100).toFixed(2)}%`);
  lines.push('');
  lines.push('### FCFS (contra-indicated allocation order)');
  for (const [id, paid] of Object.entries(result.fcfs.paid)) {
    lines.push(`- ${id}: paid ${paid.toFixed(2)}`);
  }
  lines.push(`- total paid: ${result.fcfs.totalPaid.toFixed(2)}`);
  lines.push(`- fill ratio (overall): ${(result.fcfs.fillRatio * 100).toFixed(2)}%`);
  lines.push('');
  lines.push('_This simulation excludes defaults, fees, token depegs, and secondary-market sales._');
  return lines.join('\n');
}

function parseArgs(args) {
  const out = { json: false, outFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') out.json = true;
    else if (args[i] === '--out' && args[i + 1]) {
      out.outFile = args[i + 1];
      i++;
    }
  }
  return out;
}

async function main() {
  const { json, outFile } = parseArgs(argv.slice(2));
  const result = runStressSweep();

  const payload = json ? JSON.stringify(result, null, 2) : formatReport(result);
  if (outFile) writeFileSync(outFile, payload);
  else stdout.write(`${payload}\n`);

  const hasDrift = result.reconciliation.some((r) => r.diff !== null);
  if (hasDrift) {
    stdout.write('\nERROR: computed rows drifted from the published §6.2 table.\n');
    exit(1);
  }
}

// Only run when invoked directly — this module is also imported by the
// synthetic test suite.
const invokedDirectly = import.meta.url === `file://${argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    exit(2);
  });
}
