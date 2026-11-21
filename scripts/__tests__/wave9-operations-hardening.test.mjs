/**
 * Regression and validation test suite for Wave 9 Operations Hardening Controls:
 * - Issue #1324: Operational readiness review for mainnet controls
 * - Issue #1325: Validate monitoring dashboards against service metrics
 * - Issue #1326: Incident postmortem action item tracking and SLA enforcement
 * - Issue #1327: Test emergency feature-disable and kill-switch paths
 *
 * Designed to execute cleanly via node:test with zero external dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_READINESS_CONFIG,
  evaluateCircuitBreakerReadiness,
  evaluateEmergencyPauseFreshness,
  evaluateMultisigControl,
  evaluateOperationalReadiness,
  evaluateSecurityAuditSignoff,
  evaluateTreasuryCoverage,
} from '../hardening/operational-readiness-review.mjs';

import {
  CANONICAL_SERVICE_METRICS,
  REQUIRED_DASHBOARD_PANELS,
  extractMetricsFromExpression,
  validateDashboard,
  validatePanel,
  validatePromqlSyntax,
} from '../hardening/validate-monitoring-dashboards.mjs';

import {
  auditPostmortemsDirectory,
  evaluatePostmortemActions,
  parseActionItemsTable,
  validateActionItem,
} from '../hardening/postmortem-action-tracking.mjs';

import {
  disableFeature,
  enableFeature,
  evaluateFeatureAccess,
  initialFeatureDisableState,
  isAuthorizedOperator,
  isValidFeaturePath,
  rehearseFeatureDisableScenario,
} from '../hardening/emergency-feature-disable.mjs';

import {
  allOperationsScenariosPass,
  buildOperationsEvidence,
} from '../hardening/run-wave9-operations-controls.mjs';

const FIXED_NOW_MS = 1700000000000;

// ============================================================================
// Issue #1324: Operational Readiness Review
// ============================================================================

describe('Issue #1324: Operational Readiness Review for Mainnet Controls', () => {
  const validMultisig = {
    signers: ['GADMIN1', 'GADMIN2', 'GADMIN3'],
    quorum: 2,
    timelockSeconds: 86400,
  };

  const validCircuit = {
    enabled: true,
    errorRateThreshold: 0.05,
  };

  const validTreasury = {
    treasuryBalance: 50000,
    poolTvl: 1000000,
  };

  const validEmergencyPause = {
    rehearsalPassed: true,
    lastRehearsalMs: FIXED_NOW_MS - 5 * 24 * 3600 * 1000,
  };

  const validSecurityAudit = {
    status: 'Signed',
    independentReviewer: '@external-auditor',
    auditDateMs: FIXED_NOW_MS - 20 * 24 * 3600 * 1000,
  };

  it('approves complete, healthy mainnet controls configuration', () => {
    const input = {
      multisig: validMultisig,
      circuitBreaker: validCircuit,
      treasury: validTreasury,
      emergencyPause: validEmergencyPause,
      securityAudit: validSecurityAudit,
    };

    const res = evaluateOperationalReadiness(input, FIXED_NOW_MS);
    assert.equal(res.pass, true);
    assert.equal(res.code, 'READINESS_APPROVED');
    assert.equal(res.controlsPassed, 5);
  });

  it('rejects multisig with deficient quorum or signers count', () => {
    const res = evaluateMultisigControl({
      signers: ['GADMIN1'],
      quorum: 1,
      timelockSeconds: 86400,
    });
    assert.equal(res.pass, false);
    assert.equal(res.code, 'MULTISIG_QUORUM_DEFICIENT');
  });

  it('rejects multisig with insufficient timelock duration', () => {
    const res = evaluateMultisigControl({
      signers: ['GADMIN1', 'GADMIN2'],
      quorum: 2,
      timelockSeconds: 3600,
    });
    assert.equal(res.pass, false);
    assert.equal(res.code, 'TIMELOCK_INSUFFICIENT');
  });

  it('rejects disabled circuit breaker or excessive error threshold', () => {
    const disabledRes = evaluateCircuitBreakerReadiness({ enabled: false, errorRateThreshold: 0.05 });
    assert.equal(disabledRes.pass, false);
    assert.equal(disabledRes.code, 'CIRCUIT_BREAKER_DISABLED');

    const highThreshold = evaluateCircuitBreakerReadiness({ enabled: true, errorRateThreshold: 0.1 });
    assert.equal(highThreshold.pass, false);
    assert.equal(highThreshold.code, 'CIRCUIT_BREAKER_THRESHOLD_INVALID');
  });

  it('rejects treasury coverage below required ratio', () => {
    const deficientTreasury = evaluateTreasuryCoverage({
      treasuryBalance: 2000,
      poolTvl: 100000, // 2% coverage (below 5% required)
    });
    assert.equal(deficientTreasury.pass, false);
    assert.equal(deficientTreasury.code, 'TREASURY_COVERAGE_DEFICIENT');
  });

  it('rejects stale emergency pause rehearsal', () => {
    const stalePause = evaluateEmergencyPauseFreshness(
      {
        rehearsalPassed: true,
        lastRehearsalMs: FIXED_NOW_MS - 45 * 24 * 3600 * 1000, // 45 days old (max 30)
      },
      FIXED_NOW_MS
    );
    assert.equal(stalePause.pass, false);
    assert.equal(stalePause.code, 'EMERGENCY_PAUSE_STALE');
  });

  it('rejects unsigned audit or missing independent reviewer', () => {
    const unsignedAudit = evaluateSecurityAuditSignoff(
      {
        status: 'Pending',
        independentReviewer: '@auditor',
        auditDateMs: FIXED_NOW_MS - 10 * 24 * 3600 * 1000,
      },
      FIXED_NOW_MS
    );
    assert.equal(unsignedAudit.pass, false);
    assert.equal(unsignedAudit.code, 'AUDIT_NOT_SIGNED');

    const unassignedReviewer = evaluateSecurityAuditSignoff(
      {
        status: 'Signed',
        independentReviewer: 'TBD',
        auditDateMs: FIXED_NOW_MS - 10 * 24 * 3600 * 1000,
      },
      FIXED_NOW_MS
    );
    assert.equal(unassignedReviewer.pass, false);
    assert.equal(unassignedReviewer.code, 'INDEPENDENT_REVIEWER_REQUIRED');
  });

  it('is deterministic across repeat invocations and process restarts', () => {
    const input = {
      multisig: validMultisig,
      circuitBreaker: validCircuit,
      treasury: validTreasury,
      emergencyPause: validEmergencyPause,
      securityAudit: validSecurityAudit,
    };

    const run1 = evaluateOperationalReadiness(input, FIXED_NOW_MS);
    const run2 = evaluateOperationalReadiness(input, FIXED_NOW_MS);
    assert.deepEqual(run1, run2);
  });
});

// ============================================================================
// Issue #1325: Validate Monitoring Dashboards Against Service Metrics
// ============================================================================

describe('Issue #1325: Validate Monitoring Dashboards Against Service Metrics', () => {
  it('extracts unique metric names from PromQL expressions', () => {
    const expr = 'rate(iln_invoice_submissions_total[1h]) + rate(iln_funded_invoices_total[1h])';
    const metrics = extractMetricsFromExpression(expr);
    assert.deepEqual(metrics.sort(), ['iln_funded_invoices_total', 'iln_invoice_submissions_total']);
  });

  it('validates PromQL delimiter syntax for balanced parentheses and brackets', () => {
    assert.equal(validatePromqlSyntax('rate(iln_invoice_submissions_total[5m])').valid, true);
    assert.equal(validatePromqlSyntax('rate(iln_invoice_submissions_total[5m]').valid, false);
    assert.equal(validatePromqlSyntax('rate(iln_invoice_submissions_total[5m]))').valid, false);
    assert.equal(validatePromqlSyntax('').valid, false);
  });

  it('validates individual panel structure and checks metrics against catalog', () => {
    const validPanel = {
      title: 'Invoice Submissions',
      type: 'graph',
      gridPos: { x: 0, y: 0, w: 12, h: 6 },
      targets: [{ expr: 'rate(iln_invoice_submissions_total[5m])' }],
    };

    const check = validatePanel(validPanel, CANONICAL_SERVICE_METRICS);
    assert.equal(check.valid, true);
    assert.equal(check.errors.length, 0);

    const roguePanel = {
      title: 'Rogue Panel',
      type: 'graph',
      gridPos: { x: 0, y: 0, w: 12, h: 6 },
      targets: [{ expr: 'rate(iln_unknown_custom_metric_xyz[5m])' }],
    };

    const rogueCheck = validatePanel(roguePanel, CANONICAL_SERVICE_METRICS);
    assert.equal(rogueCheck.valid, false);
    assert.ok(rogueCheck.errors[0].includes('unregistered metric'));
  });

  it('validates the production monitoring/grafana/dashboard.json file', () => {
    const dashboardPath = resolve('monitoring/grafana/dashboard.json');
    const raw = readFileSync(dashboardPath, 'utf8');
    const data = JSON.parse(raw);

    const validation = validateDashboard(data, CANONICAL_SERVICE_METRICS);
    assert.equal(validation.valid, true);
    assert.equal(validation.errors.length, 0);
    assert.ok(validation.totalPanels >= 40);
    assert.ok(validation.totalMetrics >= 30);
  });

  it('detects missing required SLO panels', () => {
    const incompleteDashboard = {
      dashboard: {
        uid: 'incomplete',
        title: 'Incomplete Dashboard',
        panels: [
          {
            title: 'Invoice Submissions per Hour',
            type: 'graph',
            gridPos: { x: 0, y: 0, w: 8, h: 6 },
            targets: [{ expr: 'rate(iln_invoice_submissions_total[1h])' }],
          },
        ],
      },
    };

    const res = validateDashboard(incompleteDashboard, CANONICAL_SERVICE_METRICS);
    assert.equal(res.valid, false);
    assert.ok(res.missingRequiredPanels.includes('Funded Invoices per Hour'));
  });
});

// ============================================================================
// Issue #1326: Incident Postmortem Action Item Tracking
// ============================================================================

describe('Issue #1326: Incident Postmortem Action Item Tracking', () => {
  const sampleMarkdown = `
# Incident Postmortem

## 6. Action Items (Corrective & Preventative)

| Action Item | Type | Assigned Owner | Target Repo | Due Date | Status |
|---|---|---|---|---|---|
| Enforce strict Zod schema validation before cache write | Preventative | @backend-lead | Invoice-Liquidity-Network | 2026-10-01 | DONE |
| Add dApp UI fallback state for unrecognized oracle codes | Corrective | @frontend-lead | ILN-Frontend | 2026-10-05 | IN_PROGRESS |
`;

  it('parses action items table from postmortem markdown content', () => {
    const items = parseActionItemsTable(sampleMarkdown, 'test-postmortem.md');
    assert.equal(items.length, 2);
    assert.equal(items[0].assignedOwner, '@backend-lead');
    assert.equal(items[0].status, 'DONE');
    assert.equal(items[1].assignedOwner, '@frontend-lead');
    assert.equal(items[1].status, 'IN_PROGRESS');
  });

  it('validates action items schema and detects invalid fields', () => {
    const validItem = {
      line: 10,
      actionItem: 'Deploy health probe check',
      type: 'Preventative',
      assignedOwner: '@infra-lead',
      targetRepo: 'Invoice-Liquidity-Network',
      dueDate: '2026-12-01',
      status: 'TODO',
    };

    const checkValid = validateActionItem(validItem, FIXED_NOW_MS);
    assert.equal(checkValid.valid, true);

    const invalidOwner = {
      ...validItem,
      assignedOwner: 'unassigned',
    };
    const checkOwner = validateActionItem(invalidOwner, FIXED_NOW_MS);
    assert.equal(checkOwner.valid, false);

    const invalidStatus = {
      ...validItem,
      status: 'MAYBE_LATER',
    };
    const checkStatus = validateActionItem(invalidStatus, FIXED_NOW_MS);
    assert.equal(checkStatus.valid, false);
  });

  it('accurately detects overdue action items past due date', () => {
    const overdueItem = {
      line: 15,
      actionItem: 'Update firewall rules',
      type: 'Corrective',
      assignedOwner: '@sec-lead',
      targetRepo: 'Invoice-Liquidity-Network',
      dueDate: '2023-01-01',
      status: 'IN_PROGRESS',
    };

    const check = validateActionItem(overdueItem, FIXED_NOW_MS);
    assert.equal(check.valid, true);
    assert.equal(check.isOverdue, true);
  });

  it('audits existing docs/postmortems directory in repository', () => {
    const res = auditPostmortemsDirectory('docs/postmortems', FIXED_NOW_MS);
    assert.equal(res.pass, true);
    assert.ok(res.totalActions >= 4);
    assert.equal(res.errors.length, 0);
  });
});

// ============================================================================
// Issue #1327: Emergency Feature-Disable Paths
// ============================================================================

describe('Issue #1327: Test Emergency Feature-Disable Paths', () => {
  it('initializes state tree with all supported feature paths enabled', () => {
    const state = initialFeatureDisableState();
    assert.equal(state.activeDisablesCount, 0);
    assert.equal(state.features.contracts.funding.enabled, true);
    assert.equal(state.features.indexer.ingestion.enabled, true);
    assert.equal(state.features.oracle.live_quotes.enabled, true);
    assert.equal(state.features.notifications.outbound_dispatch.enabled, true);
  });

  it('allows authorized operator check', () => {
    assert.equal(isAuthorizedOperator({ name: 'admin1', role: 'admin' }), true);
    assert.equal(isAuthorizedOperator({ name: 'sec1', role: 'security-lead' }), true);
    assert.equal(isAuthorizedOperator({ name: 'guest', role: 'contributor' }), false);
    assert.equal(isAuthorizedOperator(null), false);
  });

  it('rejects unauthorized operator attempting emergency disable', () => {
    const state = initialFeatureDisableState();
    const attacker = { name: 'attacker', role: 'unauthorized' };

    const res = disableFeature(state, 'contracts', 'funding', attacker, 'Malicious pause', FIXED_NOW_MS);
    assert.equal(res.success, false);
    assert.equal(res.code, 'OPERATOR_UNAUTHORIZED');
    assert.equal(state.features.contracts.funding.enabled, true);
  });

  it('fails closed when accessing a disabled feature without state mutation', () => {
    let state = initialFeatureDisableState();
    const operator = { name: 'sec-lead', role: 'security-lead' };

    const disableRes = disableFeature(state, 'contracts', 'funding', operator, 'Drill', FIXED_NOW_MS);
    assert.equal(disableRes.success, true);
    state = disableRes.nextState;

    const access = evaluateFeatureAccess(state, 'contracts', 'funding');
    assert.equal(access.allowed, false);
    assert.equal(access.code, 'SERVICE_PAUSED');
  });

  it('guarantees repeat disable is idempotent', () => {
    let state = initialFeatureDisableState();
    const operator = { name: 'admin', role: 'admin' };

    const first = disableFeature(state, 'indexer', 'ingestion', operator, 'Pause', FIXED_NOW_MS);
    state = first.nextState;
    assert.equal(first.idempotent, false);

    const second = disableFeature(state, 'indexer', 'ingestion', operator, 'Pause again', FIXED_NOW_MS + 1000);
    assert.equal(second.success, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.nextState.activeDisablesCount, 1);
  });

  it('re-enables feature safely and restores access', () => {
    let state = initialFeatureDisableState();
    const operator = { name: 'admin', role: 'admin' };

    state = disableFeature(state, 'notifications', 'outbound_dispatch', operator, 'Maintenance', FIXED_NOW_MS).nextState;
    assert.equal(evaluateFeatureAccess(state, 'notifications', 'outbound_dispatch').allowed, false);

    state = enableFeature(state, 'notifications', 'outbound_dispatch', operator, FIXED_NOW_MS + 2000).nextState;
    assert.equal(evaluateFeatureAccess(state, 'notifications', 'outbound_dispatch').allowed, true);
    assert.equal(state.activeDisablesCount, 0);
  });

  it('executes full rehearsal scenario successfully', () => {
    const rehearsal = rehearseFeatureDisableScenario();
    assert.equal(rehearsal.pass, true);
    assert.equal(rehearsal.code, 'REHEARSAL_PASSED');
    assert.equal(rehearsal.scenarios.length, 7);
    for (const sc of rehearsal.scenarios) {
      assert.equal(sc.pass, true);
    }
  });
});

// ============================================================================
// Operations Hardening Evidence Integration
// ============================================================================

describe('Wave 9 Operations Hardening Evidence Runner', () => {
  it('builds evidence artifact covering all 4 issues with 100% passing scenarios', () => {
    const evidence = buildOperationsEvidence();
    assert.equal(evidence.schemaVersion, 'wave9-operations-hardening/v1');
    assert.equal(evidence.contractPauseUsed, false);

    const controlKeys = Object.keys(evidence.controls).sort();
    assert.deepEqual(controlKeys, [
      'emergencyFeatureDisablePaths',
      'operationalReadinessReview',
      'postmortemActionTracking',
      'validateMonitoringDashboards',
    ]);

    assert.equal(allOperationsScenariosPass(evidence), true);
  });
});
