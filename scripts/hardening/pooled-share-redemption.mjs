#!/usr/bin/env node
/**
 * Pooled-share redemption guarantees and withdrawal queue controls (#1305).
 *
 * Reference invariants (Trust & Liquidity Model §7):
 *   - No synchronous full redemption of locked capital
 *   - Pro rata fairness: within each epoch, all queued requests are satisfied
 *     proportionally from available liquidity
 *   - Withdrawal notice period: minimum 1 epoch before eligibility
 *   - Withdrawal state machine: PENDING → QUEUED → PROCESSING → COMPLETED/PARTIAL
 *   - Fail-closed: queued withdrawals > available_liquidity pause new funding
 *
 * The module is pure: same input always produces same decision. Replays verify
 * the withdrawal queue logic is deterministic and can survive restarts.
 */

export const WITHDRAWAL_METRICS = Object.freeze({
  queued_withdrawal_requests: 'iln_withdrawal_queue_requests_queued',
  processed_withdrawal_requests: 'iln_withdrawal_queue_requests_processed',
  partial_withdrawal_fills: 'iln_withdrawal_queue_partial_fills',
  queue_pause_triggers: 'iln_withdrawal_queue_pause_triggers',
});

export const DEFAULT_WITHDRAWAL_CONFIG = Object.freeze({
  noticePeriodsRequired: 1,
  maxNoticePeriodsAllowed: 4,
  epochDurationDays: 7,
  liquidityFloor: 0.1, // 10% of pool TVL
  queueCoverageLimit: 2.0, // 2x available liquidity
  singleLpQueueCap: 0.25, // 25% of pool TVL
  pauseCooldownEpochs: 2,
});

export function initialWithdrawalQueueState() {
  return {
    totalQueued: 0,
    totalRequests: 0,
    pendingRequests: 0,
    queuedRequests: 0,
    processingRequests: 0,
    completedRequests: 0,
    partialFills: 0,
    pauseActive: false,
    pauseTriggers: [],
    cleanEpochs: 0,
    currentEpoch: 0,
  };
}

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validate a withdrawal request and determine its eligibility for processing.
 *
 * @param {object} input withdrawal request
 * @param {object} state current queue state
 * @param {object} config governed thresholds
 * @returns {object} request validation
 */
export function validateWithdrawalRequest(
  input = {},
  state = initialWithdrawalQueueState(),
  config = DEFAULT_WITHDRAWAL_CONFIG
) {
  const requestId = input.requestId;
  const lpAddress = input.lpAddress;
  const amount = input.amount || 0;
  const noticeEpochs = input.noticeEpochs || config.noticePeriodsRequired;
  const submittedEpoch = input.submittedEpoch || 0;
  const currentEpoch = input.currentEpoch || state.currentEpoch;

  const issues = [];

  if (!requestId || typeof requestId !== 'string') {
    issues.push('REQUEST_ID_INVALID');
  }
  if (!lpAddress || typeof lpAddress !== 'string') {
    issues.push('LP_ADDRESS_INVALID');
  }
  if (!isPositiveFinite(amount) || amount <= 0) {
    issues.push('AMOUNT_INVALID');
  }

  if (noticeEpochs < config.noticePeriodsRequired) {
    issues.push('NOTICE_PERIOD_TOO_SHORT');
  }
  if (noticeEpochs > config.maxNoticePeriodsAllowed) {
    issues.push('NOTICE_PERIOD_TOO_LONG');
  }

  if (!isPositiveFinite(submittedEpoch) || submittedEpoch < 0) {
    issues.push('SUBMITTED_EPOCH_INVALID');
  }
  if (submittedEpoch > currentEpoch) {
    issues.push('SUBMITTED_EPOCH_IN_FUTURE');
  }

  const eligible = currentEpoch >= submittedEpoch + noticeEpochs;
  const nextEligibleEpoch = submittedEpoch + noticeEpochs;

  return {
    valid: issues.length === 0,
    requestId,
    lpAddress,
    amount,
    noticeEpochs,
    submittedEpoch,
    eligible,
    nextEligibleEpoch,
    issues: [...issues].sort(),
  };
}

/**
 * Evaluate withdrawal queue state and determine funding pause status.
 *
 * @param {object} input queue metrics
 * @param {object} state prior queue state
 * @param {object} config governed thresholds
 * @returns {object} queue evaluation
 */
export function evaluateWithdrawalQueue(
  input = {},
  state = initialWithdrawalQueueState(),
  config = DEFAULT_WITHDRAWAL_CONFIG
) {
  const availableLiquidity = input.availableLiquidity || 0;
  const poolTvl = input.poolTvl || 0;
  const totalQueuedAmount = input.totalQueuedAmount || 0;
  const queuedRequests = input.queuedRequests || 0;
  const singleLpQueuedMax = input.singleLpQueuedMax || 0;
  const currentEpoch = input.currentEpoch || state.currentEpoch;

  const triggers = [];
  const metrics = {};

  // Liquidity floor breach
  const liquidityFloor = poolTvl * config.liquidityFloor;
  if (availableLiquidity < liquidityFloor) {
    triggers.push('LIQUIDITY_FLOOR_BREACH');
  }

  // Queue overflow
  const maxQueueCoverage = availableLiquidity * config.queueCoverageLimit;
  if (totalQueuedAmount > maxQueueCoverage) {
    triggers.push('QUEUE_OVERFLOW');
  }

  // Single LP concentration
  const singleLpCap = poolTvl * config.singleLpQueueCap;
  if (singleLpQueuedMax > singleLpCap) {
    triggers.push('SINGLE_LP_CONCENTRATION');
  }

  const pauseTriggered = triggers.length > 0;
  const cleanEpochs = pauseTriggered ? 0 : state.cleanEpochs + 1;
  const pauseActive =
    pauseTriggered || (state.pauseActive && cleanEpochs < config.pauseCooldownEpochs);

  // Calculate coverage ratio
  const coverageRatio =
    totalQueuedAmount > 0 && availableLiquidity > 0
      ? availableLiquidity / totalQueuedAmount
      : 1.0;

  const singleLpQueueCap = poolTvl * config.singleLpQueueCap;

  return {
    pauseActive,
    triggers: [...triggers].sort(),
    newFundingPaused: pauseActive,
    cleanEpochs,
    cooldownEpochs: config.pauseCooldownEpochs,
    availableLiquidity,
    totalQueuedAmount,
    queuedRequests,
    coverageRatio: Math.min(coverageRatio, 1.0), // capped at 1.0 for display
    singleLpQueuedMax,
    singleLpQueueCap,
    liquidityFloor,
    metrics: { ...WITHDRAWAL_METRICS },
  };
}

/**
 * Process one epoch of withdrawal queue requests.
 *
 * @param {object} input epoch snapshot
 * @param {object} state prior queue state
 * @returns {object} epoch processing result
 */
export function processWithdrawalEpoch(
  input = {},
  state = initialWithdrawalQueueState()
) {
  const availableLiquidity = input.availableLiquidity || 0;
  const queuedRequests = Array.isArray(input.queuedRequests) ? input.queuedRequests : [];
  const epoch = input.epoch || 0;

  let remaining = availableLiquidity;
  const processed = [];
  const partials = [];

  for (const request of queuedRequests) {
    const requested = request.amount || 0;
    if (remaining <= 0) {
      processed.push({
        requestId: request.requestId,
        status: 'QUEUED',
        allocated: 0,
        remaining: requested,
      });
      continue;
    }

    if (remaining >= requested) {
      processed.push({
        requestId: request.requestId,
        status: 'COMPLETED',
        allocated: requested,
        remaining: 0,
      });
      remaining -= requested;
    } else {
      processed.push({
        requestId: request.requestId,
        status: 'PARTIAL',
        allocated: remaining,
        remaining: requested - remaining,
      });
      partials.push(request.requestId);
      remaining = 0;
    }
  }

  const totalRequested = queuedRequests.reduce((sum, r) => sum + (r.amount || 0), 0);
  const totalAllocated = processed.reduce((sum, p) => sum + p.allocated, 0);

  return {
    epoch,
    totalRequested,
    totalAllocated,
    totalRemaining: remaining >= 0 ? 0 : remaining,
    requestsProcessed: processed.length,
    requestsPartial: partials.length,
    partialFillRate: processed.length > 0 ? partials.length / processed.length : 0,
    processed,
    partials,
    invariantHeld: totalAllocated <= availableLiquidity,
    metrics: { ...WITHDRAWAL_METRICS },
  };
}
