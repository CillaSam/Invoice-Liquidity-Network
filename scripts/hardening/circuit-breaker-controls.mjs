#!/usr/bin/env node
/**
 * Circuit-breaker activation and recovery controls (#1307).
 *
 * Reference invariants (Trust & Liquidity Model §5.3, §7.6):
 *   - anchor error rate > 5% over the sliding window pauses new assignments;
 *   - liquidity below the 10% floor, queue coverage above 2.0x, or a single
 *     LP above 25% of pool TVL pauses new funding;
 *   - a pause clears only after 2 consecutive clean epochs, unless the
 *     Protocol lead and Security lead both approve a manual clear;
 *   - missing or unusable telemetry is a trigger, never a pass.
 *
 * The module is pure and dependency-free: the same input and prior state
 * always produce the same decision, so a replay or a process restart cannot
 * silently change the control's behavior. It is the decision layer that
 * services call before assigning new settlement work or funding invoices.
 */

export const CIRCUIT_BREAKER_METRICS = Object.freeze({
  active: 'iln_circuit_breaker_active',
  activations: 'iln_circuit_breaker_activations_total',
  recoveries: 'iln_circuit_breaker_recoveries_total',
  overrides: 'iln_circuit_breaker_manual_overrides_total',
});

export const DEFAULT_CIRCUIT_BREAKER_CONFIG = Object.freeze({
  anchorErrorRateLimit: 0.05,
  minErrorSamples: 20,
  liquidityFloorRatio: 0.1,
  queueCoverageLimit: 2,
  singleLpQueueCapRatio: 0.25,
  cooldownEpochs: 2,
  requiredApprovals: Object.freeze(['protocol-lead', 'security-lead']),
});

export function initialCircuitBreakerState() {
  return {
    active: false,
    triggers: [],
    clearEpochs: 0,
    overrides: 0,
    lastDecisionCode: 'NONE',
  };
}

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Evaluate one epoch of circuit-breaker telemetry.
 *
 * @param {object} input telemetry snapshot for the epoch
 * @param {object} state prior breaker state (defaults to a fresh breaker)
 * @param {object} config governed thresholds
 * @returns {{state: object, decision: object}}
 */
export function evaluateCircuitBreaker(
  input = {},
  state = initialCircuitBreakerState(),
  config = DEFAULT_CIRCUIT_BREAKER_CONFIG
) {
  const telemetryAvailable = input.telemetryAvailable !== false;
  const anchorErrors = input.anchorErrors;
  const anchorSamples = input.anchorSamples;
  const liquidAssets = input.liquidAssets;
  const poolTvl = input.poolTvl;
  const queuedWithdrawals = input.queuedWithdrawals;
  const singleLpQueued = input.singleLpQueued;

  const triggers = [];
  if (!telemetryAvailable) {
    triggers.push('TELEMETRY_UNAVAILABLE');
  } else if (!isPositiveFinite(anchorSamples) || anchorSamples === 0) {
    triggers.push('TELEMETRY_UNAVAILABLE');
  } else if (anchorSamples < config.minErrorSamples) {
    triggers.push('INSUFFICIENT_ERROR_SAMPLES');
  } else if (!isPositiveFinite(anchorErrors)) {
    triggers.push('TELEMETRY_UNAVAILABLE');
  } else if (anchorErrors / anchorSamples > config.anchorErrorRateLimit) {
    triggers.push('ANCHOR_ERROR_RATE');
  }

  if (!isPositiveFinite(poolTvl) || poolTvl === 0) {
    triggers.push('POOL_TVL_UNAVAILABLE');
  } else {
    if (isPositiveFinite(liquidAssets) && liquidAssets < poolTvl * config.liquidityFloorRatio) {
      triggers.push('LIQUIDITY_FLOOR');
    }
    if (
      isPositiveFinite(queuedWithdrawals) &&
      isPositiveFinite(liquidAssets) &&
      liquidAssets > 0 &&
      queuedWithdrawals > liquidAssets * config.queueCoverageLimit
    ) {
      triggers.push('QUEUE_OVERFLOW');
    }
    if (
      isPositiveFinite(singleLpQueued) &&
      singleLpQueued > poolTvl * config.singleLpQueueCapRatio
    ) {
      triggers.push('CONCENTRATION');
    }
  }

  const clean = triggers.length === 0;
  const clearEpochs = clean ? state.clearEpochs + 1 : 0;
  const active = clean ? state.active && clearEpochs < config.cooldownEpochs : true;
  const code = active ? 'CIRCUIT_OPEN' : 'CIRCUIT_CLOSED';

  return {
    state: {
      active,
      triggers: [...triggers].sort(),
      clearEpochs,
      overrides: state.overrides,
      lastDecisionCode: code,
    },
    decision: {
      code,
      active,
      triggers: [...triggers].sort(),
      newAssignmentsPaused: active,
      clearEpochs,
      cooldownEpochs: config.cooldownEpochs,
      metrics: { ...CIRCUIT_BREAKER_METRICS },
    },
  };
}

/**
 * Check a proposed manual clear. Both governed roles must be present; no
 * single operator may bypass the cooldown on their own.
 */
export function requestManualClear(approvals, config = DEFAULT_CIRCUIT_BREAKER_CONFIG) {
  const granted = new Set(Array.isArray(approvals) ? approvals : []);
  const missing = config.requiredApprovals.filter((role) => !granted.has(role));
  if (missing.length > 0) {
    return { approved: false, code: 'MANUAL_CLEAR_INSUFFICIENT_APPROVALS', missing };
  }
  return {
    approved: true,
    code: 'MANUAL_CLEAR_APPROVED',
    approvals: [...config.requiredApprovals],
  };
}

/**
 * Apply an approved manual clear. It bypasses the cooldown only; if the
 * triggering telemetry is still present the next evaluation reopens the
 * breaker. That is intentional fail-closed behavior.
 */
export function applyManualClear(state, approvalResult) {
  if (!approvalResult || approvalResult.approved !== true) {
    return {
      ...state,
      lastDecisionCode: 'MANUAL_CLEAR_REJECTED',
    };
  }
  return {
    ...state,
    active: false,
    triggers: [],
    clearEpochs: 0,
    overrides: state.overrides + 1,
    lastDecisionCode: 'MANUAL_CLEAR_APPROVED',
  };
}
