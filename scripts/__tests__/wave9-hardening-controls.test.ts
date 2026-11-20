/**
 * Regression coverage for the wave-9 hardening controls:
 * #1307 circuit breaker, #1308 settlement-anchor enforcement,
 * #1310 redemption pricing deviation limits, #1316 indexer rollback.
 *
 * Every control is checked for success, failure, replay/restart determinism,
 * and its governed boundary. The evidence runner is checked as well so a
 * removed scenario fails CI instead of quietly reducing coverage.
 */

import { describe, expect, it } from 'vitest';
import {
  applyManualClear,
  evaluateCircuitBreaker,
  initialCircuitBreakerState,
  requestManualClear,
} from '../hardening/circuit-breaker-controls.mjs';
import { rehearseIndexerRollback } from '../hardening/indexer-rollback-rehearsal.mjs';
import { evaluateRedemptionPricing } from '../hardening/redemption-pricing-guard.mjs';
import { evaluateSettlementAnchor } from '../hardening/settlement-anchor-enforcement.mjs';
import { allScenariosPass, buildEvidence } from '../hardening/run-wave9-controls.mjs';

const HEALTHY_CIRCUIT = {
  telemetryAvailable: true,
  anchorErrors: 0,
  anchorSamples: 100,
  liquidAssets: 40,
  poolTvl: 100,
  queuedWithdrawals: 10,
  singleLpQueued: 5,
};

const REFERENCES = [
  { venue: 'anchor-a', price: 100, observedAtMs: 1000 },
  { venue: 'anchor-b', price: 100, observedAtMs: 990 },
];

const CLEAR_SCREENING = {
  status: 'clear',
  caseReference: 'case-1001',
  decidedAtMs: 99_000,
};

const HEALTHY_ANCHOR = {
  id: 'anchor-a',
  registered: true,
  healthy: true,
  supportedCorridors: ['BRL'],
  lastHealthCheckMs: 95_000,
};

const ROLLBACK_TIMELINE = {
  contractPaused: false,
  checkpoints: [{ ledger: 10, cursor: 'cursor-10', checksum: 'state-10' }],
  divergenceLedger: 12,
  replayEvents: [
    { ledger: 11, checksumAfter: 'state-11' },
    { ledger: 12, checksumAfter: 'state-12' },
  ],
  expectedChecksum: 'state-12',
};

describe('#1307 circuit-breaker activation and recovery', () => {
  it('stays closed on clean telemetry and opens on a real trigger', () => {
    expect(evaluateCircuitBreaker(HEALTHY_CIRCUIT).decision.code).toBe('CIRCUIT_CLOSED');
    const breached = evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, anchorErrors: 10 });
    expect(breached.decision.code).toBe('CIRCUIT_OPEN');
    expect(breached.decision.triggers).toContain('ANCHOR_ERROR_RATE');
    expect(breached.decision.newAssignmentsPaused).toBe(true);
  });

  it('fails closed when telemetry or reference data is unavailable', () => {
    const offline = evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, telemetryAvailable: false });
    expect(offline.decision.triggers).toContain('TELEMETRY_UNAVAILABLE');
    expect(offline.decision.active).toBe(true);

    const noErrors = evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, anchorErrors: undefined });
    expect(noErrors.decision.triggers).toContain('TELEMETRY_UNAVAILABLE');

    const fewSamples = evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, anchorSamples: 5 });
    expect(fewSamples.decision.triggers).toContain('INSUFFICIENT_ERROR_SAMPLES');
  });

  it('replays deterministically and respects the two-epoch cooldown', () => {
    const input = { ...HEALTHY_CIRCUIT, anchorErrors: 10 };
    const first = evaluateCircuitBreaker(input, initialCircuitBreakerState());
    const replay = evaluateCircuitBreaker(input, initialCircuitBreakerState());
    expect(replay).toEqual(first);

    const oneCleanEpoch = evaluateCircuitBreaker(HEALTHY_CIRCUIT, first.state);
    expect(oneCleanEpoch.decision.active).toBe(true);
    expect(oneCleanEpoch.decision.clearEpochs).toBe(1);

    const twoCleanEpochs = evaluateCircuitBreaker(HEALTHY_CIRCUIT, oneCleanEpoch.state);
    expect(twoCleanEpochs.decision.active).toBe(false);
    expect(twoCleanEpochs.decision.code).toBe('CIRCUIT_CLOSED');

    const rebreach = evaluateCircuitBreaker(input, twoCleanEpochs.state);
    expect(rebreach.decision.clearEpochs).toBe(0);
    expect(rebreach.decision.active).toBe(true);
  });

  it('does not trip exactly at a governed threshold but does one step past it', () => {
    const exactRate = evaluateCircuitBreaker({
      ...HEALTHY_CIRCUIT,
      anchorErrors: 1,
      anchorSamples: 20,
    });
    expect(exactRate.decision.code).toBe('CIRCUIT_CLOSED');

    const exactLiquidity = evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, liquidAssets: 10 });
    expect(exactLiquidity.decision.code).toBe('CIRCUIT_CLOSED');

    const exactQueue = evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, queuedWithdrawals: 80 });
    expect(exactQueue.decision.code).toBe('CIRCUIT_CLOSED');

    const exactConcentration = evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, singleLpQueued: 25 });
    expect(exactConcentration.decision.code).toBe('CIRCUIT_CLOSED');

    const overQueue = evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, queuedWithdrawals: 81 });
    expect(overQueue.decision.triggers).toContain('QUEUE_OVERFLOW');
  });

  it('requires both governed roles for a manual clear and reopens on live triggers', () => {
    const opened = evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, anchorErrors: 10 }).state;
    const partial = requestManualClear(['protocol-lead']);
    expect(partial.approved).toBe(false);
    expect(partial.missing).toEqual(['security-lead']);
    expect(applyManualClear(opened, partial).active).toBe(true);

    const approval = requestManualClear(['protocol-lead', 'security-lead']);
    const cleared = applyManualClear(opened, approval);
    expect(cleared.active).toBe(false);
    expect(cleared.overrides).toBe(1);
    expect(
      evaluateCircuitBreaker({ ...HEALTHY_CIRCUIT, anchorErrors: 10 }, cleared).decision.active
    ).toBe(true);
  });
});

describe('#1310 redemption pricing deviation limits', () => {
  it('approves a quote inside the limit and rejects an excessive deviation', () => {
    expect(
      evaluateRedemptionPricing({ quotedPrice: 100, referenceSources: REFERENCES, nowMs: 1000 })
        .code
    ).toBe('PRICE_WITHIN_LIMITS');
    expect(
      evaluateRedemptionPricing({ quotedPrice: 110, referenceSources: REFERENCES, nowMs: 1000 })
        .code
    ).toBe('PRICE_DEVIATION_EXCEEDED');
  });

  it('fails closed for stale, missing, or disagreeing references', () => {
    const stale = evaluateRedemptionPricing({
      quotedPrice: 100,
      referenceSources: [
        { venue: 'a', price: 100, observedAtMs: 0 },
        { venue: 'b', price: 100, observedAtMs: 0 },
      ],
      nowMs: 1000,
    });
    expect(stale.code).toBe('PRICE_REFERENCE_UNAVAILABLE');

    const single = evaluateRedemptionPricing({
      quotedPrice: 100,
      referenceSources: [REFERENCES[0]],
      nowMs: 1000,
    });
    expect(single.code).toBe('PRICE_REFERENCE_UNAVAILABLE');

    const disagree = evaluateRedemptionPricing({
      quotedPrice: 100,
      referenceSources: [
        { venue: 'a', price: 100, observedAtMs: 1000 },
        { venue: 'b', price: 130, observedAtMs: 1000 },
        { venue: 'c', price: 100, observedAtMs: 1000 },
      ],
      nowMs: 1000,
    });
    expect(disagree.code).toBe('PRICE_SOURCES_DISAGREE');
  });

  it('replays identically and enforces the exact basis-point boundary', () => {
    const input = { quotedPrice: 102, referenceSources: REFERENCES, nowMs: 1000 };
    const first = evaluateRedemptionPricing(input);
    expect(evaluateRedemptionPricing(input)).toEqual(first);
    expect(first.approved).toBe(true);
    expect(first.deviationBps).toBe(200);

    const over = evaluateRedemptionPricing({ ...input, quotedPrice: 102.01 });
    expect(over.approved).toBe(false);
    expect(over.code).toBe('PRICE_DEVIATION_EXCEEDED');

    const invalid = evaluateRedemptionPricing({ ...input, quotedPrice: 0 });
    expect(invalid.code).toBe('INVALID_QUOTE');
  });
});

describe('#1308 settlement-anchor enforcement evidence', () => {
  it('allows only a cleared, case-referenced, diverse route', () => {
    const allowed = evaluateSettlementAnchor({
      requestId: 'request-1001',
      corridor: 'BRL',
      nowMs: 100_000,
      screening: CLEAR_SCREENING,
      anchor: HEALTHY_ANCHOR,
      activeAnchorsForCorridor: 2,
    });
    expect(allowed.decision).toBe('allow');
    expect(allowed.allowed).toBe(true);
    expect(allowed.idempotencyKey).toBe('settlement:request-1001');
    expect(allowed.healthAgeMs).toBe(5000);
  });

  it('holds on screening outcomes and rejects degraded routes', () => {
    const base = {
      requestId: 'request-1002',
      corridor: 'BRL',
      nowMs: 100_000,
      anchor: HEALTHY_ANCHOR,
      activeAnchorsForCorridor: 2,
    };
    const potential = evaluateSettlementAnchor({
      ...base,
      screening: { ...CLEAR_SCREENING, status: 'potential_match' },
    });
    expect(potential.decision).toBe('hold');
    expect(potential.codes).toContain('SCREENING_POTENTIAL_MATCH');

    const unavailable = evaluateSettlementAnchor({
      ...base,
      screening: { ...CLEAR_SCREENING, status: 'unavailable' },
    });
    expect(unavailable.decision).toBe('hold');
    expect(unavailable.retryable).toBe(true);

    const missingCase = evaluateSettlementAnchor({
      ...base,
      screening: { ...CLEAR_SCREENING, caseReference: '' },
    });
    expect(missingCase.codes).toContain('SCREENING_CASE_REFERENCE_MISSING');

    const singleAnchor = evaluateSettlementAnchor({
      ...base,
      screening: CLEAR_SCREENING,
      activeAnchorsForCorridor: 1,
    });
    expect(singleAnchor.decision).toBe('reject');
    expect(singleAnchor.codes).toContain('ANCHOR_DIVERSIFICATION_INSUFFICIENT');
  });

  it('replays with the same key and enforces health-age and corridor boundaries', () => {
    const input = {
      requestId: 'request-1003',
      corridor: 'BRL',
      nowMs: 100_000,
      screening: CLEAR_SCREENING,
      anchor: HEALTHY_ANCHOR,
      activeAnchorsForCorridor: 2,
    };
    expect(evaluateSettlementAnchor(input)).toEqual(evaluateSettlementAnchor(input));

    const exactAge = evaluateSettlementAnchor({
      ...input,
      anchor: { ...HEALTHY_ANCHOR, lastHealthCheckMs: -800_000 },
    });
    expect(exactAge.decision).toBe('allow');

    const staleAge = evaluateSettlementAnchor({
      ...input,
      anchor: { ...HEALTHY_ANCHOR, lastHealthCheckMs: -800_001 },
    });
    expect(staleAge.decision).toBe('reject');
    expect(staleAge.codes).toContain('ANCHOR_UNHEALTHY');

    const wrongCorridor = evaluateSettlementAnchor({ ...input, corridor: 'IDR' });
    expect(wrongCorridor.codes).toContain('ANCHOR_CORRIDOR_UNSUPPORTED');
  });
});

describe('#1316 indexer rollback without contract pause', () => {
  it('rolls back, replays and verifies the rebuilt checksum', () => {
    const result = rehearseIndexerRollback(ROLLBACK_TIMELINE);
    expect(result.ok).toBe(true);
    expect(result.rolledBackTo?.ledger).toBe(10);
    expect(result.replayedLedgers).toEqual([11, 12]);
    expect(result.finalChecksum).toBe('state-12');
    expect(result.contractPaused).toBe(false);
    expect(result.contractPauseUsed).toBe(false);
  });

  it('rejects a paused-contract exercise, checksum drift and replay gaps', () => {
    const paused = rehearseIndexerRollback({ ...ROLLBACK_TIMELINE, contractPaused: true });
    expect(paused.ok).toBe(false);
    expect(paused.codes).toContain('CONTRACT_PAUSED_ROLLBACK_NOT_VALID');

    const drift = rehearseIndexerRollback({
      ...ROLLBACK_TIMELINE,
      expectedChecksum: 'state-corrupt',
    });
    expect(drift.ok).toBe(false);
    expect(drift.codes).toContain('REPLAY_CHECKSUM_MISMATCH');

    const gap = rehearseIndexerRollback({
      ...ROLLBACK_TIMELINE,
      replayEvents: [{ ledger: 12, checksumAfter: 'state-12' }],
    });
    expect(gap.codes).toContain('REPLAY_SEQUENCE_GAP');
  });

  it('is deterministic on replay and handles the no-replay and no-checkpoint boundaries', () => {
    const first = rehearseIndexerRollback(ROLLBACK_TIMELINE);
    expect(rehearseIndexerRollback(ROLLBACK_TIMELINE)).toEqual(first);

    const sameLedger = rehearseIndexerRollback({
      ...ROLLBACK_TIMELINE,
      divergenceLedger: 10,
      replayEvents: [],
      expectedChecksum: 'state-10',
    });
    expect(sameLedger.ok).toBe(true);
    expect(sameLedger.replayedLedgers).toEqual([]);
    expect(sameLedger.finalChecksum).toBe('state-10');

    const noCheckpoint = rehearseIndexerRollback({ ...ROLLBACK_TIMELINE, divergenceLedger: 5 });
    expect(noCheckpoint.ok).toBe(false);
    expect(noCheckpoint.codes).toContain('NO_SAFE_CHECKPOINT');
  });
});

describe('wave-9 evidence artifact', () => {
  it('covers all four issues with passing scenarios and no contract pause', () => {
    const evidence = buildEvidence();
    expect(Object.keys(evidence.controls).sort()).toEqual([
      'circuitBreaker',
      'indexerRollback',
      'redemptionPricing',
      'settlementAnchor',
    ]);
    expect(evidence.contractPauseUsed).toBe(false);
    expect(allScenariosPass(evidence)).toBe(true);
    for (const control of Object.values(evidence.controls)) {
      expect(control.scenarios.length).toBeGreaterThanOrEqual(3);
      for (const entry of control.scenarios) {
        expect(entry.pass, `${control.issue}: ${entry.name} failed`).toBe(true);
      }
    }
  });
});
