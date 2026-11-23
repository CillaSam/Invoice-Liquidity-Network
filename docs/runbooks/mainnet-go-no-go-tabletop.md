# Mainnet Go/No-Go Tabletop Runbook

Issue #1330 requires an independent, fail-closed go/no-go decision before mainnet launch. The machine-readable record is [`docs/evidence/mainnet-go-no-go-tabletop.json`](../evidence/mainnet-go-no-go-tabletop.json); the validator is `scripts/hardening/mainnet-go-no-go-tabletop.mjs`.

**Control owner:** @release-lead
**Recovery owner:** @release-lead
**Independent reviewers:** protocol security, liquidity controls, infrastructure failover, smart contracts, SDK, and release (six separate areas; none may own a mainnet checklist item).

## 1. Before the tabletop

1. Freeze the checklist revision under test and record it as `checklistRevision`.
2. Confirm every linked evidence file exists in the repository. Missing evidence is a `NO_GO`.
3. Confirm all seven required scenarios are present: anchor-outage insolvency, LP withdrawal stress, contract pause/unpause, indexer replay recovery, notification circuit breaker, config poisoning, and governance veto.
4. Confirm each scenario records an expected control, an observed result, a repository-local evidence path, a named owner, a recovery path, and a signed decision-log entry.

## 2. Decision rule

The validator returns `GO` only when **all** of the following hold:

- every required scenario is `PASS` / `GO` with evidence, an owner, and a recovery path;
- `blockers` is empty;
- the record is dated within 30 days and not in the future;
- all six reviewer areas have a named, `independent` reviewer with `Signed` sign-off dated within 30 days and not in the future;
- no reviewer is a checklist owner.

Any failed condition flips the result to `NO_GO` with a specific code. There is no override flag.

## 3. Running the gate

```bash
node scripts/hardening/mainnet-go-no-go-tabletop.mjs \
  --report mainnet-go-no-go-tabletop.json
```

Use `--as-of 2026-11-23T00:00:00.000Z` for deterministic replay of the seeded record. The `mainnet-launch-readiness` workflow runs the gate on pull requests, on the weekly schedule, and on manual dispatch, uploads the JSON report, and writes the decision and recovery path to the workflow summary.

## 4. Recovery path

| Code | Recovery |
| --- | --- |
| `TABLETOP_RECORD_MISSING` / `TABLETOP_RECORD_MALFORMED` | Restore or repair the evidence record from version control. |
| `TABLETOP_SCENARIO_FAILED` / `TABLETOP_SCENARIO_NO_GO` | Re-run the scenario, fix the control, attach fresh evidence, and re-record the decision. |
| `TABLETOP_EVIDENCE_MISSING` | Add the repository-local evidence file and update `evidencePath`. |
| `TABLETOP_UNRESOLVED_BLOCKERS` | Resolve every blocker, then clear the `blockers` array with owner sign-off. |
| `TABLETOP_REVIEWER_NOT_INDEPENDENT` | Replace the reviewer with a named person who does not own a checklist item. |
| `TABLETOP_REVIEWER_STALE` / `TABLETOP_STALE_OR_FUTURE` | Conduct a fresh tabletop and re-sign; do not merely advance dates. |

## 5. Baseline and evidence

| | Before | After |
| --- | --- | --- |
| Decision record | No signed go/no-go tabletop or required scenario set | Seven mandatory scenarios with owners, evidence, and recovery paths |
| Independence | No reviewer enforcement | Six independent reviewer areas, checked against checklist owners |
| Fail-closed behaviour | Prose checklist only | Deterministic GO/NO_GO validator in CI with JSON evidence and owner/recovery summary |

The seeded record is a deterministic rehearsal fixture. Before a real mainnet GO the release lead must replace role-based reviewer handles with named independent reviewers and re-attest every scenario against fresh evidence.
