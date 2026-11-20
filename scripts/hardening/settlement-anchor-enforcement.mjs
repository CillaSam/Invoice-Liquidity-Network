#!/usr/bin/env node
/**
 * Settlement-anchor enforcement evidence (#1308).
 *
 * A fiat instruction or on-chain settlement action is allowed only when the
 * partner screening result is `clear` with a recorded case reference, the
 * chosen anchor is registered, healthy for the corridor, and the corridor
 * still has at least two independent active anchors. A potential match,
 * an unavailable/malformed screening response, or a degraded route fails
 * closed as a hold or rejection instead of being treated as approval.
 *
 * The module is pure: replaying a request produces the same decision and
 * the same idempotency key, which makes the enforcement decision auditable.
 */

export const SETTLEMENT_ANCHOR_METRICS = Object.freeze({
  decisions: 'iln_settlement_anchor_decisions_total',
  holds: 'iln_settlement_anchor_holds_total',
});

export const DEFAULT_SETTLEMENT_ANCHOR_CONFIG = Object.freeze({
  minAnchorsPerCorridor: 2,
  maxHealthAgeMs: 15 * 60 * 1000,
  requiredScreeningStatus: 'clear',
});

/**
 * @param {object} input request, screening result, anchor health and corridor
 * @param {object} config governed enforcement thresholds
 * @returns {object} deterministic allow/hold/reject decision with evidence
 */
export function evaluateSettlementAnchor(input = {}, config = DEFAULT_SETTLEMENT_ANCHOR_CONFIG) {
  const screening = input.screening && typeof input.screening === 'object' ? input.screening : {};
  const anchor = input.anchor && typeof input.anchor === 'object' ? input.anchor : {};
  const now = input.nowMs;
  const codes = [];
  const status = screening.status;

  if (status !== config.requiredScreeningStatus) {
    codes.push(
      status === 'potential_match' ? 'SCREENING_POTENTIAL_MATCH' : 'SCREENING_UNAVAILABLE'
    );
  } else if (typeof screening.caseReference !== 'string' || screening.caseReference.length === 0) {
    codes.push('SCREENING_CASE_REFERENCE_MISSING');
  }

  if (!anchor.registered) {
    codes.push('ANCHOR_NOT_REGISTERED');
  }

  let healthAgeMs = null;
  if (Number.isFinite(now) && Number.isFinite(anchor.lastHealthCheckMs)) {
    healthAgeMs = now - anchor.lastHealthCheckMs;
  }
  if (
    !anchor.healthy ||
    healthAgeMs === null ||
    healthAgeMs < 0 ||
    healthAgeMs > config.maxHealthAgeMs
  ) {
    codes.push('ANCHOR_UNHEALTHY');
  }

  const corridors = Array.isArray(anchor.supportedCorridors) ? anchor.supportedCorridors : [];
  if (!corridors.includes(input.corridor)) {
    codes.push('ANCHOR_CORRIDOR_UNSUPPORTED');
  }

  const activeAnchors = input.activeAnchorsForCorridor;
  if (!Number.isFinite(activeAnchors) || activeAnchors < config.minAnchorsPerCorridor) {
    codes.push('ANCHOR_DIVERSIFICATION_INSUFFICIENT');
  }

  const held = codes.some((code) => code.startsWith('SCREENING_'));
  const decision = codes.length === 0 ? 'allow' : held ? 'hold' : 'reject';

  return {
    decision,
    allowed: decision === 'allow',
    codes: [...codes].sort(),
    requestId: input.requestId ?? null,
    idempotencyKey: `settlement:${input.requestId ?? 'unknown'}`,
    corridor: input.corridor ?? null,
    anchorId: anchor.id ?? null,
    caseReference: typeof screening.caseReference === 'string' ? screening.caseReference : null,
    healthAgeMs,
    activeAnchorsForCorridor: Number.isFinite(activeAnchors) ? activeAnchors : null,
    minAnchorsPerCorridor: config.minAnchorsPerCorridor,
    retryable:
      codes.includes('SCREENING_UNAVAILABLE') ||
      codes.includes('ANCHOR_UNHEALTHY') ||
      codes.includes('ANCHOR_DIVERSIFICATION_INSUFFICIENT'),
    metrics: { ...SETTLEMENT_ANCHOR_METRICS },
  };
}
