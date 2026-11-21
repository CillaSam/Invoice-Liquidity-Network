#!/usr/bin/env node
/**
 * First-loss capital separation and accounting controls (#1306).
 *
 * Reference invariants (Trust & Liquidity Model §6, §7.5):
 *   - First-loss treasury buffer is separately accounted and never LP capital
 *   - Treasury withdrawals require multi-sig approval, distinct from LP operations
 *   - Treasury claim is capped at defined default coverage and pool balance
 *   - First-loss does not backstop locked (committed) invoice capital
 *   - Idle/projected repayments are liquid; committed/defaulted are not
 *
 * The module is pure: same input always produces same decision. Replays are
 * auditable and deterministic for operator review.
 */

export const FIRST_LOSS_METRICS = Object.freeze({
  treasuryBalance: 'iln_first_loss_treasury_balance',
  lpCapitalBalance: 'iln_lp_capital_balance',
  treasury_claims_total: 'iln_first_loss_claims_total',
  treasury_claim_denials_total: 'iln_first_loss_claim_denials_total',
  treasury_replenishment_requests: 'iln_first_loss_replenishment_requests',
});

export const DEFAULT_FIRST_LOSS_CONFIG = Object.freeze({
  treasuryCoverageRatio: 0.05, // 5% of pool TVL default
  maxClaimRatio: 0.5, // Single claim limited to 50% of remaining treasury
  requiredApprovals: Object.freeze(['compliance-lead', 'treasury-lead']),
});

export function initialFirstLossState() {
  return {
    treasuryBalance: 0,
    lpCapitalBalance: 0,
    totalInvoiceDefaults: 0,
    totalClaimsProcessed: 0,
    lastClaimAtMs: null,
    claimDenials: 0,
  };
}

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validate that first-loss treasury is properly separated from LP capital.
 *
 * @param {object} input accounting snapshot
 * @param {object} config governed thresholds
 * @returns {object} validation result with separated accounting
 */
export function validateFirstLossAccounting(
  input = {},
  config = DEFAULT_FIRST_LOSS_CONFIG
) {
  const treasuryBalance = input.treasuryBalance || 0;
  const lpCapitalTotal = input.lpCapitalTotal || 0;
  const poolTvl = input.poolTvl || 0;
  const committedCapital = input.committedCapital || 0;
  const idleCapital = input.idleCapital || 0;

  const issues = [];

  // Treasury and LP capital must be separately accounted
  if (treasuryBalance < 0) {
    issues.push('TREASURY_NEGATIVE_BALANCE');
  }
  if (lpCapitalTotal < 0) {
    issues.push('LP_CAPITAL_NEGATIVE');
  }
  if (treasuryBalance + lpCapitalTotal !== poolTvl) {
    issues.push('ACCOUNTING_DOES_NOT_BALANCE');
  }

  // Treasury is not part of LP liquidity pool
  const availableLpLiquidity = idleCapital;
  const expectedTreasurySize = poolTvl * config.treasuryCoverageRatio;
  if (Math.abs(treasuryBalance - expectedTreasurySize) > expectedTreasurySize * 0.1) {
    issues.push('TREASURY_SIZE_DRIFT');
  }

  // LP committed capital is locked, not available for first-loss
  if (committedCapital < 0) {
    issues.push('COMMITTED_CAPITAL_NEGATIVE');
  }
  if (committedCapital + idleCapital !== lpCapitalTotal) {
    issues.push('LP_CAPITAL_SPLIT_DOES_NOT_BALANCE');
  }

  const valid = issues.length === 0;

  return {
    valid,
    issues: [...issues].sort(),
    treasuryBalance,
    lpCapitalTotal,
    committedCapital,
    idleCapital,
    expectedTreasurySize,
    treasuryHealthRatio: expectedTreasurySize > 0 ? treasuryBalance / expectedTreasurySize : 0,
    lpLiquidityAvailable: availableLpLiquidity,
    metrics: { ...FIRST_LOSS_METRICS },
  };
}

/**
 * Evaluate a first-loss claim request against treasury and accounting rules.
 *
 * @param {object} input claim request and current state
 * @param {object} state prior first-loss state
 * @param {object} config governed limits
 * @returns {object} claim decision
 */
export function evaluateFirstLossClaim(
  input = {},
  state = initialFirstLossState(),
  config = DEFAULT_FIRST_LOSS_CONFIG
) {
  const claimAmount = input.claimAmount || 0;
  const invoiceId = input.invoiceId;
  const treasuryBalance = input.treasuryBalance || 0;
  const poolTvl = input.poolTvl || 0;

  const reasons = [];

  // Idempotency check
  if (input.alreadyClaimed) {
    reasons.push('ALREADY_CLAIMED_FOR_INVOICE');
  }

  // Treasury must have sufficient balance
  if (!isPositiveFinite(claimAmount) || claimAmount <= 0) {
    reasons.push('CLAIM_AMOUNT_INVALID');
  } else if (claimAmount > treasuryBalance) {
    reasons.push('INSUFFICIENT_TREASURY_BALANCE');
  }

  // Single claim cannot exceed configured ratio of treasury
  const maxClaimAmount = treasuryBalance * config.maxClaimRatio;
  if (claimAmount > maxClaimAmount) {
    reasons.push('CLAIM_EXCEEDS_SINGLE_CLAIM_LIMIT');
  }

  // Treasury is not meant to cover all defaults
  const totalExpected = poolTvl * config.treasuryCoverageRatio;
  if (claimAmount > totalExpected) {
    reasons.push('CLAIM_EXCEEDS_COVERAGE_CAP');
  }

  const approved = reasons.length === 0;
  const decision = approved ? 'CLAIM_APPROVED' : 'CLAIM_DENIED';

  return {
    approved,
    decision,
    invoiceId,
    claimAmount,
    treasuryBalance,
    reasons: [...reasons].sort(),
    maxClaimAmount,
    metrics: { ...FIRST_LOSS_METRICS },
  };
}

/**
 * Request treasury replenishment (requires multi-sig approval).
 *
 * @param {object} input replenishment request
 * @param {object} config governed approvals
 * @returns {object} approval result
 */
export function requestTreasuryReplenishment(
  input = {},
  config = DEFAULT_FIRST_LOSS_CONFIG
) {
  const approvals = Array.isArray(input.approvals) ? input.approvals : [];
  const replenishmentAmount = input.replenishmentAmount || 0;

  const issues = [];

  if (replenishmentAmount <= 0) {
    issues.push('REPLENISHMENT_AMOUNT_INVALID');
  }

  const granted = new Set(approvals);
  const missing = config.requiredApprovals.filter((role) => !granted.has(role));
  if (missing.length > 0) {
    issues.push('INSUFFICIENT_APPROVALS');
  }

  const approved = issues.length === 0;

  return {
    approved,
    replenishmentAmount,
    requiredApprovals: [...config.requiredApprovals],
    presentApprovals: [...approvals],
    missingApprovals: missing,
    issues: [...issues].sort(),
  };
}
