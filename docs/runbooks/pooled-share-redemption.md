# Pooled-Share Redemption Guarantees Runbook (#1305)

**Scope:** Withdrawal queue operations, epoch processing, and liquidity pause controls for pooled LP shares.

**Owned by:** Protocol Lead, Liquidity Manager

## Overview

The withdrawal queue implements fair, pro-rata redemptions from pooled LP capital. This runbook covers:

1. Submitting, tracking, and cancelling withdrawal requests
2. Processing withdrawals at epoch boundaries
3. Detecting and responding to liquidity emergencies (queue overflow, funding pauses)
4. Monitoring queue age and partial fill rates

## Critical Invariants

| Invariant | Failure Impact | Detection |
|-----------|---|---|
| Withdrawal requests cannot be processed same epoch submitted | Queue manipulation / front-running | Request state machine enforces `PENDING` → `QUEUED` transition |
| Pro rata fairness: within epoch, all requests split available liquidity fairly | Early callers get unfair advantage | Epoch processor allocates `request.amount * (available / total_queued)` |
| `sum(allocations) <= available_liquidity` | Over-commitment / insufficient funds | Epoch processor verifies invariant before releasing funds |
| Queued withdrawals > available liquidity pause new funding | Illiquidity crisis | Circuit breaker triggers when `queue / available > 2.0x` |
| Single LP cannot queue > 25% of pool TVL | Concentration risk | Validation rejects requests that would violate cap |

## Workflow: Submitting a Withdrawal Request

### Prerequisites

- LP has available shares to withdraw (not yet locked in an invoice)
- LP specifies notice period (1-4 epochs)
- Minimum idle liquidity > 10% of pool TVL (else new requests rejected)

### Step 1: Submit Request

```bash
iln-dev withdraw submit \
  --amount 10 \
  --notice-epochs 1 \
  --lp-address "GADDRESS1234..."
```

Response:
```json
{
  "requestId": "wr-1001",
  "status": "PENDING",
  "amount": 10,
  "submittedEpoch": 42,
  "nextEligibleEpoch": 43,
  "notice": "Request becomes eligible for processing in epoch 43"
}
```

**State:** `PENDING` (not yet eligible)

### Step 2: Wait for Notice Period

After `noticeEpochs` have passed, the request automatically transitions to `QUEUED`.

```bash
iln-dev withdraw status --request-id "wr-1001"
```

Response:
```json
{
  "requestId": "wr-1001",
  "status": "QUEUED",
  "submittedEpoch": 42,
  "currentEpoch": 44,
  "eligible": true,
  "nextProcessingEpoch": 45,
  "notice": "Eligible for processing starting epoch 45"
}
```

**State:** `QUEUED` (eligible, waiting for epoch cutoff)

### Step 3: Automatic Processing at Epoch Boundary

At epoch cutoff, the protocol processor allocates available liquidity pro-rata:

```bash
# Automatic, but can be triggered manually:
iln-dev epoch process --epoch 45
```

Output:
```json
{
  "epoch": 45,
  "totalQueued": 100,
  "totalAllocated": 40,
  "allocations": [
    {"requestId": "wr-1001", "status": "COMPLETED", "allocated": 10},
    {"requestId": "wr-1002", "status": "PARTIAL", "allocated": 15, "remaining": 15},
    {"requestId": "wr-1003", "status": "QUEUED", "allocated": 0, "remaining": 25}
  ],
  "partialFillRate": 0.33
}
```

**States after epoch:**
- `COMPLETED`: Full amount paid
- `PARTIAL`: Partially filled; remainder stays `QUEUED` for next epoch
- `QUEUED`: No liquidity available; moves to next epoch with same priority

### Step 4: Track & Collect

For completed or partial requests:

```bash
iln-dev withdraw status --request-id "wr-1001"
```

Response:
```json
{
  "requestId": "wr-1001",
  "status": "COMPLETED",
  "allocatedEpochs": [45],
  "totalReceived": 10,
  "tokenAddress": "CUSDC...",
  "txHash": "0x123abc..."
}
```

## Workflow: Cancelling a Request

An LP can cancel a request only before it starts processing:

```bash
iln-dev withdraw cancel --request-id "wr-1001"
```

**Valid states for cancellation:**
- `PENDING` ✓
- `QUEUED` ✓
- `PROCESSING` ✗ (no cancel during active settlement)
- `COMPLETED` ✗ (already paid)
- `PARTIAL` ✓ (cancel the remaining amount)

## Liquidity Emergency: Queue Overflow

### Trigger

The protocol automatically pauses new invoice funding when queued withdrawals exceed available liquidity:

```
Queued Withdrawals > Available Liquidity × 2.0x
```

**Alert:**
```
iln_withdrawal_queue_pause_triggers > 0
```

### Diagnosis

```bash
iln-dev queue inspect
```

Output:
```json
{
  "availableLiquidity": 40,
  "totalQueued": 100,
  "coverageRatio": 0.4,
  "maxQueueCoverage": 80,
  "overflow": 20,
  "pauseActive": true,
  "pauseTriggers": ["QUEUE_OVERFLOW"],
  "notice": "New invoice funding paused; coverage ratio < 1.0"
}
```

### Recovery

New funding resumes automatically after **2 consecutive clean epochs** (no triggers present).

**Manual override** (if needed):
```bash
# Requires both Protocol Lead + Security Lead approval
gh issue create --title "Manual Queue Pause Clearance" \
  --assignee @protocol-lead @security-lead
```

Once approved:
```bash
iln-dev queue clear-pause --approvals "protocol-lead,security-lead"
```

## Liquidity Emergency: Concentration Risk

### Trigger

A single LP queues > 25% of pool TVL:

```
Single LP Queued > Pool TVL × 0.25
```

### Response

New withdrawal requests from that LP are **rejected** (pauses that LP only):

```json
{
  "approved": false,
  "issues": ["SINGLE_LP_CONCENTRATION"],
  "singleLpQueued": 30,
  "singleLpCap": 25,
  "notice": "LP has reached maximum queue concentration; wait for processing or cancel requests"
}
```

**LP Action:**
1. Wait for current requests to process
2. Or cancel some requests to free up capacity

## Alerting & Monitoring

### Metrics

| Metric | Threshold | Action |
|--------|-----------|--------|
| `iln_withdrawal_queue_pause_triggers` | > 0 | Alert oncall; check queue state |
| `iln_withdrawal_queue_requests_queued` | > 1000 | Escalate; possible attack or mass exodus |
| `iln_withdrawal_queue_partial_fills` | > 50% of epoch | Analyze; indicates undercapitalized liquidity |
| Oldest queued request age | > 28 days | Investigate; possible stalled epoch processing |

### Daily Report

```bash
pnpm run reports:withdrawal-queue
```

Output (published publicly):
```json
{
  "epoch": 45,
  "availableLiquidity": 40,
  "totalQueued": 15,
  "queuedRequests": 3,
  "oldestRequestAgeDays": 2,
  "coverageRatio": 2.67,
  "pauseActive": false,
  "partialFillRate": 0,
  "recommendedAction": "healthy"
}
```

## Incident Response

### Scenario: Epoch Processor Fails (Stuck in PROCESSING)

**Symptoms:**
```
Requests stuck in PROCESSING; no allocations for 2+ epochs
```

**Diagnosis:**
```bash
iln-dev epoch status --epoch 45
iln-dev epoch logs --epoch 45 | tail -50
```

**Resolution:**
1. Check if contract is paused: `iln-dev status`
2. Check RPC node health: `curl https://soroban-rpc.stellar.org/health`
3. If RPC issue: wait for recovery; processor will auto-retry
4. If contract paused: check `docs/incident-response.md` for unpause procedure
5. If processor crashes: manually trigger epoch: `iln-dev epoch process --epoch 45 --force`

### Scenario: Partial Fill Rate Too High (> 50%)

**Symptoms:**
```
Epoch 45: 10 requests processed, 6 partial fills (60% partial rate)
```

**Investigation:**
```bash
# Check what happened
iln-dev epoch inspect --epoch 45

# Check pool health
iln-dev pool inspect

# Check if invoice defaults occurred
iln-dev defaults recent --days 7
```

**Possible causes:**
1. **Invoice defaults reduced liquidity** → Check Claims & First-Loss workflow
2. **Withdrawal rush** → Check if many LPs requesting at same time
3. **Poor forecasting** → Plan replenishment for next epoch

**Action:**
1. Notify LPs of partial fills; manage expectations
2. Assess if new capital injection needed
3. Consider pausing new invoice funding temporarily

### Scenario: Single LP Queue Cap Triggered

**Symptoms:**
```
LP "GADDRESS1234..." queued $30K; pool TVL $100K
Concentration: 30% > 25% cap → NEW requests REJECTED
```

**Investigation:**
1. Is this LP exiting the protocol? Check exit interview
2. Or just a large allocation unlock? Check LP history

**Action:**
1. Notify LP: requests rejected until queued amount processes
2. Monitor for cascading exits (sign of systemic issue)
3. If multiple LPs exiting: escalate to Risk team

---

**Last Updated:** 2026-11-21
**Review Cadence:** After each epoch or on major liquidity event
**Owner Approval:** Protocol Lead, Liquidity Manager
