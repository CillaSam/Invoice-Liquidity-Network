# Launch-Critical Drills: Evidence Retention Policy

**Status:** Active  
**Owner:** Infrastructure lead  
**Version:** 1.0  
**Last updated:** 2026-11-21

## 1. Purpose

This document defines the production behavior, automated validation, and operational evidence for launch-critical drills evidence retention—a Wave-9 hardening control. The policy ensures that all evidence from launch-critical drills (disaster recovery, failover, incident response) is captured, retained, and available for auditing and post-incident review.

## 2. Launch-Critical Drills In Scope

| Drill | Purpose | Cadence |
|-------|---------|---------|
| **Indexer backup/restore** | Verify indexer can recover from full data loss | Monthly |
| **Multi-service failover** | Test cross-service failover during simulated outages | Quarterly |
| **KYB outage containment** | Rehearse handling of KYB provider unavailability | Quarterly |
| **Settlement anchor failure** | Simulate settlement-anchor partner downtime or insolvency | Semi-annually |
| **Emergency pause/unpause** | Test emergency pause mechanism and state recovery | Quarterly |
| **Governance proposal veto** | Verify veto authority can block malicious proposals | Bi-annually |

## 3. Evidence Retention Requirements

### 3.1 Drill Execution Evidence

Each drill run must capture and retain:

1. **Drill manifest**: YAML/JSON defining drill scope, participants, trigger conditions, and expected outcomes
2. **Start timestamp**: ISO 8601 timestamp when drill began
3. **End timestamp**: ISO 8601 timestamp when drill completed
4. **Participants**: List of team members executing the drill
5. **Trigger scenario**: Description of the scenario being simulated
6. **System snapshots**: 
   - Pre-drill state (service versions, data volumes, replica lag)
   - Mid-drill checkpoints (every 5 minutes during execution)
   - Post-drill state (service versions, data integrity checks, recovery time)
7. **Decision log**: Timestamped record of every decision point (e.g., "decision to invoke rollback" at 10:05:30Z)
8. **Communication log**: Messages sent to stakeholders during the drill
9. **Metrics captured**: CPU, memory, throughput, latency, error rate
10. **Logs collected**: Application logs, infrastructure logs, audit logs
11. **Pass/fail status**: Explicit confirmation that drill met acceptance criteria
12. **Deviations**: Any unplanned behaviors or issues encountered during the drill

### 3.2 Storage Location & Format

Evidence is stored in:
- **Primary**: `docs/drills/evidence/<drill-type>/<YYYY-MM-DD>-<run-id>/`
- **Archive**: S3 bucket `iln-audit-evidence/drills/` (tamper-sealed)
- **Format**: JSON for structured data, plain text for logs, YAML for manifests

Example structure for indexer backup/restore drill on 2026-11-21:
```
docs/drills/evidence/indexer-backup-restore/2026-11-21-run-a1b2c3d4/
├── manifest.yaml                    # Drill scope and expected outcomes
├── execution-log.json              # Timestamped events during drill
├── metrics-snapshot-pre.json       # Pre-drill system state
├── metrics-snapshot-mid.json       # Checkpoint data (collected every 5min)
├── metrics-snapshot-post.json      # Post-drill system state
├── decision-log.json               # Decision points and reasoning
├── communication-log.txt           # Messages to stakeholders
├── application-logs.tar.gz         # Compressed application logs
├── infrastructure-logs.tar.gz      # Compressed infrastructure logs
├── pass-fail-report.json          # Explicit acceptance criteria validation
└── deviations-and-learnings.md    # Notes on unexpected behaviors
```

### 3.3 Retention Duration

| Evidence Type | Retention Duration | Rationale |
|---|---|---|
| **Drill manifest & acceptance report** | Permanent | Needed to audit drill scope and validate controls |
| **Execution logs & decision logs** | 3 years | Supports incident post-mortems and regulatory audits |
| **Metrics snapshots** | 6 months | Tracks performance trends; older snapshots archived to cold storage |
| **Application/infrastructure logs** | 90 days | Searchable, then compressed and archived after 90 days |
| **Communication logs** | 1 year | Needed for incident review and stakeholder transparency |

## 4. Automated Validation

### 4.1 Drill Evidence Validation Tests

Test suite: `tests/drill-evidence-retention.test.ts`

Each drill run must validate:

1. **Completeness**: All required evidence files are present
2. **Timestamps**: All timestamps are valid, non-zero, and in chronological order
3. **Data integrity**: Evidence files have not been modified after drill completion
4. **Artifact references**: All referenced logs/metrics are present
5. **Participant list**: All listed participants are valid team members
6. **Decision log**: Every decision includes timestamp, actor, reasoning, and outcome
7. **Metrics validity**: Metric values are within reasonable ranges (no NaN, Infinity, or negative timeouts)
8. **Log file sizes**: Evidence files are not suspiciously small (minimum 1KB for logs)

### 4.2 Storage Location Validation

Test suite: `tests/drill-evidence-storage.test.ts`

Before closing a drill run:
- Verify all evidence files are uploaded to primary location (`docs/drills/evidence/`)
- Verify backup copy is uploaded to S3 archive
- Confirm S3 object is sealed with Object Lock (tamper-proof)
- Generate and store SHA-256 hash of all evidence for integrity verification

## 5. Operational Evidence

### 5.1 Metrics

Published to monitoring dashboard (available to operators at all times):

- **Drill execution count**: Number of drills completed in the past 90 days (by drill type)
- **Drill pass rate**: Percentage of drills that met all acceptance criteria
- **Evidence completeness**: Percentage of drill runs with all required evidence files
- **Evidence retention**: Size of evidence repository and estimated archive growth
- **Decision log quality**: Percentage of decision log entries with reasoning documented

### 5.2 Logs

Structured logs (JSON) published to application logs:

Each drill run triggers entries:

```json
{
  "timestamp": "2026-11-21T10:00:00Z",
  "level": "info",
  "control": "launch-critical-drills-evidence-retention",
  "event": "drill_started",
  "drillType": "indexer-backup-restore",
  "runId": "run-a1b2c3d4",
  "participants": ["alice@example.com", "bob@example.com"],
  "scenario": "Simulate full indexer data loss and recovery"
}
```

Evidence validation completion:

```json
{
  "timestamp": "2026-11-21T11:30:00Z",
  "level": "info",
  "control": "launch-critical-drills-evidence-retention",
  "event": "evidence_validated",
  "drillType": "indexer-backup-restore",
  "runId": "run-a1b2c3d4",
  "filesArchived": 12,
  "totalSize": "2.5 GB",
  "checksumSha256": "abc123def456g7h8i9j0k1l2m3n4o5p",
  "archiveLocation": "s3://iln-audit-evidence/drills/indexer-backup-restore/2026-11-21-run-a1b2c3d4"
}
```

### 5.3 CI Artifact

The drill execution workflow produces:
- **Evidence manifest**: `docs/drills/evidence/<drill-type>/<YYYY-MM-DD>-<run-id>/manifest.yaml`
- **Validation report**: `docs/drills/evidence/<drill-type>/<YYYY-MM-DD>-<run-id>/validation-report.json`

Attestation on drill completion:
```
✅ All 12 required evidence files captured
✅ Timestamps validated (all in order, no gaps)
✅ Metrics within expected ranges
✅ Evidence uploaded to S3 archive
✅ Tamper-proof seal applied (Object Lock)
✅ Retention policy: 3 years for manifests, 90 days for logs
```

## 6. Acceptance Criteria

Drill run is not complete until:

- [ ] All required evidence files exist in `docs/drills/evidence/`
- [ ] Evidence completeness validation passes (all 8 checks)
- [ ] Storage location validation passes (primary + archive)
- [ ] Evidence integrity check passes (no file tampering detected)
- [ ] Metrics dashboard updated with drill results
- [ ] At least one log entry confirms drill started and completed
- [ ] Drill manifest explicitly references this acceptance criteria checklist
- [ ] Decision log contains at least one documented decision

## 7. Example: Indexer Backup/Restore Drill Manifest

File: `docs/drills/evidence/indexer-backup-restore/2026-11-21-run-a1b2c3d4/manifest.yaml`

```yaml
version: 1
drillType: indexer-backup-restore
drillDate: 2026-11-21
runId: run-a1b2c3d4
owner: Infrastructure lead
description: "Verify indexer backup/restore procedure under production load"

scope:
  - service: indexer
    action: "Full backup capture, then restore from backup"
    dataVolume: "150 GB (3 days of transaction history)"
    
trigger:
  scenario: "Simulated indexer disk failure at 50% through daily backup"
  expectedRecoveryTime: "2 hours"
  
participants:
  - alice@example.com (incident commander)
  - bob@example.com (indexer specialist)
  - charlie@example.com (database administrator)

executionSteps:
  - name: "Pre-drill snapshot"
    timestamp: "2026-11-21T10:00:00Z"
    expected: "Baseline metrics captured"
  - name: "Trigger disk failure simulation"
    timestamp: "2026-11-21T10:05:00Z"
    expected: "Indexer begins backup process"
  - name: "Pause indexing"
    timestamp: "2026-11-21T10:10:00Z"
    expected: "New transactions queued, lag increases"
  - name: "Initiate restore"
    timestamp: "2026-11-21T10:15:00Z"
    expected: "Restore begins from last checkpoint"
  - name: "Resume indexing"
    timestamp: "2026-11-21T11:30:00Z"
    expected: "Recovery complete, lag clears within 5 min"

acceptanceCriteria:
  - "Recovery time is under 2 hours"
  - "No transaction history is lost (verify via replay from blockchain)"
  - "Indexer health checks pass post-recovery"
  - "Replication lag clears within 5 minutes"
  - "All decision points are documented with rationale"
```

## 8. Owner Sign-off

| Role | Sign-off | Date |
|------|----------|------|
| Infrastructure lead | Responsible for drill execution and evidence collection | 2026-11-21 |
| Operations lead | Owns evidence retention and archival procedures | 2026-11-21 |
| Security lead | Validates evidence integrity and retention compliance | 2026-11-21 |
