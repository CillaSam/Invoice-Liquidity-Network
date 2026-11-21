# Production KYB Outage Containment Drill

**Status:** Active  
**Owner:** Security lead  
**Version:** 1.0  
**Last updated:** 2026-11-21

## 1. Purpose

This document defines the production behavior, automated validation, and operational evidence for rehearsing production KYB (Know-Your-Business) outage containment—a Wave-9 hardening control. The drill verifies that KYB provider outages are detected, contained, and communicated to operators without allowing bypass of the KYB gate or silent failure.

## 2. KYB Outage Scenario Classification

| Scenario | Root Cause | Operator Action | Expected Outcome |
|----------|-----------|-----------------|-----------------|
| **Registry timeout** | KYB API endpoint responds slowly (>10s) | No action; failover activates automatically | Requests routed to fallback provider; timeouts logged |
| **Registry unavailable** | KYB API returns 503/5xx | No action; failover activates automatically | Requests routed to fallback provider; operator notified |
| **Registry malfunction** | KYB API returns malformed response | Operator checks `/health` endpoint | Health check shows `kyb-primary: unavailable`; fallback activated |
| **Partial outage** | KYB API rejects some (but not all) requests | Operator monitors error rate threshold | Health check reflects `degraded`; requests continue via failover |
| **Both providers down** | Primary and fallback both unavailable | Operator invokes manual mitigation playbook | Requests fail with explicit `rejected-kyb-unavailable`; no silentbypass |
| **Cascading failure** | Failover provider is compromised/rejects all | Operator escalates to incident commander | Manual review gate activated; no auto-approval occurs |

## 3. Operational Control: Health Check Endpoint

### 3.1 Health Check API

Endpoint: `GET /health` and `GET /v1/health`

Response when KYB is operating normally:
```json
{
  "status": "healthy",
  "kyb": {
    "required": true,
    "configured": true,
    "failover": true
  },
  "sources": {
    "kyb-primary": "healthy",
    "kyb-fallback": "healthy"
  }
}
```

Response when primary is unavailable:
```json
{
  "status": "degraded",
  "kyb": {
    "required": true,
    "configured": true,
    "failover": true
  },
  "sources": {
    "kyb-primary": "unavailable",
    "kyb-fallback": "healthy"
  }
}
```

Response when both providers are unavailable:
```json
{
  "status": "unhealthy",
  "kyb": {
    "required": true,
    "configured": true,
    "failover": true
  },
  "sources": {
    "kyb-primary": "unavailable",
    "kyb-fallback": "unavailable"
  }
}
```

### 3.2 KYB Failure Response Codes

When KYB is unavailable and no source answers:
- **HTTP 503 Service Unavailable** (if called via public API endpoint)
- **Response code**: `PAYER_KYB_UNAVAILABLE` (oracle response)
- **Verdict**: `rejected-kyb-unavailable` (outcome)
- **User experience**: "Verification service temporarily unavailable; please retry in a few moments"

No fallback to unverified approval occurs; the gate remains closed.

## 4. Drill Procedure: KYB Outage Containment Rehearsal

### 4.1 Drill Setup

**Duration**: 90 minutes  
**Environment**: Production-like staging environment (not production)  
**Participants**: Security lead, KYB provider liaison, incident commander  

**Pre-drill checklist**:
- [ ] Staging environment has real KYB provider credentials configured
- [ ] Failover provider is healthy and operational
- [ ] Monitoring dashboards are live and visible to all participants
- [ ] Communication channels (Slack, incident bridge) are open
- [ ] Decision log and test results will be captured

### 4.2 Drill Timeline

**Phase 1: Baseline (0-10 min)**
1. Confirm all KYB sources are healthy via health check
2. Send 10 test KYB verification requests
3. Verify all pass/fail verdicts are correct
4. Record baseline metrics (latency, success rate)

**Phase 2: Primary Provider Outage (10-30 min)**
1. Simulate primary KYB provider failure (HTTP 503 error on all requests)
2. Within 30 seconds, operator should observe:
   - Health check shows `kyb-primary: unavailable`
   - Verification requests succeed via fallback
   - Metrics show routing shift to fallback
3. Send 10 test KYB verification requests via fallback
4. Verify verdicts are still accurate
5. Document decision: "Primary unavailable, failover active, no manual action needed"

**Phase 3: Failover Provider Degradation (30-50 min)**
1. Degrade fallback provider (responses are 2x slower but succeed)
2. Health check should show `kyb-fallback: degraded` (not unhealthy yet)
3. Send 20 test KYB verification requests
4. Verify responses eventually arrive (latency high but succeeding)
5. Document decision: "Fallback degraded, still functional, monitoring latency"

**Phase 4: Both Providers Unavailable (50-70 min)**
1. Fail both primary and fallback providers (all requests return 503)
2. Within 30 seconds, operator should observe:
   - Health check shows both sources as `unavailable`
   - Overall health becomes `unhealthy`
   - Verification requests fail with `rejected-kyb-unavailable`
3. Send 10 test KYB verification requests
4. Verify responses are `rejected-kyb-unavailable` (not approved/bypassed)
5. Document decision: "Both providers down, KYB gate is closed, no bypass occurs"

**Phase 5: Recovery (70-90 min)**
1. Restore primary provider to healthy state
2. Within 30 seconds, health check should update
3. Requests should auto-shift back to primary (not stuck on failover)
4. Send 10 test KYB verification requests
5. Verify recovery is complete and verdicts are accurate
6. Document decision: "Primary recovered, automatic routing restored"

### 4.3 Drill Success Criteria

✅ **Phase 1 Baseline**: All test requests return expected verdicts  
✅ **Phase 2 Failover**: Automatic routing to fallback within 30 seconds of primary failure  
✅ **Phase 3 Degradation**: Latency increases but requests still succeed  
✅ **Phase 4 Both Down**: Requests fail with explicit `rejected-kyb-unavailable` (no bypass)  
✅ **Phase 5 Recovery**: Automatic routing restored to primary within 30 seconds  
✅ **Communication**: All decisions logged with timestamp, actor, rationale, and outcome  
✅ **No manual override**: Operator never manually bypassed or overrode the KYB gate  
✅ **Health check accuracy**: Health endpoint accurately reflected state at every phase  

If any criterion fails, drill is marked FAILED and root-cause investigation begins immediately.

## 5. Automated Validation

### 5.1 KYB Health Check Tests

Test suite: `tests/kyb-outage-containment.test.ts`

Automated tests run on every deploy to verify KYB control:

1. **Health endpoint responds correctly**: GET /health returns valid JSON with kyb object
2. **Provider routing works**: Primary receives requests, failover is never called when primary is healthy
3. **Automatic failover triggers**: When primary fails, requests shift to fallback automatically
4. **No bypass on outage**: When both fail, verdict is `rejected-kyb-unavailable` (not approved)
5. **Recovery automatic**: When primary recovers, requests shift back automatically
6. **Latency bounded**: Even under degradation, all responses arrive within 15 seconds
7. **Fallback config exists**: Both primary and fallback providers are configured and accessible

### 5.2 Drill Evidence Validation

Test suite: `tests/drill-evidence-kyb-outage.test.ts`

After each drill run, validate:
- Drill manifest exists and is timestamped
- All 5 phases completed with recorded start/end times
- Decision log contains at least one entry per phase
- No log entries show KYB gate being bypassed
- Health check responses match expected values for each phase
- Recovery phase confirms automatic failover behavior

## 6. Operational Evidence

### 6.1 Metrics

Published to monitoring dashboard (available to operators at all times):

- **KYB health status**: Current state of primary and fallback providers
- **Request routing**: Percentage of requests routed to primary vs. fallback
- **Failover activation count**: Number of times automatic failover activated in past 7 days
- **Recovery time**: Average time to recover after primary outage
- **Drill pass rate**: Percentage of KYB outage containment drills that passed all criteria

### 6.2 Logs

Structured logs (JSON) published to application logs:

Each drill run triggers entries:

```json
{
  "timestamp": "2026-11-21T14:00:00Z",
  "level": "info",
  "control": "kyb-outage-containment",
  "event": "drill_started",
  "drilId": "kyb-drill-2026-11-21-a1b2c3d4",
  "participants": ["security-lead@example.com"],
  "scenario": "Simulate primary KYB provider failure"
}
```

Phase transitions during drill:

```json
{
  "timestamp": "2026-11-21T14:10:00Z",
  "level": "info",
  "control": "kyb-outage-containment",
  "event": "phase_complete",
  "phase": "phase-2-primary-outage",
  "duration": "20 minutes",
  "decision": "Primary unavailable, failover active, no manual action needed",
  "verdictAccuracy": "10/10 test requests correct",
  "failoverTriggeredAt": "2026-11-21T14:10:00Z"
}
```

### 6.3 CI Artifact

The drill execution workflow produces:
- **Drill manifest**: `docs/drills/evidence/kyb-outage/2026-11-21-drill-a1b2c3d4/manifest.yaml`
- **Decision log**: `docs/drills/evidence/kyb-outage/2026-11-21-drill-a1b2c3d4/decision-log.json`
- **Health check log**: `docs/drills/evidence/kyb-outage/2026-11-21-drill-a1b2c3d4/health-check-responses.json`

Attestation on drill completion:
```
✅ Phase 1 (Baseline): All test requests passed
✅ Phase 2 (Primary Outage): Failover triggered within 30 seconds
✅ Phase 3 (Fallback Degradation): Requests succeeded with higher latency
✅ Phase 4 (Both Down): Requests rejected with rejected-kyb-unavailable
✅ Phase 5 (Recovery): Automatic routing restored
✅ No KYB gate bypasses detected
✅ All decisions documented
```

## 7. Acceptance Criteria

Drill is not complete until:

- [ ] All 5 phases are executed and recorded
- [ ] Decision log has entries for each phase with actor, timestamp, rationale, and outcome
- [ ] Health check responses match expected values at each phase
- [ ] No test requests bypass the KYB gate when providers are unavailable
- [ ] Automatic failover activates within 30 seconds of primary failure
- [ ] Automatic recovery occurs within 30 seconds of primary restoration
- [ ] Metrics dashboard updated with drill results
- [ ] At least one log entry confirms drill started and each phase completed
- [ ] Drill manifest explicitly references this acceptance criteria checklist

## 8. Cadence & Schedule

- **Frequency**: Quarterly (every 90 days)
- **Scheduled dates**: 2026-11-21, 2027-02-21, 2027-05-21, 2027-08-21
- **Participants**: Security lead + on-call incident commander
- **Communication**: Slack notification 24 hours before drill starts; "DRILL IN PROGRESS" status during execution

## 9. Owner Sign-off

| Role | Sign-off | Date |
|------|----------|------|
| Security lead | Responsible for KYB outage simulation and drill execution | 2026-11-21 |
| Incident commander | Owns decision-making during drill | 2026-11-21 |
| Infrastructure lead | Owns health check endpoint and failover mechanism | 2026-11-21 |
