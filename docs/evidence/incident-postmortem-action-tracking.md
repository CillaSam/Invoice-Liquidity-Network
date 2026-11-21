# Incident Postmortem Action Item Tracking and SLA Enforcement
## Issue #1326: Add incident postmortem action tracking

**Date Recorded:** 2026-11-21  
**Owner:** @ibrahimmujidah1-stack  
**Status:** Operational Control Active  
**Complexity:** High (200 pts)

---

## Executive Summary

This evidence document records the implementation and verification of the incident postmortem action tracking tool, an independently deployable hardening outcome for the Invoice-Liquidity-Network. The control parses postmortem action tables across all incident files, validates assigned ownership, tracks completion SLAs, flags overdue remediations, and ensures that corrective and preventative actions are enforced before recurrence.

---

## 1. Baseline Measurement (Before vs After)

| Metric / Dimension | Baseline Value (Before) | Hardened Value (After) | Evidence |
|---|---|---|---|
| Postmortem enforcement scope | File existence check within 72h | Action item schema parsing and SLA enforcement | `scripts/hardening/postmortem-action-tracking.mjs` |
| Action item ownership | Unvalidated text in markdown | Strict @username handle requirement (no TBD/unassigned) | `validateActionItem()` |
| Due date & status validation | Free-form text | Strict YYYY-MM-DD date and valid status lifecycle | `VALID_ACTION_STATUSES` |
| Overdue action detection | None; manual spreadsheet tracking | Automated calendar-based overdue detection | `isOverdue` calculation |
| Action tracking metrics | 0 metrics emitted | 4 operational Prometheus metrics | `POSTMORTEM_TRACKING_METRICS` |

---

## 2. Production Implementation

The postmortem action tracking tool is implemented at `scripts/hardening/postmortem-action-tracking.mjs`. It extracts Section 6 tables from postmortems, validates schema requirements, and calculates SLA compliance:

```javascript
export const VALID_ACTION_TYPES = Object.freeze(new Set(['Corrective', 'Preventative']));
export const VALID_ACTION_STATUSES = Object.freeze(
  new Set(['TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED'])
);
```

### 2.1 Enforced Action Item Invariants

1. **Explicit Ownership**: Every action item must have a named owner prefixed with `@` (e.g. `@backend-lead`). Unassigned, empty, or TBD owners fail validation.
2. **Action Classification**: Must be categorized as either `Corrective` (remediating immediate root cause) or `Preventative` (systemic defect prevention).
3. **Target Repository**: Must target a known repository (`Invoice-Liquidity-Network`, `ILN-Frontend`, `ILN-Smart-Contract`, or `ILN-Infrastructure`).
4. **Calendar Due Date**: Must use `YYYY-MM-DD` formatting and parse to a valid date.
5. **Overdue Detection**: Items in `TODO`, `IN_PROGRESS`, or `BLOCKED` with due dates prior to the audit timestamp are automatically flagged as overdue.

---

## 3. Verification and Automated Test Coverage

The control is verified via `scripts/__tests__/wave9-operations-hardening.test.mjs` and `tests/wave-nine-operations-hardening.test.ts`:

- **Markdown table parser**: Accurately parses Section 6 markdown tables across single and multi-line rows.
- **Valid schema acceptance**: Confirms valid action items pass verification.
- **Invalid owner rejection**: Rejects unassigned or placeholder owners with actionable error messages.
- **Overdue detection test**: Injects an expired due date and verifies `isOverdue: true` is computed.
- **Repository postmortems audit**: Audits all files in `docs/postmortems/` and verifies zero parse or schema errors.
- **Restart / Replay Determinism**: Repeated audits produce identical counts and statuses.

---

## 4. Operational Evidence

### 4.1 Prometheus Metrics

```prometheus
# HELP iln_postmortem_actions_total Total count of tracked incident action items
# TYPE iln_postmortem_actions_total counter

# HELP iln_postmortem_actions_overdue Current count of overdue incident action items
# TYPE iln_postmortem_actions_overdue gauge

# HELP iln_postmortem_actions_completed Total count of completed incident action items
# TYPE iln_postmortem_actions_completed counter

# HELP iln_postmortem_tracking_audits_total Total count of postmortem action tracking audits
# TYPE iln_postmortem_tracking_audits_total counter
```

### 4.2 CI/CD Execution Command

```bash
node scripts/hardening/postmortem-action-tracking.mjs --dir docs/postmortems
```

---

## 5. Adjacent Service Impact

- **ILN-Frontend**: Tracks UI fallback and error presentation remediations assigned to frontend leads.
- **ILN-Smart-Contract**: Tracks protocol invariant assertions and smart contract upgrade action items.
- **Operations & Security**: Enforces accountability so incident learnings result in permanent code fixes.

---

## 6. Acceptance Criteria Met

- [x] Production behavior implemented (automated action tracking engine, not documentation-only).
- [x] Automated tests covering success, failure, replay/restart, and boundary conditions.
- [x] Operational evidence (metrics, logs, and audit commands) active.
- [x] Verified against repository postmortems in `docs/postmortems/`.
