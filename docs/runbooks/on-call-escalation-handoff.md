# On-call Escalation and Handoff Runbook

Issue #1329 requires a named owner, a tested escalation path, and a repeatable
handoff for mainnet operations. This runbook is the operator-facing companion
to [`ops/on-call-checklist.json`](../../ops/on-call-checklist.json).

**Control owner:** @infrastructure-lead
**Recovery owner:** @devops-oncall
**Escalation owner:** @security-lead

## 2. Owners and escalation

| Role | Owner | Responsibility |
| --- | --- | --- |
| Primary | @infrastructure-lead | Owns the control and approves handoff evidence. |
| On-call | @sre-oncall | First responder for indexer, oracle, notifications, and RPC alerts. |
| Secondary | @devops-oncall | Backs up on-call and owns deployment rollback. |
| Escalation | @security-lead | Security incidents and P1 escalation authority. |
| Checklist owner | @infrastructure-lead | Keeps the manifest, runbook, and checklist in sync. |

Acknowledgement target: **15 minutes**. P1 escalation target: **15 minutes**.
P2 escalation target: **60 minutes**. Paging uses the existing
`ALERT_WEBHOOK_URL`; the war room is `#incident-response` and the contact
channel is `#iln-on-call`. If the pager webhook is missing or rejects the
event, treat the control as failed and escalate through `#iln-on-call` rather
than silencing the alert.

## 3. Handoff checklist

The outgoing and incoming owners must complete and record all of the following
before the manifest's `last_handoff` / `next_handoff_due` dates are advanced:

- [ ] Open incidents and their current incident commander are listed.
- [ ] RPC, indexer, oracle, and notifications health is checked and recorded.
- [ ] Pending deployments, rollbacks, and release PRs are reviewed.
- [ ] The P1 paging path (`ALERT_WEBHOOK_URL` → `#incident-response`) was tested.
- [ ] Access to dashboards, status page, and alert routing is confirmed.
- [ ] Incoming owner explicitly acknowledges the handoff in `#iln-on-call`.

Handoffs occur every 7 days and must be logged in the issue/PR that updates the
manifest. Do not update the dates to satisfy CI without a real handoff.

## 4. Recovery path

| Symptom | Recovery |
| --- | --- |
| `ON_CALL_HANDOFF_OVERDUE` | Complete a real handoff, record outgoing/incoming acknowledgement, then update `last_handoff` and `next_handoff_due`. |
| `ON_CALL_OWNER_MISSING` | Restore the named role owner in `ops/on-call-checklist.json`; placeholders such as `TBD` never pass. |
| `ON_CALL_RUNBOOK_ANCHOR_MISSING` | Restore the referenced section in this runbook. |
| `ON_CALL_CANONICAL_NAV_MISSING` / `ON_CALL_LEGACY_NAV_MISSING` | Restore the published page and both `_meta` registrations. |
| Active P1 | Open `#incident-response`, page via `ALERT_WEBHOOK_URL`, follow [`incident-response.md`](../incident-response.md), and keep details out of public channels. |

## 5. Evidence and verification

Run locally:

```bash
node scripts/hardening/on-call-escalation-handoff.mjs --as-of 2026-11-23 --report on-call-report.json
```

The dedicated workflow runs the same check on PRs, pushes, a weekly schedule,
and manual dispatch. It uploads the JSON report and writes the owner and
recovery path to the workflow summary. The mainnet checklist links the
canonical page and this manifest as the verification artifact.
