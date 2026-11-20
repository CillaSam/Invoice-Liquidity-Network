# Investor-Facing Liquidity Limitation Disclosures

**Status:** v1 (binding alongside [Trust & Liquidity Model §6–§7](./trust-liquidity-model.md))
**Owner:** Protocol lead · Compliance operator
**Audience:** Prospective and active liquidity providers; auditors

---

This document is the investor-facing surface for the liquidity-risk claims that
`docs/trust-liquidity-model.md` makes to internal reviewers. It is intentionally
narrower and plainer than the model, and reproduces the limitation language that
onboarding flows must present *before* an LP commits capital. It is paired with
a machine-checked reconciliation (`docs/trust-liquidity-reconciliation.md`) so
the two cannot drift without a visible test failure (#1314).

The authoritative control surface — thresholds, state machine, event schema —
lives in [`docs/trust-liquidity-model.md` §7](./trust-liquidity-model.md). This
page repeats only the user-visible consequences.

## 1. What liquidity providers must acknowledge before committing capital

Every LP onboarding flow must present these statements verbatim or with equivalent
and not-less-prominent wording. The checklist is also published on the public
status page and reproduced in the LP agreement.

1. **No synchronous full redemption.** Committing capital to the pool does not
   grant an on-demand right to withdraw it. Locked capital becomes available
   only as the invoices it funded repay or reach another contract-defined
   terminal outcome (default, write-off, restructuring). See
   [Trust & Liquidity Model §6.1](./trust-liquidity-model.md) and
   [§7.5](./trust-liquidity-model.md) for the exact definitions.
2. **Notice period is required.** Withdrawal requests cannot be processed in
   the same epoch they are submitted. A request submitted in epoch N becomes
   eligible in epoch N+1, with a protocol-governed maximum of
   `MAX_NOTICE_EPOCHS` (default 4 epochs = 28 days). See
   [§7.2](./trust-liquidity-model.md).
3. **Pro-rata fairness, not first-come-first-served.** Within an epoch, every
   eligible withdrawal is satisfied proportionally from available liquidity.
   LPs who submit earlier within an epoch do not jump ahead of LPs who submit
   later in the same epoch. See [§7.1 (2)](./trust-liquidity-model.md) and
   [§7.4](./trust-liquidity-model.md).
4. **The protocol can pause new funding.** When available liquidity drops
   below a governed floor, when queued withdrawals exceed a governed multiple
   of available cash, or when a single LP's queued share crosses the
   concentration cap, the protocol stops deploying capital to new invoices
   until the condition clears. See [§7.6](./trust-liquidity-model.md). A
   funding pause does not impair existing invoice cash-flows, but it does
   slow the rate at which new idle cash becomes available.
5. **A liquidity-cliff scenario is possible.** `docs/trust-liquidity-model.md`
   §6.2 and the executable
   [`scripts/redemption-stress-simulation.mjs`](../scripts/redemption-stress-simulation.mjs)
   show that a simultaneous 90%-of-pool withdrawal can be met only
   partially (≈44% immediate fulfilment against the published baseline
   pool). The remainder waits in the queue for invoice repayments or
   terminal resolutions.
6. **The treasury first-loss provision is not liquidity.** The 5% treasury
   buffer absorbs a defined slice of credit losses on defaults. It does not
   make locked invoice capital available during a withdrawal run and is not
   available to an LP who simply wants to exit the pool. See
   [§6.1](./trust-liquidity-model.md) and [§7.5](./trust-liquidity-model.md).
7. **Anchor outages delay fiat, not on-chain funds.** If a Stellar Anchor
   Network partner has an operational outage, the smart-contract escrow
   remains non-custodial and timelocked auto-revert is available. In an
   anchor insolvency event, unredeemed fiat vouchers at that anchor are at
   risk; on-chain positions are not. See
   [§5.1 & §5.2](./trust-liquidity-model.md).

## 2. Public liquidity-status disclosures

While pooled LP shares are live, the protocol publishes the following series
daily (and on every withdrawal-epoch cutoff) on the public status page and via
the indexer's metrics endpoint. Any outage of this publication is itself a
monitored condition (`ILNLiquidityMetricsMissing`,
[`monitoring/prometheus/liquidity-alerts.yml`](../monitoring/prometheus/liquidity-alerts.yml)):

| Disclosure | Source metric | Investor interpretation |
|---|---|---|
| Available liquidity | `iln_available_liquidity_units` | Idle cash eligible to satisfy today's queue |
| Total committed | `iln_total_committed_units` | Capital locked to active invoices |
| Total queued withdrawals | `iln_total_queued_withdrawals_units` | What the current epoch must fulfil |
| Liquidity coverage ratio | `iln_liquidity_coverage_ratio` | Share of the queue the protocol can satisfy immediately; capped at 1.0 |
| Oldest queued request age | `iln_oldest_queued_request_age_seconds` | Worst-case notice already incurred by any LP |
| Partial fill rate (last epoch) | `iln_partial_fill_rate_last_epoch` | Fraction of requests that paid less than requested |
| Circuit breaker status | `iln_circuit_breaker_active` | 1 if new funding is paused; see §4 above |

## 3. Scenario disclosure: what LPs see in a stressed-liquidity run

The protocol publishes the current output of
[`scripts/redemption-stress-simulation.mjs`](../scripts/redemption-stress-simulation.mjs)
on the status page as the canonical "what if everyone exits at once" view.
For the baseline pool (100 units total, 60 committed, 40 idle) the published
fulfilment table is:

| Simultaneous-exit severity | Immediate fulfilment | Queued to next epoch |
|---:|---:|---:|
| 25% of pool | 100% | 0 |
| 50% of pool | 80% | 10 |
| 75% of pool | 53.3% | 35 |
| 90% of pool | 44.4% | 50 |
| 100% of pool | 40% | 60 |

The simulation is deterministic, offline, and re-runnable from the repository.
Its reconciliation against this table is covered by
`tests/synthetic/redemption-stress-simulation.test.ts`, which fails CI if the
numbers presented to investors drift from the executable model (#1313).

## 4. What investors should ask their advisors about

These risks are not resolved by the smart contract or by this protocol:
local tax treatment of pool interests, regulatory classification of the LP
position in the investor's jurisdiction, ability to custody the position
with their preferred custodian, and the effect of a protocol pause on any
leveraged or derivative exposures they hold against the pool. The
[Privacy Policy](./privacy.md) covers how onboarding data is retained.

## 5. Change control

Changes to the disclosures in §1 require, at minimum:

- A pull request against this file and `docs/trust-liquidity-model.md`.
- Compliance operator review (sign-off recorded in the PR).
- A green run of `tests/synthetic/redemption-stress-simulation.test.ts`
  and `tests/synthetic/investor-disclosures-liquidity.test.ts`.
- A changeset entry calling out the investor-visible change so the public
  changelog reflects the update before the next release.

---

*This disclosure is binding on the pooled-LP deployment described in Trust &
Liquidity Model §7 and must be presented before an LP commits capital.*
