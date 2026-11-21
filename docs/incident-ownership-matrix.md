# Cross-Repository Incident Ownership Matrix

**Status:** Active  
**Version:** 1.0  
**Last updated:** 2026-11-21

## 1. Purpose

This document defines incident ownership responsibilities across the three core Invoice Liquidity Network repositories and specifies how incidents are routed, escalated, and resolved. It ensures that every incident has an explicit owner, clear escalation paths, and defined recovery procedures.

## 2. Repository Scope

| Repository | Owner | On-call Lead | Focus |
|------------|-------|--------------|-------|
| **ILN-Contracts** (`github.com/Invoice-Liquidity-Network/ILN-Smart-Contracts`) | Contracts lead | Protocol engineer on-call rotation | Smart contracts, Soroban code, storage, governance |
| **ILN-Frontend** (`github.com/Invoice-Liquidity-Network/ILN-Frontend`) | Frontend lead | Frontend engineer on-call rotation | Web UI, wallet integration, client-side state |
| **ILN-Infrastructure** (`github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network`) (this repo) | Infrastructure lead | DevOps engineer on-call rotation | Indexer, oracle-service, backend services, CI/CD, monitoring |

## 3. Incident Categories & Ownership

### 3.1 Smart Contract Incidents

**Primary owner**: Contracts lead  
**Fallback**: Protocol lead  
**On-call**: Protocol engineer on 7-day rotation

| Incident | Owner | Trigger | Recovery | Runbook |
|----------|-------|---------|----------|---------|
| **Contract pause** | Contracts lead | Critical bug in contract code, funds-at-risk | Invoke rollback procedure or redeploy | `backend/docs/mainnet-rollback-runbook.md` |
| **Storage corruption** | Contracts lead | Invalid state transition or migration failure | Redeploy to new contract ID, refund/migrate state | `backend/docs/disaster-recovery-multisig-signers.md` |
| **Governance takeover attempt** | Contracts lead + Security lead | Malicious proposal detected or governance bypass found | Veto proposal via multi-sig (§3.2) | `backend/docs/governance.md#veto-procedure` |
| **Oracle price manipulation** | Protocol lead | Oracle feed produces clearly incorrect prices | Pause oracle, switch provider, investigate | `backend/docs/oracle-attack-economics.md` |
| **Authorization bypass** | Security lead | Admin-gated or role-gated function called by unauthorized address | Rotate affected keys, audit logs, patch code | `backend/docs/access-control.md` |
| **Upgrade WASM mismatch** | Contracts lead | Deployed WASM hash doesn't match expected | Halt deployment, verify source, redeploy correct WASM | `backend/docs/upgrade-guide.md` |

### 3.2 Frontend / Client Incidents

**Primary owner**: Frontend lead  
**Fallback**: SDK lead  
**On-call**: Frontend engineer on 7-day rotation

| Incident | Owner | Trigger | Recovery | Runbook |
|----------|-------|---------|----------|---------|
| **UI crash / blank page** | Frontend lead | Frontend code error, missing API response | Hotfix + redeploy frontend, or rollback to previous version | `frontend/docs/release-rollback-runbook.md` |
| **Wallet connection failure** | Frontend lead | Wallet provider API change, signing issue | Update wallet integration, verify supported chains | `frontend/docs/wallet-integration.md` |
| **PII exposure** | Security lead + Frontend lead | Accidentally logged/exposed private keys or customer data | Rotate affected keys, notify users, audit logs | `frontend/docs/security.md` |
| **SDK breaking change** | SDK lead | SDK method removed or signature changed without deprecation | Release patch version with compatibility layer | `sdk/docs/rollback-runbook.md` |
| **TLS / HTTPS failure** | Infrastructure lead | Frontend CDN cert expired or SSL/TLS misconfigured | Renew certificate, verify CDN configuration | `frontend/docs/tls-certificate-management.md` |
| **Rate limiting too aggressive** | Frontend lead + API lead | Frontend getting 429s from backend API | Adjust rate limit thresholds, coordinate with backend | `backend/docs/rate-limiting-policy.md` |

### 3.3 Infrastructure / Services Incidents

**Primary owner**: Infrastructure lead  
**Fallback**: Release lead  
**On-call**: DevOps engineer on 7-day rotation

| Incident | Owner | Trigger | Recovery | Runbook |
|----------|-------|---------|----------|---------|
| **Indexer lag / stalling** | Infrastructure lead | Blockchain RPC unreachable, DB bottleneck, or indexer crash | Restart indexer, switch RPC node, scale database | `backend/docs/indexer-incident-runbook.md` |
| **Oracle-service unavailable** | Infrastructure lead | Service crashed, all KYB requests failing | Redeploy oracle-service, switch to fallback provider | `backend/docs/oracle-source-failover-runbook.md` |
| **Backend service 5xx errors** | Infrastructure lead | Backend code error, database connection pool exhausted | Restart service, check DB health, review logs | `backend/docs/incident-response-runbook.md` |
| **Notifications delivery failure** | Infrastructure lead | Webhook delivery failing, notification service down | Check notification service health, resend queued messages | `backend/docs/notifications-operations.md` |
| **Database replication lag** | Infrastructure lead | Replica lag >30 seconds, primary/replica split | Repair replication, failover if necessary | `backend/docs/database-replication-runbook.md` |
| **KYB provider outage** | Infrastructure lead + Security lead | KYB registry unavailable, failover activated | Monitor failover, engage provider liaison | `docs/runbooks/payer-kyb-incidents.md` |
| **Settlement anchor failure** | Infrastructure lead + Protocol lead | Settlement partner API down or unreachable | Switch to secondary anchor, queue settlement requests | `docs/trust-liquidity-model.md#settlement-anchor-failure` |
| **CI/CD pipeline failure** | Release lead | GitHub Actions workflow stuck or failing | Restart workflow, check auth tokens, review config | `backend/docs/ci-cd.md` |

## 4. Incident Routing Logic

```
Incident reported
    ↓
Is it a smart contract issue?
    ├─ YES → Owner: Contracts lead / Protocol lead
    ├─ Call: Backend on-call engineer
    └─ Follow: backend/docs/mainnet-rollback-runbook.md
    ↓
Is it a frontend / client issue?
    ├─ YES → Owner: Frontend lead / SDK lead
    ├─ Call: Frontend on-call engineer
    └─ Follow: frontend/docs/release-rollback-runbook.md
    ↓
Is it an infrastructure / service issue?
    ├─ YES → Owner: Infrastructure lead / Release lead
    ├─ Call: DevOps on-call engineer
    └─ Follow: backend/docs/incident-response-runbook.md
    ↓
Escalate to incident commander
```

## 5. On-Call Rotation

### 5.1 Rotation Schedule

| Week | Contracts Lead | Frontend Lead | Infrastructure Lead |
|------|---|---|---|
| Week 1 (Nov 21-27) | @alice | @bob | @charlie |
| Week 2 (Nov 28-Dec 4) | @bob | @charlie | @alice |
| Week 3 (Dec 5-11) | @charlie | @alice | @bob |
| *Repeats...* | | | |

Each rotation is 7 consecutive days.  
On-call contact info (Slack handle + phone number) is published in `#iln-on-call` Slack channel.

### 5.2 Handoff Procedure

At the end of each 7-day rotation:
1. Outgoing on-call sends comprehensive handoff notes to incoming on-call (incident log, known issues, action items)
2. Incoming on-call reviews all open incidents and pending actions
3. Both parties confirm receipt and readiness
4. Handoff is logged in incident tracking system

## 6. Escalation Paths

### 6.1 By Severity

| Severity | Response Time | Escalation | Decision Authority |
|----------|---|---|---|
| **P1 (Critical)** | <15 minutes | To incident commander + all team leads | Incident commander |
| **P2 (High)** | <1 hour | To relevant on-call lead | Team lead + on-call |
| **P3 (Medium)** | <4 hours | To team lead | Team lead |
| **P4 (Low)** | <24 hours | Optional | On-call engineer |

### 6.2 Cross-Repository Escalation

If an incident affects **multiple repositories**:

1. The **primary owner** (most impacted repo) becomes incident commander
2. **Secondary owners** (other repos) join incident bridge
3. Incident commander coordinates decision-making across all repos
4. Each repo owner owns their own recovery/rollback procedure

**Example**: Indexer lag + KYB provider outage (infrastructure + potentially affects frontend)
- Primary owner: Infrastructure lead
- Secondary owner: Frontend lead (if users unable to onboard due to KYB gate)
- Coordinator: Incident commander (most likely Infrastructure lead unless escalated)

## 7. Recovery Procedures by Owner

### 7.1 Contracts Lead Recovery Procedures

**When called**: Contract bug, storage corruption, governance attack  
**Authority**: Can invoke `pause()`, `veto_proposal()`, or `upgrade()` after IC approval  
**Reference**: `backend/docs/mainnet-rollback-runbook.md` §5-6  

Checklist:
- [ ] Confirm bug scope (which contracts affected)
- [ ] Decide: pause vs. veto vs. rollback vs. full redeploy
- [ ] Coordinate with security lead on communication
- [ ] Execute procedure per runbook
- [ ] Verify recovery (re-run acceptance tests)
- [ ] Document decision and timeline in incident log

### 7.2 Frontend Lead Recovery Procedures

**When called**: Frontend crash, wallet integration failure, SDK break  
**Authority**: Can hotfix + redeploy or rollback to previous version  
**Reference**: `frontend/docs/release-rollback-runbook.md`  

Checklist:
- [ ] Assess impact (how many users affected)
- [ ] Decide: hotfix + deploy or rollback
- [ ] Notify infrastructure lead if backend changes needed
- [ ] Execute procedure per runbook
- [ ] Verify recovery (manual test on affected browser/wallet)
- [ ] Document decision and timeline in incident log

### 7.3 Infrastructure Lead Recovery Procedures

**When called**: Service down, indexer lag, database issues  
**Authority**: Can restart services, switch replicas, invoke failover  
**Reference**: `backend/docs/incident-response-runbook.md`  

Checklist:
- [ ] Assess impact (which services/users affected)
- [ ] Decide: restart, scale, failover, or manual intervention
- [ ] Notify contracts lead if oracle/KYB affects contract state
- [ ] Execute procedure per runbook
- [ ] Verify recovery (health checks pass, lag clears, API responds)
- [ ] Document decision and timeline in incident log

## 8. Cross-Repository Coordination

### 8.1 When Incidents Span Multiple Repos

1. **Detection**: First responder (from any repo) notifies incident commander
2. **Initial response**: Owners from each affected repo join incident bridge
3. **Information sharing**: Each owner provides status update every 15 minutes
4. **Coordination**: Incident commander ensures decisions don't conflict (e.g., contract pause + frontend rollback should be coordinated)
5. **Resolution**: Incident is not closed until all repos are recovered
6. **Post-mortem**: Include representatives from all affected repos in root-cause analysis

### 8.2 Communication During Cross-Repo Incident

| Phase | Owner | Audience | Update |
|-------|-------|----------|--------|
| **Trigger** | Primary owner | On-call leads | "Incident detected, severity P1, assembling team" |
| **Initial response** | Primary owner | Public (Discord/Twitter) | "We are investigating an issue, more info in 30 min" |
| **Mitigation in progress** | Each owner | Internal bridge | Status by repo (every 15 min) |
| **Mitigation complete** | Primary owner | Public | "Issue resolved, incident review scheduled" |
| **Post-mortem** | Incident commander | Team | Timeline, root cause, action items, owner assignments |

## 9. Incident Tracking & Logging

### 9.1 Incident Record

Each incident gets a record in the incident log with:
- **Incident ID**: UUID or sequential number
- **Title**: Brief description
- **Severity**: P1 / P2 / P3 / P4
- **Primary owner**: Owner's name and repo
- **Secondary owners**: Other repos affected
- **Detection time**: When incident was first noticed
- **Mitigation start**: When recovery procedure began
- **Resolution time**: When incident was fully resolved
- **Root cause**: Brief summary
- **Runbook used**: Which procedure was followed
- **Post-mortem owner**: Who will conduct root-cause analysis

### 9.2 Incident Log Location

Incidents are logged in GitHub issues with label `type:incident`:
- **ILN-Contracts**: Issues in ILN-Smart-Contracts repo
- **ILN-Frontend**: Issues in ILN-Frontend repo
- **ILN-Infrastructure**: Issues in Invoice-Liquidity-Network repo (this repo)

Each incident issue includes:
- Root cause (once determined)
- Timeline of events and decisions
- Recovery procedure used
- Lessons learned
- Action items for prevention

## 10. Owner Sign-off

| Role | Sign-off | Date |
|------|----------|------|
| Contracts lead | Responsible for smart contract incident response | 2026-11-21 |
| Frontend lead | Responsible for frontend/client incident response | 2026-11-21 |
| Infrastructure lead | Responsible for infrastructure/service incident response | 2026-11-21 |
| Release lead | Coordinates cross-repository incidents | 2026-11-21 |
| Incident Commander | Owns incident response coordination and severity assessment | 2026-11-21 |
