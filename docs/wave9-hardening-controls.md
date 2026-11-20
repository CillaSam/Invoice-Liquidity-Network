# Wave-9 Hardening Controls (Runbook)

**Status:** active, machine-checked
**Owner:** Protocol lead (circuit breaker, pricing), Compliance lead (settlement anchor), Infrastructure lead (indexer rollback)
**Recovery owner:** On-call lead named in the incident rotation
**Regression suite:** [`scripts/__tests__/wave9-hardening-controls.test.ts`](../scripts/__tests__/wave9-hardening-controls.test.ts)

This runbook is the operator-facing record for four independently deployable hardening outcomes:

| Issue | Control | Decision module |
| --- | --- | --- |
| #1307 | Circuit-breaker activation and recovery | [`circuit-breaker-controls.mjs`](../scripts/hardening/circuit-breaker-controls.mjs) |
| #1308 | Settlement-anchor enforcement evidence | [`settlement-anchor-enforcement.mjs`](../scripts/hardening/settlement-anchor-enforcement.mjs) |
| #1310 | Pricing deviation limits for redemptions | [`redemption-pricing-guard.mjs`](../scripts/hardening/redemption-pricing-guard.mjs) |
| #1316 | Indexer rollback without contract pause | [`indexer-rollback-rehearsal.mjs`](../scripts/hardening/indexer-rollback-rehearsal.mjs) |

The modules are pure, dependency-free decision layers. Services call them before taking an
irreversible action: assigning new settlement work, funding an invoice, approving a redemption
quote, or advancing an indexer cursor after a divergence. Every rejection is fail-closed and
carries a reason code and metric name.

## 1. Baseline and after-state

Measured on the upstream `main` tree before this change:

| Measure | Before | After |
| --- | ---: | ---: |
| Executable control modules in `scripts/hardening/` | 0 | 4 |
| Evidence runner modules | 0 | 1 |
| Regression cases (success/failure/replay/boundary) | 0 | 15 |
| Machine-readable evidence scenarios emitted per run | 0 | 12 |
| Runbook covering all four controls | 0 | 1 |
| Contract pauses required for indexer rollback rehearsal | 1 (assumed) | 0 |

## 2. Invariants and thresholds

### 2.1 Circuit breaker (#1307)

- Anchor error rate above 5% over a window of at least 20 samples opens the breaker.
- Liquid assets below 10% of pool TVL, queued withdrawals above 2.0x liquid assets, or a single
  LP above 25% of pool TVL opens the breaker.
- Missing/zero telemetry, too few samples, or a missing error count also opens the breaker. A
  measurement gap is never treated as a pass.
- A breaker reopens immediately on a live trigger. It clears only after **two consecutive clean
  epochs**. A manual clear requires both `protocol-lead` and `security-lead` approvals and does
  not suppress the next evaluation.
- Boundaries at exactly 5%, 10%, 2.0x, and 25% are allowed; the breach must be strict.

### 2.2 Settlement-anchor enforcement (#1308)

- Only a `clear` screening result with a recorded partner case reference may proceed.
- `potential_match` and `unavailable` results hold the request. No fiat instruction or
  on-chain settlement action is sent while held. Unavailable and unhealthy-route holds are
  retryable with an idempotency key derived from the request ID.
- The selected anchor must be registered, healthy, within its 15-minute health window, and
  support the corridor. A correlation check below two active anchors in the corridor rejects
  the assignment.
- Health age of exactly 15 minutes and exactly two active anchors are allowed.

### 2.3 Redemption pricing (#1310)

- A quote is approved only when it is within 200 bps of the median of at least two fresh
  reference prices. References older than 30 seconds are stale and excluded.
- Non-positive quotes, missing observation time, fewer than two fresh sources, or fresh sources
  disagreeing by more than 500 bps are rejected.
- Deviation of exactly 200 bps is allowed; anything above is rejected.

### 2.4 Indexer rollback (#1316)

- The rehearsal selects the last checkpoint at or before the simulated divergence, replays the
  contiguous event sequence, and verifies the rebuilt checksum.
- `contractPaused: true` invalidates the exercise. The control records `contractPauseUsed: false`
  on every plan, including failed ones.
- A replay gap, missing safe checkpoint, or checksum mismatch pins the indexer at the retained
  checkpoint and fails closed; it never advances on incomplete state.
- A divergence exactly at a checkpoint is valid and replays zero events.

## 3. Operator commands

Run the deterministic evidence matrix (no network, no database, no install required):

```bash
node scripts/hardening/run-wave9-controls.mjs --json --out wave9-controls-evidence.json
```

The command exits non-zero if any expected outcome drifts. Attach the JSON file to the change
record as the CI/operational artifact. It contains all four control groups, the governed metric
names, the observed outcome of each scenario, and the `contractPauseUsed` flag.

Run the regression suite in CI with:

```bash
pnpm exec vitest run scripts/__tests__/wave9-hardening-controls.test.ts
```

## 4. Metric names and alerting handoff

| Control | Metrics emitted by the calling service |
| --- | --- |
| #1307 | `iln_circuit_breaker_active`, `iln_circuit_breaker_activations_total`, `iln_circuit_breaker_recoveries_total`, `iln_circuit_breaker_manual_overrides_total` |
| #1308 | `iln_settlement_anchor_decisions_total`, `iln_settlement_anchor_holds_total` |
| #1310 | `iln_redemption_pricing_decisions_total`, `iln_redemption_pricing_rejects_total` |
| #1316 | `iln_indexer_rollback_rehearsals_total`, `iln_indexer_rollback_failures_total`, `iln_indexer_safe_checkpoint_ledger` |

The decision modules expose the metric names in their exported `*_METRICS` constants so a rename
in a service cannot silently drift from this runbook. A removed metric constant fails the
regression suite.

## 5. Recovery paths

| Condition | Detection | Recovery |
| --- | --- | --- |
| Breaker open | `iln_circuit_breaker_active == 1` | Restore the failing telemetry source or the governed threshold condition; wait two clean epochs. For a verified false positive, obtain both governed approvals and call `requestManualClear` / `applyManualClear`. |
| Settlement hold | `iln_settlement_anchor_holds_total` increase | Potential matches are released only by the partner's documented case-resolution channel with a recorded case reference. Unavailable or unhealthy routes are retried with the same idempotency key. |
| Redemption reject | `iln_redemption_pricing_rejects_total` increase | Add a fresh independent reference source or correct the quote. Never lower the deviation limit at runtime; limits are governed. |
| Indexer rollback failure | `iln_indexer_rollback_failures_total` increase | Keep the indexer pinned at the retained checkpoint, restore the missing replay events or checksum source, then rerun the rehearsal. Do not pause the contract. |

## 6. Compatibility and cross-repository notes

- No Soroban contract method, event, or storage layout is changed by this work. The controls are
  off-chain decision layers that call the existing contract/anchor interfaces.
- The smart-contract repository (`ILN-Smart-Contract`) remains the source of truth for on-chain
  enforcement. These modules do not weaken any on-chain or partner control; they add fail-closed
  checks in front of them.
- Adding a new service caller requires no migration here: the modules export plain functions and
  frozen constant objects, and all inputs are explicit, so callers can be added without changing
  existing decision semantics.
- A change to any governed threshold must update the module constant, this runbook, and the
  boundary cases in the regression suite in the same change.
