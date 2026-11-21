#!/usr/bin/env node
/**
 * Operational readiness review for mainnet controls (#1324).
 *
 * Reference invariants:
 *   - Admin multi-sig requires >= 2 independent signers and timelock >= 86400s;
 *   - Automated circuit breakers must be enabled with error rate threshold <= 5%;
 *   - First-loss treasury buffer must equal or exceed 5% of pool TVL;
 *   - Emergency feature-disable and pause paths must be verified within 30 days;
 *   - Independent external security audit must have a current 'Signed' decision
 *     within a 90-day freshness window;
 *   - Fail-closed: missing evidence or failed invariants reject readiness.
 *
 * This module is pure and dependency-free: identical inputs always yield
 * identical readiness determinations across restarts and replay verification.
 */

import { writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

export const OPERATIONAL_READINESS_METRICS = Object.freeze({
  evaluations: 'iln_operational_readiness_evaluations_total',
  failures: 'iln_operational_readiness_failures_total',
  controlsVerified: 'iln_operational_readiness_controls_verified',
  staleAudits: 'iln_operational_readiness_stale_audits_total',
});

export const DEFAULT_READINESS_CONFIG = Object.freeze({
  minMultisigSigners: 2,
  minTimelockSeconds: 86400,
  maxCircuitBreakerErrorRate: 0.05,
  minTreasuryCoverageRatio: 0.05,
  maxEmergencyPauseFreshnessDays: 30,
  maxAuditFreshnessDays: 90,
  requiredReviewAreas: Object.freeze([
    'protocol-security',
    'liquidity-controls',
    'infrastructure-failover',
    'smart-contracts',
  ]),
});

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Evaluates administrative multi-sig and timelock posture.
 */
export function evaluateMultisigControl(multisig, config = DEFAULT_READINESS_CONFIG) {
  if (!multisig || typeof multisig !== 'object') {
    return {
      pass: false,
      code: 'MULTISIG_CONFIG_MISSING',
      reason: 'Administrative multi-sig configuration missing or malformed',
    };
  }

  const signers = Array.isArray(multisig.signers) ? multisig.signers : [];
  const quorum = Number.isInteger(multisig.quorum) ? multisig.quorum : 0;
  const timelock = Number.isInteger(multisig.timelockSeconds) ? multisig.timelockSeconds : -1;

  if (signers.length < config.minMultisigSigners || quorum < config.minMultisigSigners) {
    return {
      pass: false,
      code: 'MULTISIG_QUORUM_DEFICIENT',
      reason: `Quorum requires at least ${config.minMultisigSigners} signers (observed quorum: ${quorum}, signers: ${signers.length})`,
    };
  }

  if (timelock < config.minTimelockSeconds) {
    return {
      pass: false,
      code: 'TIMELOCK_INSUFFICIENT',
      reason: `Timelock must be at least ${config.minTimelockSeconds}s (observed: ${timelock}s)`,
    };
  }

  return {
    pass: true,
    code: 'MULTISIG_CONTROL_VERIFIED',
    reason: `Multi-sig quorum ${quorum}/${signers.length} with ${timelock}s timelock compliant`,
  };
}

/**
 * Evaluates automated circuit breaker readiness.
 */
export function evaluateCircuitBreakerReadiness(circuit, config = DEFAULT_READINESS_CONFIG) {
  if (!circuit || typeof circuit !== 'object') {
    return {
      pass: false,
      code: 'CIRCUIT_BREAKER_CONFIG_MISSING',
      reason: 'Circuit breaker configuration is required for mainnet deployment',
    };
  }

  if (circuit.enabled !== true) {
    return {
      pass: false,
      code: 'CIRCUIT_BREAKER_DISABLED',
      reason: 'Automated circuit breaker is disabled',
    };
  }

  if (!isPositiveFinite(circuit.errorRateThreshold) || circuit.errorRateThreshold > config.maxCircuitBreakerErrorRate) {
    return {
      pass: false,
      code: 'CIRCUIT_BREAKER_THRESHOLD_INVALID',
      reason: `Error rate threshold must be <= ${config.maxCircuitBreakerErrorRate} (observed: ${circuit.errorRateThreshold})`,
    };
  }

  return {
    pass: true,
    code: 'CIRCUIT_BREAKER_VERIFIED',
    reason: `Circuit breaker active with ${circuit.errorRateThreshold * 100}% threshold`,
  };
}

/**
 * Evaluates first-loss treasury reserve coverage.
 */
export function evaluateTreasuryCoverage(treasury, config = DEFAULT_READINESS_CONFIG) {
  if (!treasury || typeof treasury !== 'object') {
    return {
      pass: false,
      code: 'TREASURY_CONFIG_MISSING',
      reason: 'Treasury reserve configuration missing',
    };
  }

  const treasuryBalance = isPositiveFinite(treasury.treasuryBalance) ? treasury.treasuryBalance : 0;
  const poolTvl = isPositiveFinite(treasury.poolTvl) ? treasury.poolTvl : 0;

  if (poolTvl <= 0) {
    return {
      pass: false,
      code: 'POOL_TVL_INVALID',
      reason: 'Pool TVL must be greater than zero for operational review',
    };
  }

  const coverageRatio = treasuryBalance / poolTvl;
  if (coverageRatio < config.minTreasuryCoverageRatio) {
    return {
      pass: false,
      code: 'TREASURY_COVERAGE_DEFICIENT',
      reason: `Treasury coverage ratio ${(coverageRatio * 100).toFixed(2)}% below required ${(config.minTreasuryCoverageRatio * 100).toFixed(2)}%`,
    };
  }

  return {
    pass: true,
    code: 'TREASURY_COVERAGE_VERIFIED',
    reason: `Treasury coverage ratio ${(coverageRatio * 100).toFixed(2)}% satisfies reserve requirement`,
  };
}

/**
 * Evaluates emergency feature-disable and pause freshness.
 */
export function evaluateEmergencyPauseFreshness(emergencyPause, nowMs = Date.now(), config = DEFAULT_READINESS_CONFIG) {
  if (!emergencyPause || typeof emergencyPause !== 'object') {
    return {
      pass: false,
      code: 'EMERGENCY_PAUSE_CONFIG_MISSING',
      reason: 'Emergency pause rehearsal evidence is required',
    };
  }

  if (emergencyPause.rehearsalPassed !== true) {
    return {
      pass: false,
      code: 'EMERGENCY_PAUSE_REHEARSAL_FAILED',
      reason: 'Emergency pause rehearsal did not pass verification',
    };
  }

  const lastRehearsalMs = typeof emergencyPause.lastRehearsalMs === 'number' ? emergencyPause.lastRehearsalMs : 0;
  const elapsedDays = (nowMs - lastRehearsalMs) / (1000 * 60 * 60 * 24);

  if (elapsedDays > config.maxEmergencyPauseFreshnessDays) {
    return {
      pass: false,
      code: 'EMERGENCY_PAUSE_STALE',
      reason: `Emergency pause rehearsal is stale (${elapsedDays.toFixed(1)} days old, max ${config.maxEmergencyPauseFreshnessDays} days)`,
    };
  }

  return {
    pass: true,
    code: 'EMERGENCY_PAUSE_VERIFIED',
    reason: `Emergency pause rehearsal verified within ${elapsedDays.toFixed(1)} days`,
  };
}

/**
 * Evaluates external security audit attestation.
 */
export function evaluateSecurityAuditSignoff(audit, nowMs = Date.now(), config = DEFAULT_READINESS_CONFIG) {
  if (!audit || typeof audit !== 'object') {
    return {
      pass: false,
      code: 'AUDIT_ATTESTATION_MISSING',
      reason: 'Independent security audit attestation is required',
    };
  }

  if (audit.status !== 'Signed') {
    return {
      pass: false,
      code: 'AUDIT_NOT_SIGNED',
      reason: `Audit status must be 'Signed' (observed: ${audit.status})`,
    };
  }

  if (!audit.independentReviewer || /^(?:tbd|pending|unassigned)$/i.test(audit.independentReviewer)) {
    return {
      pass: false,
      code: 'INDEPENDENT_REVIEWER_REQUIRED',
      reason: 'Named independent reviewer required for mainnet controls sign-off',
    };
  }

  const auditDateMs = typeof audit.auditDateMs === 'number' ? audit.auditDateMs : 0;
  const elapsedDays = (nowMs - auditDateMs) / (1000 * 60 * 60 * 24);

  if (elapsedDays > config.maxAuditFreshnessDays) {
    return {
      pass: false,
      code: 'AUDIT_STALE',
      reason: `Security audit attestation is stale (${elapsedDays.toFixed(1)} days old, max ${config.maxAuditFreshnessDays} days)`,
    };
  }

  return {
    pass: true,
    code: 'AUDIT_ATTESTATION_VERIFIED',
    reason: `Security audit signed by ${audit.independentReviewer} (${elapsedDays.toFixed(1)} days old)`,
  };
}

/**
 * Main operational readiness evaluator: checks all mainnet operational controls.
 */
export function evaluateOperationalReadiness(input, nowMs = Date.now(), config = DEFAULT_READINESS_CONFIG) {
  if (!input || typeof input !== 'object') {
    return {
      pass: false,
      code: 'READINESS_INPUT_INVALID',
      controlsEvaluated: 0,
      controlsPassed: 0,
      results: {},
      summary: 'Readiness evaluation input missing or invalid',
    };
  }

  const results = {
    multisigControl: evaluateMultisigControl(input.multisig, config),
    circuitBreaker: evaluateCircuitBreakerReadiness(input.circuitBreaker, config),
    treasuryCoverage: evaluateTreasuryCoverage(input.treasury, config),
    emergencyPause: evaluateEmergencyPauseFreshness(input.emergencyPause, nowMs, config),
    securityAudit: evaluateSecurityAuditSignoff(input.securityAudit, nowMs, config),
  };

  const controlsEvaluated = Object.keys(results).length;
  const passedControls = Object.values(results).filter((r) => r.pass);
  const controlsPassed = passedControls.length;
  const allPassed = controlsPassed === controlsEvaluated;

  return {
    pass: allPassed,
    code: allPassed ? 'READINESS_APPROVED' : 'READINESS_REJECTED',
    controlsEvaluated,
    controlsPassed,
    results,
    summary: allPassed
      ? `All ${controlsEvaluated} mainnet controls passed operational readiness review`
      : `${controlsEvaluated - controlsPassed} of ${controlsEvaluated} mainnet controls failed operational readiness review`,
  };
}

function parseCliArgs(args) {
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
  const { outFile } = parseCliArgs(argv.slice(2));
  const sampleNow = Date.now();
  const sampleInput = {
    multisig: {
      signers: ['GADMIN1', 'GADMIN2', 'GADMIN3'],
      quorum: 2,
      timelockSeconds: 86400,
    },
    circuitBreaker: {
      enabled: true,
      errorRateThreshold: 0.05,
    },
    treasury: {
      treasuryBalance: 50000,
      poolTvl: 1000000,
    },
    emergencyPause: {
      rehearsalPassed: true,
      lastRehearsalMs: sampleNow - 5 * 24 * 3600 * 1000,
    },
    securityAudit: {
      status: 'Signed',
      independentReviewer: '@external-auditor-sec',
      auditDateMs: sampleNow - 20 * 24 * 3600 * 1000,
    },
  };

  const evaluation = evaluateOperationalReadiness(sampleInput, sampleNow);
  const payload = JSON.stringify(
    {
      schemaVersion: 'mainnet-operational-readiness/v1',
      evaluation,
      generatedAt: new Date(sampleNow).toISOString(),
    },
    null,
    2
  );

  if (outFile) {
    writeFileSync(outFile, `${payload}\n`);
  } else {
    stdout.write(`${payload}\n`);
  }

  if (!evaluation.pass) {
    stdout.write('Mainnet operational readiness: REJECTED\n');
    exit(1);
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(argv[1] || '').href;
if (invokedDirectly) {
  main();
}
