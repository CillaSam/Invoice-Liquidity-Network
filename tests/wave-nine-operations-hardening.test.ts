/**
 * Wave 9 Operations Hardening Test Suite (Issues #1324, #1325, #1326, #1327)
 *
 * Verifies production hardening controls:
 * - #1324: Add operational readiness review for mainnet controls
 * - #1325: Validate monitoring dashboards against service metrics
 * - #1326: Add incident postmortem action tracking
 * - #1327: Test emergency feature-disable paths
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  evaluateOperationalReadiness,
  evaluateMultisigControl,
  evaluateCircuitBreakerReadiness,
  evaluateTreasuryCoverage,
  evaluateEmergencyPauseFreshness,
  evaluateSecurityAuditSignoff,
  OPERATIONAL_READINESS_METRICS,
} from '../scripts/hardening/operational-readiness-review.mjs';

import {
  validateDashboard,
  validatePanel,
  validatePromqlSyntax,
  extractMetricsFromExpression,
  CANONICAL_SERVICE_METRICS,
  DASHBOARD_VALIDATION_METRICS,
} from '../scripts/hardening/validate-monitoring-dashboards.mjs';

import {
  parseActionItemsTable,
  validateActionItem,
  evaluatePostmortemActions,
  auditPostmortemsDirectory,
  POSTMORTEM_TRACKING_METRICS,
} from '../scripts/hardening/postmortem-action-tracking.mjs';

import {
  initialFeatureDisableState,
  isAuthorizedOperator,
  disableFeature,
  enableFeature,
  evaluateFeatureAccess,
  rehearseFeatureDisableScenario,
  EMERGENCY_DISABLE_METRICS,
} from '../scripts/hardening/emergency-feature-disable.mjs';

import {
  buildOperationsEvidence,
  allOperationsScenariosPass,
} from '../scripts/hardening/run-wave9-operations-controls.mjs';

const FIXED_NOW = 1700000000000;

describe('Issue #1324: Operational Readiness Review for Mainnet Controls', () => {
  const healthyInput = {
    multisig: {
      signers: ['GADMIN1', 'GADMIN2', 'GADMIN3'],
      quorum: 2,
      timelockSeconds: 86400,
    },
    circuitBreaker: {
      enabled: true,
      errorRateThreshold: 0.05,
    },
    treasury: {
      treasuryBalance: 50000,
      poolTvl: 1000000,
    },
    emergencyPause: {
      rehearsalPassed: true,
      lastRehearsalMs: FIXED_NOW - 5 * 24 * 3600 * 1000,
    },
    securityAudit: {
      status: 'Signed',
      independentReviewer: '@external-sec-auditor',
      auditDateMs: FIXED_NOW - 20 * 24 * 3600 * 1000,
    },
  };

  it('approves complete and healthy mainnet controls', () => {
    const res = evaluateOperationalReadiness(healthyInput, FIXED_NOW);
    expect(res.pass).toBe(true);
    expect(res.code).toBe('READINESS_APPROVED');
    expect(res.controlsPassed).toBe(5);
  });

  it('rejects multisig with deficient quorum or signers count', () => {
    const res = evaluateMultisigControl({
      signers: ['GADMIN1'],
      quorum: 1,
      timelockSeconds: 86400,
    });
    expect(res.pass).toBe(false);
    expect(res.code).toBe('MULTISIG_QUORUM_DEFICIENT');
  });

  it('rejects insufficient timelock duration', () => {
    const res = evaluateMultisigControl({
      signers: ['GADMIN1', 'GADMIN2'],
      quorum: 2,
      timelockSeconds: 3600,
    });
    expect(res.pass).toBe(false);
    expect(res.code).toBe('TIMELOCK_INSUFFICIENT');
  });

  it('rejects disabled circuit breaker or excessive error threshold', () => {
    const disabledRes = evaluateCircuitBreakerReadiness({ enabled: false, errorRateThreshold: 0.05 });
    expect(disabledRes.pass).toBe(false);
    expect(disabledRes.code).toBe('CIRCUIT_BREAKER_DISABLED');

    const highThreshold = evaluateCircuitBreakerReadiness({ enabled: true, errorRateThreshold: 0.1 });
    expect(highThreshold.pass).toBe(false);
    expect(highThreshold.code).toBe('CIRCUIT_BREAKER_THRESHOLD_INVALID');
  });

  it('rejects treasury coverage below minimum threshold', () => {
    const deficient = evaluateTreasuryCoverage({
      treasuryBalance: 1000,
      poolTvl: 100000,
    });
    expect(deficient.pass).toBe(false);
    expect(deficient.code).toBe('TREASURY_COVERAGE_DEFICIENT');
  });

  it('rejects stale emergency pause rehearsal', () => {
    const stale = evaluateEmergencyPauseFreshness(
      {
        rehearsalPassed: true,
        lastRehearsalMs: FIXED_NOW - 45 * 24 * 3600 * 1000,
      },
      FIXED_NOW
    );
    expect(stale.pass).toBe(false);
    expect(stale.code).toBe('EMERGENCY_PAUSE_STALE');
  });

  it('rejects unsigned security audit or unassigned reviewer', () => {
    const unsigned = evaluateSecurityAuditSignoff(
      {
        status: 'Pending',
        independentReviewer: '@auditor',
        auditDateMs: FIXED_NOW - 10 * 24 * 3600 * 1000,
      },
      FIXED_NOW
    );
    expect(unsigned.pass).toBe(false);
    expect(unsigned.code).toBe('AUDIT_NOT_SIGNED');

    const unassigned = evaluateSecurityAuditSignoff(
      {
        status: 'Signed',
        independentReviewer: 'TBD',
        auditDateMs: FIXED_NOW - 10 * 24 * 3600 * 1000,
      },
      FIXED_NOW
    );
    expect(unassigned.pass).toBe(false);
    expect(unassigned.code).toBe('INDEPENDENT_REVIEWER_REQUIRED');
  });

  it('publishes standard operational readiness metrics', () => {
    expect(OPERATIONAL_READINESS_METRICS.evaluations).toBe('iln_operational_readiness_evaluations_total');
    expect(OPERATIONAL_READINESS_METRICS.failures).toBe('iln_operational_readiness_failures_total');
  });
});

describe('Issue #1325: Validate Monitoring Dashboards Against Service Metrics', () => {
  it('extracts unique metric names from PromQL expressions', () => {
    const expr = 'rate(iln_invoice_submissions_total[1h]) + rate(iln_funded_invoices_total[1h])';
    const metrics = extractMetricsFromExpression(expr);
    expect(metrics.sort()).toEqual(['iln_funded_invoices_total', 'iln_invoice_submissions_total']);
  });

  it('validates PromQL delimiter syntax for balanced parentheses and brackets', () => {
    expect(validatePromqlSyntax('rate(iln_invoice_submissions_total[5m])').valid).toBe(true);
    expect(validatePromqlSyntax('rate(iln_invoice_submissions_total[5m]').valid).toBe(false);
    expect(validatePromqlSyntax('rate(iln_invoice_submissions_total[5m]))').valid).toBe(false);
    expect(validatePromqlSyntax('').valid).toBe(false);
  });

  it('validates production dashboard JSON file against canonical catalog', () => {
    const dashboardPath = path.resolve(__dirname, '../monitoring/grafana/dashboard.json');
    const raw = fs.readFileSync(dashboardPath, 'utf8');
    const data = JSON.parse(raw);

    const validation = validateDashboard(data, CANONICAL_SERVICE_METRICS);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
    expect(validation.totalPanels).toBeGreaterThanOrEqual(40);
  });

  it('detects rogue unregistered metrics', () => {
    const roguePanel = {
      title: 'Rogue Panel',
      type: 'graph',
      gridPos: { x: 0, y: 0, w: 12, h: 6 },
      targets: [{ expr: 'rate(iln_unregistered_metric_xyz[5m])' }],
    };

    const check = validatePanel(roguePanel, CANONICAL_SERVICE_METRICS);
    expect(check.valid).toBe(false);
    expect(check.errors[0]).toContain('unregistered metric');
  });

  it('publishes dashboard validation metrics', () => {
    expect(DASHBOARD_VALIDATION_METRICS.runs).toBe('iln_dashboard_validation_runs_total');
    expect(DASHBOARD_VALIDATION_METRICS.mismatches).toBe('iln_dashboard_metric_mismatches_total');
  });
});

describe('Issue #1326: Incident Postmortem Action Item Tracking', () => {
  const sampleMarkdown = `
## 6. Action Items (Corrective & Preventative)

| Action Item | Type | Assigned Owner | Target Repo | Due Date | Status |
|---|---|---|---|---|---|
| Enforce strict Zod schema validation before cache write | Preventative | @backend-lead | Invoice-Liquidity-Network | 2026-10-01 | DONE |
| Add dApp UI fallback state for unrecognized oracle codes | Corrective | @frontend-lead | ILN-Frontend | 2026-10-05 | IN_PROGRESS |
`;

  it('parses action items table from markdown postmortem content', () => {
    const items = parseActionItemsTable(sampleMarkdown, 'sample.md');
    expect(items).toHaveLength(2);
    expect(items[0].assignedOwner).toBe('@backend-lead');
    expect(items[0].status).toBe('DONE');
    expect(items[1].assignedOwner).toBe('@frontend-lead');
    expect(items[1].status).toBe('IN_PROGRESS');
  });

  it('validates action items schema and flags invalid values', () => {
    const valid = {
      line: 1,
      actionItem: 'Deploy health probe check',
      type: 'Preventative',
      assignedOwner: '@infra-lead',
      targetRepo: 'Invoice-Liquidity-Network',
      dueDate: '2026-12-01',
      status: 'TODO',
    };
    expect(validateActionItem(valid, FIXED_NOW).valid).toBe(true);

    const badOwner = { ...valid, assignedOwner: 'unassigned' };
    expect(validateActionItem(badOwner, FIXED_NOW).valid).toBe(false);

    const badStatus = { ...valid, status: 'UNKNOWN' };
    expect(validateActionItem(badStatus, FIXED_NOW).valid).toBe(false);
  });

  it('accurately identifies overdue items past due date', () => {
    const overdue = {
      line: 2,
      actionItem: 'Update firewall rules',
      type: 'Corrective',
      assignedOwner: '@sec-lead',
      targetRepo: 'Invoice-Liquidity-Network',
      dueDate: '2023-01-01',
      status: 'IN_PROGRESS',
    };
    const res = validateActionItem(overdue, FIXED_NOW);
    expect(res.valid).toBe(true);
    expect(res.isOverdue).toBe(true);
  });

  it('audits existing postmortems directory without parse errors', () => {
    const postmortemsDir = path.resolve(__dirname, '../docs/postmortems');
    const res = auditPostmortemsDirectory(postmortemsDir, FIXED_NOW);
    expect(res.pass).toBe(true);
    expect(res.totalActions).toBeGreaterThanOrEqual(4);
    expect(res.errors).toHaveLength(0);
  });

  it('publishes postmortem tracking metrics', () => {
    expect(POSTMORTEM_TRACKING_METRICS.actionsTotal).toBe('iln_postmortem_actions_total');
    expect(POSTMORTEM_TRACKING_METRICS.actionsOverdue).toBe('iln_postmortem_actions_overdue');
  });
});

describe('Issue #1327: Test Emergency Feature-Disable Paths', () => {
  it('initializes state tree with all features enabled', () => {
    const state = initialFeatureDisableState();
    expect(state.activeDisablesCount).toBe(0);
    expect(state.features.contracts.funding.enabled).toBe(true);
    expect(state.features.indexer.ingestion.enabled).toBe(true);
    expect(state.features.oracle.live_quotes.enabled).toBe(true);
  });

  it('verifies operator authorization', () => {
    expect(isAuthorizedOperator({ name: 'admin1', role: 'admin' })).toBe(true);
    expect(isAuthorizedOperator({ name: 'guest', role: 'contributor' })).toBe(false);
  });

  it('rejects unauthorized operator attempting emergency disable', () => {
    const state = initialFeatureDisableState();
    const attacker = { name: 'attacker', role: 'unauthorized' };

    const res = disableFeature(state, 'contracts', 'funding', attacker, 'Pause attempt', FIXED_NOW);
    expect(res.success).toBe(false);
    expect(res.code).toBe('OPERATOR_UNAUTHORIZED');
  });

  it('fails closed when accessing disabled feature without state modification', () => {
    let state = initialFeatureDisableState();
    const operator = { name: 'sec-lead', role: 'security-lead' };

    state = disableFeature(state, 'contracts', 'funding', operator, 'Drill', FIXED_NOW).nextState;
    const access = evaluateFeatureAccess(state, 'contracts', 'funding');
    expect(access.allowed).toBe(false);
    expect(access.code).toBe('SERVICE_PAUSED');
  });

  it('confirms repeat disable is idempotent', () => {
    let state = initialFeatureDisableState();
    const operator = { name: 'admin', role: 'admin' };

    const first = disableFeature(state, 'indexer', 'ingestion', operator, 'Pause', FIXED_NOW);
    state = first.nextState;
    expect(first.idempotent).toBe(false);

    const second = disableFeature(state, 'indexer', 'ingestion', operator, 'Repeat pause', FIXED_NOW + 1000);
    expect(second.success).toBe(true);
    expect(second.idempotent).toBe(true);
  });

  it('re-enables feature safely and restores access', () => {
    let state = initialFeatureDisableState();
    const operator = { name: 'admin', role: 'admin' };

    state = disableFeature(state, 'notifications', 'outbound_dispatch', operator, 'Maintenance', FIXED_NOW).nextState;
    expect(evaluateFeatureAccess(state, 'notifications', 'outbound_dispatch').allowed).toBe(false);

    state = enableFeature(state, 'notifications', 'outbound_dispatch', operator, FIXED_NOW + 2000).nextState;
    expect(evaluateFeatureAccess(state, 'notifications', 'outbound_dispatch').allowed).toBe(true);
    expect(state.activeDisablesCount).toBe(0);
  });

  it('executes full rehearsal scenario with passing results', () => {
    const rehearsal = rehearseFeatureDisableScenario();
    expect(rehearsal.pass).toBe(true);
    expect(rehearsal.code).toBe('REHEARSAL_PASSED');
    expect(rehearsal.scenarios).toHaveLength(7);
  });

  it('publishes emergency disable metrics', () => {
    expect(EMERGENCY_DISABLE_METRICS.disablesTotal).toBe('iln_emergency_disables_total');
    expect(EMERGENCY_DISABLE_METRICS.recoveriesTotal).toBe('iln_emergency_recoveries_total');
  });
});

describe('Wave 9 Operations Hardening Evidence Integration', () => {
  it('produces passing evidence artifact for all four issues', () => {
    const evidence = buildOperationsEvidence();
    expect(evidence.schemaVersion).toBe('wave9-operations-hardening/v1');
    expect(evidence.contractPauseUsed).toBe(false);
    expect(allOperationsScenariosPass(evidence)).toBe(true);
  });
});
