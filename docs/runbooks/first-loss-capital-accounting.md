# First-Loss Capital Accounting Runbook (#1306)

**Scope:** Treasury separation, claim processing, and accounting validation for the first-loss capital buffer.

**Owned by:** Compliance Lead, Treasury Lead

## Overview

The first-loss capital buffer is a separate treasury account, not LP capital, that absorbs the first 5% of protocol defaults before impacting LP principal. This runbook covers:

1. Validating separated accounting (treasury ≠ LP capital)
2. Processing and approving default claims
3. Detecting accounting drifts or imbalances
4. Requesting and executing treasury replenishment

## Critical Invariants

| Invariant | Failure Impact | Detection |
|-----------|---|---|
| `Treasury + LP Capital = Pool TVL` | Funds vanish or appear from nowhere | Nightly accounting validation; alert if imbalance > 0.1% |
| Treasury never covers committed (locked) capital | First-loss consumed by unlocked defaults | Claim evaluation checks only idle LP capital available |
| Single claim ≤ 50% of remaining treasury | Treasury depleted by one large default | Claim approval denies amounts > `maxClaimRatio` |
| Treasury >= 5% of pool TVL (target) | Undercapitalized buffer; insufficient coverage | Daily metric published; replenishment triggered at < 3% |

## Workflow: Processing a Default Claim

### Prerequisites

- Invoice marked as `Defaulted` on-chain (contract state machine enforced)
- Claim request includes invoice ID, payer, default amount
- Not previously claimed for this invoice (idempotency enforced)

### Step 1: Validate Claim Eligibility

```bash
# CLI tool or backend service call
iln-dev claims validate \
  --invoice-id "inv-12345" \
  --default-amount 100 \
  --treasury-balance 5 \
  --pool-tvl 100
```

Expected output:
```json
{
  "approved": true,
  "decision": "CLAIM_APPROVED",
  "invoiceId": "inv-12345",
  "claimAmount": 100,
  "treasuryBalance": 5,
  "maxClaimAmount": 2.5,
  "issues": []
}
```

**Failure Case:** If `claimAmount > maxClaimAmount`:
- Decision: `CLAIM_DENIED`
- Reason: `CLAIM_EXCEEDS_SINGLE_CLAIM_LIMIT`
- Action: Coordinator reviews with Treasury Lead; claim for the max instead

### Step 2: Request Multi-Sig Approval

```bash
# Multi-sig wallet or governance contract call
gh issue create \
  --title "First-Loss Claim: inv-12345 for $100" \
  --body "Claim approval request. See claim validation above." \
  --assignee @compliance-lead @treasury-lead
```

Both `compliance-lead` and `treasury-lead` must approve. No single operator bypasses this gate.

### Step 3: Execute Claim

Once approved:

```bash
iln-dev claims execute \
  --invoice-id "inv-12345" \
  --claim-amount 100 \
  --treasury-signer <multi-sig-wallet>
```

**Idempotency:** Replaying this command with the same invoice ID returns the same result (token transfer does not repeat).

### Step 4: Record Evidence

Log the claim in the compliance ledger:

```json
{
  "claimId": "clm-99999",
  "invoiceId": "inv-12345",
  "approvedAt": "2026-11-21T10:30:00Z",
  "claimer": ["compliance-lead", "treasury-lead"],
  "claimAmount": 100,
  "treasuryBalanceBefore": 5,
  "treasuryBalanceAfter": -95,
  "note": "Full default coverage from treasury (100 <= 5% of TVL)"
}
```

## Workflow: Treasury Replenishment

### Trigger

Treasury balance falls below 3% of pool TVL (warning) or 1% (critical).

Metric alert:
```
iln_first_loss_treasury_balance / pool_tvl < 0.03
```

### Step 1: Request Replenishment

```bash
iln-dev treasury request-replenishment \
  --amount 10 \
  --source "protocol-operating-revenues"
```

Request requires both `compliance-lead` and `treasury-lead` approval.

### Step 2: Execute Replenishment

Once approved:

```bash
iln-dev treasury execute-replenishment \
  --replenishment-id "repl-12345" \
  --multi-sig-signer <wallet>
```

### Step 3: Validate

```bash
iln-dev treasury validate \
  --expected-balance 10
```

Verify:
- Treasury balance increased by requested amount
- No LP capital affected
- Accounting still balances

## Alerting & Monitoring

### Metrics to Watch

| Metric | Threshold | Action |
|--------|-----------|--------|
| `iln_first_loss_treasury_balance` | < 3% of TVL | Replenishment request |
| `iln_first_loss_treasury_balance` | < 1% of TVL | Page oncall |
| `iln_first_loss_claims_total` | > 10 in 7 days | Escalate to Risk team |
| `iln_first_loss_claim_denials_total` | > 0 | Investigate claim rejection |

### Automated Checks

**Nightly (00:00 UTC):**
```bash
pnpm run validate:first-loss-accounting
```

Output: JSON evidence artifact confirming:
- ✓ Treasury + LP Capital = Pool TVL
- ✓ Treasury >= 5% of pool TVL (or < 5% with justification)
- ✓ No pending claims without approvals
- ✓ All historical claims are idempotent

**Push CI:**
```bash
# In .github/workflows/ci.yml
- name: Validate First-Loss Accounting
  run: node scripts/hardening/run-wave9-controls.mjs --out /tmp/wave9-evidence.json
  env:
    POOL_TVL: ${{ env.POOL_TVL }}
    TREASURY_BALANCE: ${{ env.TREASURY_BALANCE }}
```

Fail CI if any scenario fails.

## Incident Response

### Scenario: Accounting Imbalance Detected

**Symptoms:**
```
Treasury (5) + LP Capital (94) ≠ Pool TVL (100)
```

**Diagnosis:**
1. Check for recent transactions: `git log --oneline | head -20`
2. Verify treasury balance on-chain: `iln-dev treasury inspect`
3. Verify LP capital balance: `iln-dev capital inspect`
4. Query recent token transfers: `iln-dev ledger transfers --since 1h`

**Resolution:**
1. If the imbalance is small (< 0.1%): likely rounding error; document and monitor
2. If > 0.1%: Page oncall immediately
3. Freeze all claim and replenishment operations until root cause found
4. File incident report with timestamps and affected accounts

### Scenario: Claim Denied Due to Insufficient Treasury

**Symptoms:**
```
Claim request for 10, but treasury balance is 2
Decision: CLAIM_DENIED
Reason: INSUFFICIENT_TREASURY_BALANCE
```

**Action:**
1. Coordinator notifies Compliance Lead
2. Assess whether default is real or disputed
3. If real: Initiate emergency treasury replenishment
4. If disputed: Route to Payer Authorization workflow (see `payer-authorization-failures.md`)

---

**Last Updated:** 2026-11-21
**Review Cadence:** Quarterly or after each claim
**Owner Approval:** Compliance Lead, Treasury Lead
