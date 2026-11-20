#!/usr/bin/env node
/**
 * Exercise indexer rollback without contract pause (#1316).
 *
 * The rehearsal rolls the indexer back to the last checkpoint at or before a
 * simulated divergence, replays the subsequent ledger events, and verifies
 * the rebuilt checksum. The contract pause sentinel is an input to the
 * control: if it is set, the rehearsal is invalid because the exercise is
 * specifically meant to prove recovery while the contract keeps running.
 *
 * Pure and deterministic: the plan hash is stable across replay/restart,
 * and a failed replay leaves the indexer pinned at the safe checkpoint
 * rather than advancing on incomplete data.
 */

import { createHash } from 'node:crypto';

export const INDEXER_ROLLBACK_METRICS = Object.freeze({
  rehearsals: 'iln_indexer_rollback_rehearsals_total',
  failures: 'iln_indexer_rollback_failures_total',
  safeCheckpointLedger: 'iln_indexer_safe_checkpoint_ledger',
});

/**
 * @param {object} input checkpoints, divergence point and replay events
 * @returns {object} rollback plan, outcome codes and deterministic plan hash
 */
export function rehearseIndexerRollback(input = {}) {
  const contractPaused = input.contractPaused === true;
  const divergenceLedger = input.divergenceLedger;
  const checkpoints = Array.isArray(input.checkpoints) ? [...input.checkpoints] : [];
  const replayEvents = Array.isArray(input.replayEvents) ? [...input.replayEvents] : [];
  const codes = [];

  if (contractPaused) {
    codes.push('CONTRACT_PAUSED_ROLLBACK_NOT_VALID');
  }
  if (!Number.isFinite(divergenceLedger)) {
    codes.push('DIVERGENCE_LEDGER_UNAVAILABLE');
  }

  const ordered = checkpoints
    .filter((checkpoint) => checkpoint && Number.isFinite(checkpoint.ledger))
    .sort((a, b) => a.ledger - b.ledger);
  const candidates = Number.isFinite(divergenceLedger)
    ? ordered.filter((checkpoint) => checkpoint.ledger <= divergenceLedger)
    : [];
  const target = candidates.length > 0 ? candidates[candidates.length - 1] : null;

  if (!target && Number.isFinite(divergenceLedger)) {
    codes.push('NO_SAFE_CHECKPOINT');
  }

  const replayed = target
    ? replayEvents
        .filter((event) => event && Number.isFinite(event.ledger) && event.ledger > target.ledger)
        .sort((a, b) => a.ledger - b.ledger)
    : [];

  if (target && Number.isFinite(divergenceLedger)) {
    const expectedLedgers = [];
    for (let ledger = target.ledger + 1; ledger <= divergenceLedger; ledger += 1) {
      expectedLedgers.push(ledger);
    }
    const actualLedgers = replayed.map((event) => event.ledger);
    if (JSON.stringify(actualLedgers) !== JSON.stringify(expectedLedgers)) {
      codes.push('REPLAY_SEQUENCE_GAP');
    }
  }

  const finalChecksum =
    replayed.length > 0 ? replayed[replayed.length - 1].checksumAfter : target?.checksum ?? null;
  if (target && input.expectedChecksum !== undefined && finalChecksum !== input.expectedChecksum) {
    codes.push('REPLAY_CHECKSUM_MISMATCH');
  }

  const plan = {
    contractPaused,
    contractPauseUsed: false,
    rolledBackTo: target
      ? { ledger: target.ledger, cursor: target.cursor ?? null, checksum: target.checksum ?? null }
      : null,
    replayedLedgers: replayed.map((event) => event.ledger),
    finalChecksum,
    retainedCheckpointOnFailure: codes.length > 0,
  };
  const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);

  return {
    ok: codes.length === 0,
    codes: [...new Set(codes)].sort(),
    ...plan,
    planHash,
    metrics: { ...INDEXER_ROLLBACK_METRICS },
  };
}
