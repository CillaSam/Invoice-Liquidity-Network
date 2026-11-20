#!/usr/bin/env node
/**
 * Operator/CI evidence runner for the wave-9 hardening controls
 * (#1307, #1308, #1310, #1316).
 *
 * Runs a fixed matrix of success, failure and boundary scenarios against the
 * four pure control modules and emits a JSON evidence artifact. The artifact
 * is deterministic apart from the CLI-added `generatedAt` field, so a replay
 * or a process restart can be compared byte-for-byte with a prior run.
 *
 * Usage:
 *   node scripts/hardening/run-wave9-controls.mjs [--json] [--out FILE]
 */

import { writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { CIRCUIT_BREAKER_METRICS, evaluateCircuitBreaker } from './circuit-breaker-controls.mjs';
import {
  INDEXER_ROLLBACK_METRICS,
  rehearseIndexerRollback,
} from './indexer-rollback-rehearsal.mjs';
import { PRICING_GUARD_METRICS, evaluateRedemptionPricing } from './redemption-pricing-guard.mjs';
import {
  SETTLEMENT_ANCHOR_METRICS,
  evaluateSettlementAnchor,
} from './settlement-anchor-enforcement.mjs';

export const EVIDENCE_SCHEMA = 'wave9-hardening-controls/v1';

const HEALTHY_CIRCUIT_INPUT = Object.freeze({
  telemetryAvailable: true,
  anchorErrors: 0,
  anchorSamples: 100,
  liquidAssets: 40,
  poolTvl: 100,
  queuedWithdrawals: 10,
  singleLpQueued: 5,
});

const PRICING_REFERENCES = Object.freeze([
  { venue: 'anchor-a', price: 100, observedAtMs: 1000 },
  { venue: 'anchor-b', price: 102, observedAtMs: 990 },
]);

const CLEAR_SCREENING = Object.freeze({
  status: 'clear',
  caseReference: 'case-1001',
  decidedAtMs: 99_000,
});

const HEALTHY_ANCHOR = Object.freeze({
  id: 'anchor-a',
  registered: true,
  healthy: true,
  supportedCorridors: ['BRL'],
  lastHealthCheckMs: 95_000,
});

const INDEXER_TIMELINE = Object.freeze({
  contractPaused: false,
  checkpoints: [{ ledger: 10, cursor: 'cursor-10', checksum: 'state-10' }],
  divergenceLedger: 12,
  replayEvents: [
    { ledger: 11, checksumAfter: 'state-11' },
    { ledger: 12, checksumAfter: 'state-12' },
  ],
  expectedChecksum: 'state-12',
});

function scenario(name, expectation, observed) {
  return { name, expectation, observed, pass: observed === expectation };
}

/** Build the deterministic evidence matrix used by CI and operators. */
export function buildEvidence() {
  const circuit = evaluateCircuitBreaker(HEALTHY_CIRCUIT_INPUT).decision;
  const circuitFailure = evaluateCircuitBreaker({
    ...HEALTHY_CIRCUIT_INPUT,
    anchorErrors: 10,
  }).decision;
  const circuitNoTelemetry = evaluateCircuitBreaker({
    ...HEALTHY_CIRCUIT_INPUT,
    telemetryAvailable: false,
  }).decision;

  const pricing = evaluateRedemptionPricing({
    quotedPrice: 100,
    referenceSources: PRICING_REFERENCES,
    nowMs: 1000,
  });
  const pricingFailure = evaluateRedemptionPricing({
    quotedPrice: 110,
    referenceSources: PRICING_REFERENCES,
    nowMs: 1000,
  });
  const pricingNoReference = evaluateRedemptionPricing({
    quotedPrice: 100,
    referenceSources: [PRICING_REFERENCES[0]],
    nowMs: 1000,
  });

  const settlement = evaluateSettlementAnchor({
    requestId: 'request-1001',
    corridor: 'BRL',
    nowMs: 100_000,
    screening: CLEAR_SCREENING,
    anchor: HEALTHY_ANCHOR,
    activeAnchorsForCorridor: 2,
  });
  const settlementHold = evaluateSettlementAnchor({
    requestId: 'request-1002',
    corridor: 'BRL',
    nowMs: 100_000,
    screening: { ...CLEAR_SCREENING, status: 'potential_match' },
    anchor: HEALTHY_ANCHOR,
    activeAnchorsForCorridor: 2,
  });
  const settlementNoDiversity = evaluateSettlementAnchor({
    requestId: 'request-1003',
    corridor: 'BRL',
    nowMs: 100_000,
    screening: CLEAR_SCREENING,
    anchor: HEALTHY_ANCHOR,
    activeAnchorsForCorridor: 1,
  });

  const rollback = rehearseIndexerRollback(INDEXER_TIMELINE);
  const rollbackPaused = rehearseIndexerRollback({
    ...INDEXER_TIMELINE,
    contractPaused: true,
  });
  const rollbackBadChecksum = rehearseIndexerRollback({
    ...INDEXER_TIMELINE,
    expectedChecksum: 'state-corrupt',
  });

  return {
    schemaVersion: EVIDENCE_SCHEMA,
    contractPauseUsed: false,
    controls: {
      circuitBreaker: {
        issue: 1307,
        metrics: { ...CIRCUIT_BREAKER_METRICS },
        scenarios: [
          scenario('healthy_epoch_stays_closed', 'CIRCUIT_CLOSED', circuit.code),
          scenario('error_rate_breach_opens', 'CIRCUIT_OPEN', circuitFailure.code),
          scenario('telemetry_outage_fails_closed', 'CIRCUIT_OPEN', circuitNoTelemetry.code),
        ],
      },
      settlementAnchor: {
        issue: 1308,
        metrics: { ...SETTLEMENT_ANCHOR_METRICS },
        scenarios: [
          scenario('cleared_and_diverse_route_allows', 'allow', settlement.decision),
          scenario('potential_match_holds', 'hold', settlementHold.decision),
          scenario('single_anchor_route_rejects', 'reject', settlementNoDiversity.decision),
        ],
      },
      redemptionPricing: {
        issue: 1310,
        metrics: { ...PRICING_GUARD_METRICS },
        scenarios: [
          scenario('quote_within_limits_approves', 'PRICE_WITHIN_LIMITS', pricing.code),
          scenario(
            'quote_over_deviation_limit_rejects',
            'PRICE_DEVIATION_EXCEEDED',
            pricingFailure.code
          ),
          scenario(
            'single_reference_fails_closed',
            'PRICE_REFERENCE_UNAVAILABLE',
            pricingNoReference.code
          ),
        ],
      },
      indexerRollback: {
        issue: 1316,
        metrics: { ...INDEXER_ROLLBACK_METRICS },
        scenarios: [
          scenario('rollback_and_replay_without_pause', true, rollback.ok),
          scenario('contract_pause_is_not_a_valid_exercise', false, rollbackPaused.ok),
          scenario('checksum_mismatch_fails_closed', false, rollbackBadChecksum.ok),
        ],
      },
    },
  };
}

export function allScenariosPass(evidence) {
  return Object.values(evidence.controls)
    .flatMap((control) => control.scenarios)
    .every((entry) => entry.pass);
}

function parseArgs(args) {
  const result = { json: false, outFile: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') {
      result.json = true;
    } else if (args[i] === '--out' && args[i + 1]) {
      result.outFile = args[i + 1];
      i += 1;
    }
  }
  return result;
}

function main() {
  const { json, outFile } = parseArgs(argv.slice(2));
  const evidence = { ...buildEvidence(), generatedAt: new Date().toISOString() };
  const payload = JSON.stringify(evidence, null, 2);
  if (outFile) {
    writeFileSync(outFile, `${payload}\n`);
  } else {
    stdout.write(`${payload}\n`);
  }
  if (!allScenariosPass(evidence)) {
    stdout.write('wave-9 control evidence: FAILED\n');
    exit(1);
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(argv[1] || '').href;
if (invokedDirectly) {
  main();
}
