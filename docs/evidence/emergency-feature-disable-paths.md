# Emergency Feature-Disable and Kill-Switch Paths
## Issue #1327: Test emergency feature-disable paths

**Date Recorded:** 2026-11-21  
**Owner:** @ibrahimmujidah1-stack  
**Status:** Operational Control Active  
**Complexity:** High (200 pts)

---

## Executive Summary

This evidence document records the implementation and verification of the emergency feature-disable and kill-switch control paths, an independently deployable hardening outcome for the Invoice-Liquidity-Network. The control provides fine-grained, fail-closed operational kill switches across smart contracts, indexers, oracles, notifications, and settlement anchors, ensuring rapid containment during outages without requiring full protocol shutdown or risking data loss.

---

## 1. Baseline Measurement (Before vs After)

| Metric / Dimension | Baseline Value (Before) | Hardened Value (After) | Evidence |
|---|---|---|---|
| Emergency pause granularity | All-or-nothing smart contract pause | Fine-grained service and feature kill switches | `scripts/hardening/emergency-feature-disable.mjs` |
| Operator authorization | Unenforced at service level | Role-based verification (admin, incident-commander) | `isAuthorizedOperator()` |
| Rejection code on disabled path | Generic error or timeout | Explicit `SERVICE_PAUSED` with immediate fail-closed | `evaluateFeatureAccess()` |
| Idempotency guarantee | Unverified | Multiple disable or enable calls are idempotent | `idempotent: true` |
| Rehearsal automation | Manual testnet script execution | Automated rehearsal test covering all 7 lifecycle phases | `rehearseFeatureDisableScenario()` |
| State preservation verification | Manual observation | Automated assertion that state is unmodified on reject | Unit & integration tests |

---

## 2. Production Implementation

The emergency feature-disable control module is implemented at `scripts/hardening/emergency-feature-disable.mjs`. It provides a deterministic state machine managing emergency stop toggles:

```javascript
export const SUPPORTED_FEATURE_PATHS = Object.freeze({
  contracts: Object.freeze(['funding', 'repayment', 'transfers', 'invoicing']),
  indexer: Object.freeze(['ingestion', 'reorg_detection']),
  oracle: Object.freeze(['live_quotes', 'circuit_breaker_bypass']),
  notifications: Object.freeze(['outbound_dispatch', 'provider_fallback']),
  settlement: Object.freeze(['anchor_routing', 'fiat_payouts']),
});
```

### 2.1 Enforced Invariants

1. **Fail-Closed Access Evaluation**: When a feature is disabled, any request targeting that path is rejected immediately with code `SERVICE_PAUSED` before touching databases, balances, or external providers.
2. **State and Queue Preservation**: Disabling a feature stops forward execution but does not purge in-flight queues, delete checkpoints, or mutate contract balances.
3. **Authorized Control Only**: Only authorized operators (`admin`, `incident-commander`, `security-lead`, `protocol-lead`) can disable or restore features. Unauthorized requests fail with `OPERATOR_UNAUTHORIZED`.
4. **Idempotent Toggles**: Re-disabling an already disabled feature or re-enabling an active feature succeeds safely without state corruption.
5. **Clean Recovery**: Re-enabling a feature immediately restores access and resumes processing without duplicating events or dropping queued entries.

---

## 3. Verification and Automated Test Coverage

The control is verified via `scripts/__tests__/wave9-operations-hardening.test.mjs` and `tests/wave-nine-operations-hardening.test.ts`:

- **Baseline access**: Confirms normal operations are permitted when features are active.
- **Unauthorized rejection**: Rejects non-operator disable attempts with `OPERATOR_UNAUTHORIZED`.
- **Authorized disable**: Verifies clean state transition to disabled.
- **Fail-closed verification**: Confirms operations fail with `SERVICE_PAUSED` and increment rejection metrics without state mutation.
- **Idempotency verification**: Confirms repeat disable calls are recorded as idempotent.
- **Authorized recovery**: Restores feature access and resets active disable counters.
- **7-Phase rehearsal execution**: Validates the end-to-end incident lifecycle automatically.

---

## 4. Operational Evidence

### 4.1 Prometheus Metrics

```prometheus
# HELP iln_emergency_disables_total Total count of emergency feature-disable invocations
# TYPE iln_emergency_disables_total counter

# HELP iln_emergency_recoveries_total Total count of feature recovery invocations
# TYPE iln_emergency_recoveries_total counter

# HELP iln_emergency_rejections_total Total count of rejected operations while features are disabled
# TYPE iln_emergency_rejections_total counter

# HELP iln_emergency_active_disables Current count of actively disabled feature paths
# TYPE iln_emergency_active_disables gauge
```

### 4.2 CI/CD Execution Command

```bash
node scripts/hardening/emergency-feature-disable.mjs
```

---

## 5. Adjacent Service Impact

- **Contracts**: Enables pausing high-risk paths (e.g. funding) while allowing debt repayments and liquidations to continue safely.
- **Indexer**: Permits pausing block ingestion during chain reorgs without losing safe cursor checkpoints.
- **Oracle & Notifications**: Prevents bad quote dissemination or provider alert storms during downstream outages.

---

## 6. Acceptance Criteria Met

- [x] Production behavior implemented (deterministic kill-switch state machine, not documentation-only).
- [x] Automated tests covering success, failure, replay/restart, and boundary conditions.
- [x] Operational evidence (metrics, logs, and rehearsal runner) active.
- [x] Full multi-service feature matrix verified.
