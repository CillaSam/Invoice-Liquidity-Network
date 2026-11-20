# Trust & Liquidity Model ↔ Deployed Contract Reconciliation

**Status:** v1 (binding; machine-checked via
[`tests/synthetic/trust-liquidity-reconciliation.test.ts`](../tests/synthetic/trust-liquidity-reconciliation.test.ts))
**Owner:** Protocol lead
**Companion documents:** [Trust & Liquidity Model](./trust-liquidity-model.md),
[Investor-Facing Liquidity Limitation Disclosures](./investor-disclosures-liquidity.md)

---

This document reconciles every liquidity claim the Trust & Liquidity Model
makes with the deployed contract behavior that is expected to back it. It
exists so a reader cannot confuse an aspirational specification with an
implemented control (#1312).

The applicable Soroban implementation lives in the separate
[`ILN-Smart-Contract`](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract)
repository. The reconciliation below is maintained *in this* repository
because the model doc is here; cross-repo drift is caught via the
`iln_liquidity_feature_enabled` scraped flag and the `ILNLiquidityMetricsMissing`
alert (see
[`monitoring/prometheus/liquidity-alerts.yml`](../monitoring/prometheus/liquidity-alerts.yml)).

## 1. Contract-behavior status codes

Each reconciliation row carries one status; combinations are not permitted.

| Status | Meaning |
|---|---|
| `IMPLEMENTED` | The claim is enforced by on-chain code in `ILN-Smart-Contract` **and** has a named test / event in the contract repository. |
| `SIMULATED` | The claim is not yet on-chain but is reproduced by a deterministic simulation in this repository with regression tests. |
| `DESIGN_ONLY` | The claim is a design specification. No on-chain or simulated enforcement exists; the model doc says so explicitly. |
| `DISCLOSED` | The claim is a user-visible disclosure, not a mechanism. Enforcement is contractual / off-chain. |

A row whose status drifts from these four values fails the reconciliation test.

## 2. Reconciliation table

| Claim in `trust-liquidity-model.md` | §-anchor | Status | Evidence |
|---|---|---|---|
| Invoice contract supports partial funding + LP priority queue | §6.1 | `IMPLEMENTED` | `ILN-Smart-Contract` invoice funding / priority-queue tests (see cross-repo link); no new control added here. |
| Committed capital is locked until repayment or another terminal outcome | §6.1 | `IMPLEMENTED` | Enforced by the invoice contract's state machine (`ILN-Smart-Contract`). |
| 5% treasury first-loss provision covers credit losses, not liquidity | §6.1, §7.5 | `IMPLEMENTED` | Treasury multi-sig + accounting, separate from pool accounting. |
| §6.2 simultaneous-withdrawal fulfilment table (25 / 50 / 75 / 90% severities) | §6.2 | `SIMULATED` | [`scripts/redemption-stress-simulation.mjs`](../scripts/redemption-stress-simulation.mjs) + `tests/synthetic/redemption-stress-simulation.test.ts`. The table is derived from the simulation, not from on-chain data. |
| Pooled LP shares / withdrawal queue state machine (§7.3) | §7.3 | `DESIGN_ONLY` | No on-chain code yet; §7 is binding on the future implementation. The model is explicit: *"must be implemented and tested before pooled LP shares are deployed to mainnet"*. |
| `submit_withdrawal` / `cancel_withdrawal` / `process_epoch` contract methods | §7.7 | `DESIGN_ONLY` | Required contract methods list; not yet shipped. |
| `WithdrawalSubmitted` / `WithdrawalCancelled` / `WithdrawalProcessed` events | §7.7 | `DESIGN_ONLY` | Required event list; not yet shipped. |
| `liquidity_coverage_ratio` metric @ < 0.5 for 2 epochs | §7.8 | `IMPLEMENTED` | Alert `ILNLiquidityCoverageRatioLow` in [`liquidity-alerts.yml`](../monitoring/prometheus/liquidity-alerts.yml). Series absent on prod today → `ILNLiquidityMetricsMissing` fires via the presence guard. |
| `oldest_queued_request_age` > 28 days | §7.8 | `IMPLEMENTED` | Alert `ILNWithdrawalQueueStale`. |
| `circuit_breaker_active` | §7.6, §7.8 | `IMPLEMENTED` | Alert `ILNFundingCircuitBreakerActive` + feature-flag guarded. |
| `partial_fill_rate` > 50% | §7.8 | `IMPLEMENTED` | Alert `ILNHighPartialFillRate`. |
| Investor-facing clauses 1–7 of `docs/investor-disclosures-liquidity.md` | §6, §7 | `DISCLOSED` | Enforced by LP onboarding presenting the disclosure; machine-checked by `tests/synthetic/investor-disclosures-liquidity.test.ts`. |
| Anchor outage timelocked auto-revert | §5.2 (2) | `IMPLEMENTED` | SEP-24 timelocked cancellation in the invoice contract. |
| Multi-anchor fallback routing | §5.2 (3), §5.3 | `IMPLEMENTED` | Client-side SEP-compliant anchor registry + health checks (see `ILN-Smart-Contract` anchor adapter). |

## 3. Keeping the reconciliation honest

Three rules protect this document from quiet drift:

1. **No row marked `IMPLEMENTED` without a named artefact in the "Evidence"
   column.** The companion test rejects an `IMPLEMENTED` row whose evidence
   cell is empty or does not cite either an alert name (via the alert file)
   or a cross-repo `ILN-Smart-Contract` reference.
2. **`DESIGN_ONLY` cannot be changed to `IMPLEMENTED` without updating the
   model doc first.** The test cross-checks that the model text no longer
   claims the control is pending ("not yet shipped", "must be implemented",
   "not yet written"). A promotion that forgets to update §7 is caught.
3. **`SIMULATED` rows must name a script path and a test path, both of which
   must exist on disk** — a stub simulation that is only documentation fails.

## 4. Acceptance criteria mapping

Issue #1312 asks for the reconciliation to:

- **Reproduce the audited gap.** The model doc's strongest claim is §7's
  pooled-LP mechanism; the deployed contract behavior is that §7 is
  design-only. This document names that gap explicitly.
- **Add automated validation that fails if the regression returns.** See
  `tests/synthetic/trust-liquidity-reconciliation.test.ts`.
- **Record operational evidence of the control.** Each row cites an alert
  rule, a script, or a cross-repo artefact. A commit that removes any of
  them fails the reconciliation test before merge.
- **Preserve compatibility.** No contract method or event is renamed in this
  PR; the reconciliation only documents and locks in the existing surface.

## 5. Baseline

Baseline at the first write of this document: **9 `IMPLEMENTED`, 1 `SIMULATED`,
3 `DESIGN_ONLY`, 1 `DISCLOSED`**, 14 rows total. Any PR that changes a row
status must also update this baseline section and attach the before/after
counts in the PR description.

---

*This reconciliation is maintained alongside the Trust & Liquidity Model and
the investor disclosure page. A merge that updates one without the other is
rejected by CI.*
