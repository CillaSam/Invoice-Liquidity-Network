#!/usr/bin/env node
/**
 * Operator and CI evidence runner for Wave 9 Operations Hardening Controls
 * (#1324, #1325, #1326, #1327).
 *
 * Runs a deterministic test matrix across the four operational hardening modules:
 *   - #1324: Operational readiness review for mainnet controls
 *   - #1325: Validate monitoring dashboards against service metrics
 *   - #1326: Incident postmortem action item tracking and SLA enforcement
 *   - #1327: Test emergency feature-disable and kill-switch paths
 *
 * Emits a structured, replay-safe JSON evidence artifact proving that all controls
 * remain active across restarts and boundary conditions.
 *
 * Usage:
 *   node scripts/hardening/run-wave9-operations-controls.mjs [--json] [--out FILE]
 */

import { writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  OPERATIONAL_READINESS_METRICS,
  evaluateOperationalReadiness,
} from './operational-readiness-review.mjs';

import {
  CANONICAL_SERVICE_METRICS,
  DASHBOARD_VALIDATION_METRICS,
  validateDashboard,
} from './validate-monitoring-dashboards.mjs';

import {
  POSTMORTEM_TRACKING_METRICS,
  evaluatePostmortemActions,
} from './postmortem-action-tracking.mjs';

import {
  EMERGENCY_DISABLE_METRICS,
  disableFeature,
  evaluateFeatureAccess,
  initialFeatureDisableState,
  rehearseFeatureDisableScenario,
} from './emergency-feature-disable.mjs';

export const OPERATIONS_EVIDENCE_SCHEMA = 'wave9-operations-hardening/v1';

const HEALTHY_READINESS_INPUT = Object.freeze({
  multisig: Object.freeze({
    signers: Object.freeze(['GADMIN1', 'GADMIN2', 'GADMIN3']),
    quorum: 2,
    timelockSeconds: 86400,
  }),
  circuitBreaker: Object.freeze({
    enabled: true,
    errorRateThreshold: 0.05,
  }),
  treasury: Object.freeze({
    treasuryBalance: 50000,
    poolTvl: 1000000,
  }),
  emergencyPause: Object.freeze({
    rehearsalPassed: true,
    lastRehearsalMs: 1700000000000 - 5 * 24 * 3600 * 1000,
  }),
  securityAudit: Object.freeze({
    status: 'Signed',
    independentReviewer: '@external-auditor-sec',
    auditDateMs: 1700000000000 - 20 * 24 * 3600 * 1000,
  }),
});

const HEALTHY_DASHBOARD_FIXTURE = Object.freeze({
  dashboard: {
    uid: 'test-dashboard',
    title: 'Test Operational Dashboard',
    panels: [
      {
        title: 'Invoice Submissions per Hour',
        type: 'graph',
        gridPos: { x: 0, y: 0, w: 8, h: 6 },
        targets: [{ expr: 'rate(iln_invoice_submissions_total[1h])' }],
      },
      {
        title: 'Funded Invoices per Hour',
        type: 'graph',
        gridPos: { x: 8, y: 0, w: 8, h: 6 },
        targets: [{ expr: 'rate(iln_funded_invoices_total[1h])' }],
      },
      {
        title: 'Last Processed Ledger',
        type: 'stat',
        gridPos: { x: 16, y: 0, w: 8, h: 6 },
        targets: [{ expr: 'iln_last_processed_ledger' }],
      },
    ],
  },
});

const SAMPLE_POSTMORTEM_ACTIONS = Object.freeze([
  {
    sourceFile: 'postmortem-incident-1.md',
    line: 80,
    actionItem: 'Enforce strict schema validation before cache write',
    type: 'Preventative',
    assignedOwner: '@sec-commander',
    targetRepo: 'Invoice-Liquidity-Network',
    dueDate: '2026-12-01',
    status: 'DONE',
  },
  {
    sourceFile: 'postmortem-incident-1.md',
    line: 81,
    actionItem: 'Add triage runbook flowchart for cross-service failure',
    type: 'Corrective',
    assignedOwner: '@infra-lead',
    targetRepo: 'Invoice-Liquidity-Network',
    dueDate: '2026-12-05',
    status: 'IN_PROGRESS',
  },
]);

function scenario(name, expectation, observed) {
  return { name, expectation, observed, pass: observed === expectation };
}

/**
 * Builds deterministic operations hardening evidence.
 */
export function buildOperationsEvidence() {
  const testNow = 1700000000000;

  // #1324 Readiness review scenarios
  const readinessHealthy = evaluateOperationalReadiness(HEALTHY_READINESS_INPUT, testNow);
  const readinessBadMultisig = evaluateOperationalReadiness(
    {
      ...HEALTHY_READINESS_INPUT,
      multisig: { signers: ['G1'], quorum: 1, timelockSeconds: 100 },
    },
    testNow
  );
  const readinessDisabledCircuit = evaluateOperationalReadiness(
    {
      ...HEALTHY_READINESS_INPUT,
      circuitBreaker: { enabled: false },
    },
    testNow
  );
  const readinessStalePause = evaluateOperationalReadiness(
    {
      ...HEALTHY_READINESS_INPUT,
      emergencyPause: {
        rehearsalPassed: true,
        lastRehearsalMs: testNow - 60 * 24 * 3600 * 1000,
      },
    },
    testNow
  );

  // #1325 Dashboard metric validation scenarios
  const dashboardHealthy = validateDashboard(HEALTHY_DASHBOARD_FIXTURE, CANONICAL_SERVICE_METRICS);
  const dashboardUnregistered = validateDashboard(
    {
      dashboard: {
        ...HEALTHY_DASHBOARD_FIXTURE.dashboard,
        panels: [
          ...HEALTHY_DASHBOARD_FIXTURE.dashboard.panels,
          {
            title: 'Rogue Panel',
            type: 'graph',
            gridPos: { x: 0, y: 6, w: 8, h: 6 },
            targets: [{ expr: 'rate(iln_unregistered_metric_xyz[5m])' }],
          },
        ],
      },
    },
    CANONICAL_SERVICE_METRICS
  );
  const dashboardSyntaxError = validateDashboard(
    {
      dashboard: {
        ...HEALTHY_DASHBOARD_FIXTURE.dashboard,
        panels: [
          ...HEALTHY_DASHBOARD_FIXTURE.dashboard.panels,
          {
            title: 'Syntax Error Panel',
            type: 'graph',
            gridPos: { x: 0, y: 6, w: 8, h: 6 },
            targets: [{ expr: 'rate(iln_invoice_submissions_total[5m' }],
          },
        ],
      },
    },
    CANONICAL_SERVICE_METRICS
  );

  // #1326 Postmortem action tracking scenarios
  const actionsValid = evaluatePostmortemActions(SAMPLE_POSTMORTEM_ACTIONS, testNow);
  const actionsMissingOwner = evaluatePostmortemActions(
    [
      {
        sourceFile: 'bad-pm.md',
        line: 10,
        actionItem: 'Fix defect',
        type: 'Corrective',
        assignedOwner: '@unassigned',
        targetRepo: 'Invoice-Liquidity-Network',
        dueDate: '2026-12-01',
        status: 'TODO',
      },
    ],
    testNow
  );
  const actionsOverdue = evaluatePostmortemActions(
    [
      {
        sourceFile: 'overdue-pm.md',
        line: 12,
        actionItem: 'Patch vulnerability',
        type: 'Preventative',
        assignedOwner: '@sec-lead',
        targetRepo: 'Invoice-Liquidity-Network',
        dueDate: '2023-01-01',
        status: 'IN_PROGRESS',
      },
    ],
    testNow
  );

  // #1327 Emergency feature-disable rehearsal scenarios
  const featureRehearsal = rehearseFeatureDisableScenario();
  const initDisableState = initialFeatureDisableState();
  const operator = { name: 'sec-lead', role: 'security-lead' };
  const disabledFunding = disableFeature(initDisableState, 'contracts', 'funding', operator, 'Containment drill', testNow);
  const accessWhileDisabled = evaluateFeatureAccess(disabledFunding.nextState, 'contracts', 'funding');

  return {
    schemaVersion: OPERATIONS_EVIDENCE_SCHEMA,
    contractPauseUsed: false,
    controls: {
      operationalReadinessReview: {
        issue: 1324,
        metrics: { ...OPERATIONAL_READINESS_METRICS },
        scenarios: [
          scenario('healthy_mainnet_controls_approved', true, readinessHealthy.pass),
          scenario('deficient_multisig_quorum_rejected', false, readinessBadMultisig.pass),
          scenario('disabled_circuit_breaker_rejected', false, readinessDisabledCircuit.pass),
          scenario('stale_emergency_pause_rejected', false, readinessStalePause.pass),
        ],
      },
      validateMonitoringDashboards: {
        issue: 1325,
        metrics: { ...DASHBOARD_VALIDATION_METRICS },
        scenarios: [
          scenario('canonical_dashboard_metrics_validated', true, dashboardHealthy.valid),
          scenario('unregistered_metric_rejected', false, dashboardUnregistered.valid),
          scenario('malformed_promql_syntax_rejected', false, dashboardSyntaxError.valid),
        ],
      },
      postmortemActionTracking: {
        issue: 1326,
        metrics: { ...POSTMORTEM_TRACKING_METRICS },
        scenarios: [
          scenario('action_items_schema_validated', true, actionsValid.pass),
          scenario('missing_owner_rejected', false, actionsMissingOwner.pass),
          scenario('overdue_items_detected', 1, actionsOverdue.overdueActions),
        ],
      },
      emergencyFeatureDisablePaths: {
        issue: 1327,
        metrics: { ...EMERGENCY_DISABLE_METRICS },
        scenarios: [
          scenario('feature_rehearsal_passed', true, featureRehearsal.pass),
          scenario('disabled_funding_fails_closed', false, accessWhileDisabled.allowed),
          scenario('disabled_code_service_paused', 'SERVICE_PAUSED', accessWhileDisabled.code),
        ],
      },
    },
  };
}

export function allOperationsScenariosPass(evidence) {
  return Object.values(evidence.controls)
    .flatMap((control) => control.scenarios)
    .every((entry) => entry.pass);
}

function parseCliArgs(args) {
  const result = { json: false, outFile: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') {
      result.json = true;
    } else if (args[i] === '--out' && args[i + 1]) {
      result.outFile = args[i + 1];
      i += 1;
    }
  }
  return result;
}

function main() {
  const { outFile } = parseCliArgs(argv.slice(2));
  const evidence = { ...buildOperationsEvidence(), generatedAt: new Date().toISOString() };
  const payload = JSON.stringify(evidence, null, 2);

  if (outFile) {
    writeFileSync(outFile, `${payload}\n`);
  } else {
    stdout.write(`${payload}\n`);
  }

  if (!allOperationsScenariosPass(evidence)) {
    stdout.write('Wave 9 operations control evidence: FAILED\n');
    exit(1);
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(argv[1] || '').href;
if (invokedDirectly) {
  main();
}
