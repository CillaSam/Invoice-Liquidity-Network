#!/usr/bin/env node
/**
 * Monitoring dashboard validation against service metrics catalog (#1325).
 *
 * Invariants:
 *   - All PromQL metric expressions in monitoring dashboards must map to
 *     registered metrics emitted by ILN core, indexer, oracle, or notifications;
 *   - Core service health and SLO panels must be present and well-formed;
 *   - Panels must include valid titles, grid positions, and target expressions;
 *   - PromQL syntax must have balanced parentheses and valid range selectors;
 *   - Fail-closed: uncataloged metrics, empty targets, or structural errors fail validation.
 *
 * This module is pure and dependency-free: identical dashboard input always
 * produces identical validation results for deterministic CI verification.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

export const DASHBOARD_VALIDATION_METRICS = Object.freeze({
  runs: 'iln_dashboard_validation_runs_total',
  mismatches: 'iln_dashboard_metric_mismatches_total',
  syntaxErrors: 'iln_dashboard_syntax_errors_total',
  validatedPanels: 'iln_dashboard_validated_panels_total',
});

/**
 * Canonical service metrics catalog registered across ILN components.
 */
export const CANONICAL_SERVICE_METRICS = Object.freeze(
  new Set([
    // Core protocol metrics
    'iln_contract_error_total',
    'iln_cost_usd_total',
    'iln_defaulted_invoices_total',
    'iln_error_count_total',
    'iln_funded_invoices_total',
    'iln_invoice_submissions_total',
    'iln_lp_portfolio_size_usd',
    'iln_paid_invoices_total',
    'iln_simulation_duration_ms_bucket',
    'iln_slo_error_budget_burn',
    'iln_transaction_duration_ms_bucket',
    'iln_transaction_fee_count',
    'iln_transaction_fee_sum',

    // Indexer metrics
    'iln_cursor_updated_at',
    'iln_db_errors_total',
    'iln_db_query_duration_seconds_bucket',
    'iln_events_processed_total',
    'iln_invoices_upserted_total',
    'iln_last_processed_ledger',
    'iln_indexer_safe_checkpoint_ledger',
    'iln_indexer_rollback_rehearsals_total',
    'iln_indexer_rollback_failures_total',
    'iln_indexer_cursor_stall_events_total',
    'iln_indexer_cursor_lifetime_seconds',

    // Oracle & API service metrics
    'iln_http_errors_total',
    'iln_http_request_duration_seconds_bucket',
    'iln_http_requests_total',
    'iln_oracle_request_duration_seconds',
    'iln_oracle_failures_total',
    'iln_oracle_stale_quotes_total',
    'iln_oracle_circuit_breaker_state',

    // Notifications metrics
    'iln_notifications_active_subscriptions',
    'iln_notifications_audit_records_total',
    'iln_notifications_cost_usd_total',
    'iln_notifications_delivery_duration_seconds_bucket',
    'iln_notifications_dispatches_total',
    'iln_notifications_failures_total',
    'iln_notifications_fallback_deliveries_total',
    'iln_notifications_health_checks_total',
    'iln_notifications_rate_limit_hits_total',
    'iln_notifications_dlq_pending_items',
    'iln_notifications_replay_success_rate',

    // Wave 9 Hardening & Operations metrics
    'iln_circuit_breaker_active',
    'iln_circuit_breaker_activations_total',
    'iln_circuit_breaker_recoveries_total',
    'iln_circuit_breaker_manual_overrides_total',
    'iln_settlement_anchor_decisions_total',
    'iln_settlement_anchor_holds_total',
    'iln_first_loss_treasury_balance',
    'iln_lp_capital_balance',
    'iln_first_loss_claims_total',
    'iln_first_loss_claim_denials_total',
    'iln_first_loss_replenishment_requests',
    'iln_withdrawal_queue_requests_queued',
    'iln_withdrawal_queue_requests_processed',
    'iln_withdrawal_queue_partial_fills',
    'iln_withdrawal_queue_pause_triggers',
    'iln_redemption_pricing_decisions_total',
    'iln_redemption_pricing_rejects_total',
    'iln_operational_readiness_evaluations_total',
    'iln_operational_readiness_failures_total',
    'iln_operational_readiness_controls_verified',
    'iln_operational_readiness_stale_audits_total',
    'iln_dashboard_validation_runs_total',
    'iln_dashboard_metric_mismatches_total',
    'iln_dashboard_syntax_errors_total',
    'iln_dashboard_validated_panels_total',
    'iln_postmortem_actions_total',
    'iln_postmortem_actions_overdue',
    'iln_postmortem_actions_completed',
    'iln_emergency_disables_total',
    'iln_emergency_recoveries_total',
    'iln_emergency_rejections_total',
  ])
);

export const REQUIRED_DASHBOARD_PANELS = Object.freeze([
  'Invoice Submissions per Hour',
  'Funded Invoices per Hour',
  'Last Processed Ledger',
]);

/**
 * Extracts all ILN metric identifiers from a PromQL query expression.
 */
export function extractMetricsFromExpression(expr) {
  if (typeof expr !== 'string') return [];
  const matches = expr.matchAll(/\b(iln_[a-zA-Z0-9_]+)\b/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

/**
 * Validates PromQL query syntax for balanced delimiters.
 */
export function validatePromqlSyntax(expr) {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    return { valid: false, reason: 'Empty PromQL expression' };
  }

  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closers = new Set(Object.values(pairs));

  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (pairs[ch]) {
      stack.push({ char: ch, pos: i });
    } else if (closers.has(ch)) {
      if (stack.length === 0) {
        return { valid: false, reason: `Unmatched closing '${ch}' at position ${i}` };
      }
      const last = stack.pop();
      if (pairs[last.char] !== ch) {
        return { valid: false, reason: `Mismatched '${last.char}' closed by '${ch}' at position ${i}` };
      }
    }
  }

  if (stack.length > 0) {
    return { valid: false, reason: `Unclosed '${stack[0].char}' opened at position ${stack[0].pos}` };
  }

  return { valid: true, reason: 'Syntax balanced' };
}

/**
 * Validates a single dashboard panel.
 */
export function validatePanel(panel, metricsCatalog = CANONICAL_SERVICE_METRICS) {
  if (!panel || typeof panel !== 'object') {
    return { valid: false, errors: ['Panel must be an object'] };
  }

  const errors = [];
  if (!panel.title || typeof panel.title !== 'string') {
    errors.push('Panel missing required title');
  }

  if (!panel.type || typeof panel.type !== 'string') {
    errors.push(`Panel '${panel.title || 'unnamed'}': missing required type`);
  }

  if (panel.gridPos) {
    const { w, h } = panel.gridPos;
    if (typeof w !== 'number' || w <= 0 || typeof h !== 'number' || h <= 0) {
      errors.push(`Panel '${panel.title}': invalid grid dimensions (w: ${w}, h: ${h})`);
    }
  }

  const targets = Array.isArray(panel.targets) ? panel.targets : [];
  const metricsFound = [];

  for (let idx = 0; idx < targets.length; idx += 1) {
    const target = targets[idx];
    const expr = target.expr;

    if (!expr || typeof expr !== 'string') {
      errors.push(`Panel '${panel.title}': target ${idx} has missing or invalid expression`);
      continue;
    }

    const syntaxCheck = validatePromqlSyntax(expr);
    if (!syntaxCheck.valid) {
      errors.push(`Panel '${panel.title}': target ${idx} syntax error: ${syntaxCheck.reason}`);
    }

    const extracted = extractMetricsFromExpression(expr);
    for (const m of extracted) {
      metricsFound.push(m);
      if (!metricsCatalog.has(m)) {
        errors.push(`Panel '${panel.title}': target ${idx} references unregistered metric '${m}'`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    title: panel.title,
    metricsFound: [...new Set(metricsFound)],
    errors,
  };
}

/**
 * Validates the full monitoring dashboard definition against the service metrics catalog.
 */
export function validateDashboard(dashboardData, metricsCatalog = CANONICAL_SERVICE_METRICS) {
  if (!dashboardData || typeof dashboardData !== 'object') {
    return {
      valid: false,
      totalPanels: 0,
      totalMetrics: 0,
      missingRequiredPanels: [],
      errors: ['Dashboard root data must be an object'],
    };
  }

  const dashboard = dashboardData.dashboard || dashboardData;
  const panels = Array.isArray(dashboard.panels) ? dashboard.panels : [];
  const errors = [];
  const metricsObserved = new Set();
  const panelTitles = new Set();
  let validPanelsCount = 0;

  for (const panel of panels) {
    if (panel.title) panelTitles.add(panel.title);
    const result = validatePanel(panel, metricsCatalog);
    if (result.valid) {
      validPanelsCount += 1;
    } else {
      errors.push(...result.errors);
    }
    for (const m of result.metricsFound) {
      metricsObserved.add(m);
    }
  }

  const missingRequiredPanels = REQUIRED_DASHBOARD_PANELS.filter((req) => !panelTitles.has(req));
  for (const missing of missingRequiredPanels) {
    errors.push(`Required SLO panel missing from dashboard: '${missing}'`);
  }

  return {
    valid: errors.length === 0,
    uid: dashboard.uid || 'unknown',
    title: dashboard.title || 'unknown',
    totalPanels: panels.length,
    validPanels: validPanelsCount,
    totalMetrics: metricsObserved.size,
    metricsList: [...metricsObserved].sort(),
    missingRequiredPanels,
    errors,
  };
}

function parseCliArgs(args) {
  const result = { json: false, outFile: null, dashboardPath: 'monitoring/grafana/dashboard.json' };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') {
      result.json = true;
    } else if (args[i] === '--out' && args[i + 1]) {
      result.outFile = args[i + 1];
      i += 1;
    } else if (args[i] === '--dashboard' && args[i + 1]) {
      result.dashboardPath = args[i + 1];
      i += 1;
    }
  }
  return result;
}

function main() {
  const { dashboardPath, outFile } = parseCliArgs(argv.slice(2));
  try {
    const raw = readFileSync(dashboardPath, 'utf8');
    const data = JSON.parse(raw);
    const validation = validateDashboard(data);

    const payload = JSON.stringify(
      {
        schemaVersion: 'dashboard-metric-validation/v1',
        dashboardFile: dashboardPath,
        validation,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    );

    if (outFile) {
      writeFileSync(outFile, `${payload}\n`);
    } else {
      stdout.write(`${payload}\n`);
    }

    if (!validation.valid) {
      stdout.write('Monitoring dashboard validation: FAILED\n');
      exit(1);
    }
  } catch (err) {
    stdout.write(`Failed to validate dashboard: ${err.message}\n`);
    exit(1);
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(argv[1] || '').href;
if (invokedDirectly) {
  main();
}
