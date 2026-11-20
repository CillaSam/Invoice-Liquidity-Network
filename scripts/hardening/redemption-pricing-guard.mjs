#!/usr/bin/env node
/**
 * Pricing deviation limits for redemptions (#1310).
 *
 * A redemption quote is approved only when it is within a governed number
 * of basis points of the median of at least two fresh independent reference
 * prices. Missing, stale, non-positive, or wildly disagreeing references
 * never count as a pass: the guard fails closed with an explicit code.
 *
 * The function is pure so a replay, a restart, or a different call order
 * cannot change the outcome for the same inputs.
 */

export const PRICING_GUARD_METRICS = Object.freeze({
  decisions: 'iln_redemption_pricing_decisions_total',
  rejects: 'iln_redemption_pricing_rejects_total',
});

export const DEFAULT_PRICING_GUARD_CONFIG = Object.freeze({
  maxDeviationBps: 200,
  maxStalenessMs: 30_000,
  minFreshSources: 2,
  maxSourceSpreadBps: 500,
});

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

function medianOf(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * @param {object} input quote, reference sources, and observation time
 * @param {object} config governed deviation/staleness thresholds
 * @returns {object} deterministic approval decision with evidence fields
 */
export function evaluateRedemptionPricing(input = {}, config = DEFAULT_PRICING_GUARD_CONFIG) {
  const quote = input.quotedPrice;
  const now = input.nowMs;
  const sources = Array.isArray(input.referenceSources) ? input.referenceSources : [];

  const base = {
    quote: isPositiveFinite(quote) ? quote : null,
    limitBps: config.maxDeviationBps,
    deviationBps: null,
    referencePrice: null,
    freshSources: 0,
    staleSources: sources.length,
    spreadBps: null,
    metrics: { ...PRICING_GUARD_METRICS },
  };

  if (!isPositiveFinite(quote)) {
    return { ...base, approved: false, code: 'INVALID_QUOTE' };
  }
  if (!Number.isFinite(now)) {
    return { ...base, approved: false, code: 'OBSERVATION_TIME_UNAVAILABLE' };
  }

  const fresh = sources.filter(
    (source) =>
      source &&
      isPositiveFinite(source.price) &&
      Number.isFinite(source.observedAtMs) &&
      source.observedAtMs <= now &&
      now - source.observedAtMs <= config.maxStalenessMs
  );
  const result = {
    ...base,
    freshSources: fresh.length,
    staleSources: sources.length - fresh.length,
  };

  if (fresh.length < config.minFreshSources) {
    return { ...result, approved: false, code: 'PRICE_REFERENCE_UNAVAILABLE' };
  }

  const prices = fresh.map((source) => source.price).sort((a, b) => a - b);
  const referencePrice = medianOf(prices);
  const spreadBps = round(((prices[prices.length - 1] - prices[0]) / referencePrice) * 10_000);
  const deviationBps = round((Math.abs(quote - referencePrice) / referencePrice) * 10_000);

  const withReference = {
    ...result,
    referencePrice: round(referencePrice),
    spreadBps,
    deviationBps,
  };

  if (spreadBps > config.maxSourceSpreadBps) {
    return { ...withReference, approved: false, code: 'PRICE_SOURCES_DISAGREE' };
  }
  if (deviationBps > config.maxDeviationBps) {
    return { ...withReference, approved: false, code: 'PRICE_DEVIATION_EXCEEDED' };
  }
  return { ...withReference, approved: true, code: 'PRICE_WITHIN_LIMITS' };
}
