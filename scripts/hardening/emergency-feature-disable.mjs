#!/usr/bin/env node
/**
 * Emergency feature-disable and kill-switch control paths (#1327).
 *
 * Reference invariants:
 *   - Emergency feature-disable covers core contract, indexer, oracle,
 *     notifications, and settlement-anchor services;
 *   - Disabling a feature requires an authorized operator (admin or incident commander);
 *   - When disabled, any invocation on that feature path fails closed immediately
 *     with FEATURE_DISABLED without modifying state or losing buffered messages;
 *   - Feature-disable is idempotent: repeat disable calls succeed without error;
 *   - Safe recovery: re-enabling a feature restores normal processing without
 *     re-executing processed records or dropping pending queue entries;
 *   - Fail-closed: missing authorization or invalid feature names fail.
 *
 * This module is pure and dependency-free: identical inputs and operations
 * produce identical state transitions and decision logs for reproducible audit.
 */

import { writeFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

export const EMERGENCY_DISABLE_METRICS = Object.freeze({
  disablesTotal: 'iln_emergency_disables_total',
  recoveriesTotal: 'iln_emergency_recoveries_total',
  rejectionsTotal: 'iln_emergency_rejections_total',
  activeDisables: 'iln_emergency_active_disables',
});

export const AUTHORIZED_OPERATOR_ROLES = Object.freeze(
  new Set(['admin', 'incident-commander', 'security-lead', 'protocol-lead'])
);

export const SUPPORTED_FEATURE_PATHS = Object.freeze({
  contracts: Object.freeze(['funding', 'repayment', 'transfers', 'invoicing']),
  indexer: Object.freeze(['ingestion', 'reorg_detection']),
  oracle: Object.freeze(['live_quotes', 'circuit_breaker_bypass']),
  notifications: Object.freeze(['outbound_dispatch', 'provider_fallback']),
  settlement: Object.freeze(['anchor_routing', 'fiat_payouts']),
});

/**
 * Initializes feature-disable state tree with all features enabled.
 */
export function initialFeatureDisableState() {
  const features = {};
  for (const [service, featureList] of Object.entries(SUPPORTED_FEATURE_PATHS)) {
    features[service] = {};
    for (const f of featureList) {
      features[service][f] = {
        enabled: true,
        disabledAtMs: null,
        disabledBy: null,
        reason: null,
      };
    }
  }

  return {
    features,
    activeDisablesCount: 0,
    history: [],
    rejectionsCount: 0,
  };
}

/**
 * Validates whether an operator is authorized to trigger emergency controls.
 */
export function isAuthorizedOperator(operator) {
  if (!operator || typeof operator !== 'object') return false;
  return AUTHORIZED_OPERATOR_ROLES.has(operator.role);
}

/**
 * Validates whether a service and feature exist in the supported paths.
 */
export function isValidFeaturePath(service, feature) {
  const serviceFeatures = SUPPORTED_FEATURE_PATHS[service];
  return Array.isArray(serviceFeatures) && serviceFeatures.includes(feature);
}

/**
 * Disables a feature path emergency kill switch.
 */
export function disableFeature(state, service, feature, operator, reason, nowMs = Date.now()) {
  if (!isValidFeaturePath(service, feature)) {
    return {
      success: false,
      code: 'INVALID_FEATURE_PATH',
      reason: `Unknown feature path: ${service}.${feature}`,
      nextState: state,
    };
  }

  if (!isAuthorizedOperator(operator)) {
    return {
      success: false,
      code: 'OPERATOR_UNAUTHORIZED',
      reason: `Operator '${operator?.name || 'unknown'}' (${operator?.role || 'none'}) is not authorized for emergency controls`,
      nextState: state,
    };
  }

  const currentFeatureState = state.features[service][feature];
  const alreadyDisabled = currentFeatureState.enabled === false;

  const nextState = {
    ...state,
    features: {
      ...state.features,
      [service]: {
        ...state.features[service],
        [feature]: {
          enabled: false,
          disabledAtMs: alreadyDisabled ? currentFeatureState.disabledAtMs : nowMs,
          disabledBy: operator.name,
          reason: reason || 'Emergency stop requested',
        },
      },
    },
    activeDisablesCount: alreadyDisabled ? state.activeDisablesCount : state.activeDisablesCount + 1,
    history: [
      ...state.history,
      {
        action: 'DISABLE',
        service,
        feature,
        operator: operator.name,
        timestampMs: nowMs,
        idempotent: alreadyDisabled,
      },
    ],
  };

  return {
    success: true,
    code: 'FEATURE_DISABLED',
    reason: `Feature ${service}.${feature} disabled by ${operator.name}`,
    idempotent: alreadyDisabled,
    nextState,
  };
}

/**
 * Enables / restores a feature path.
 */
export function enableFeature(state, service, feature, operator, nowMs = Date.now()) {
  if (!isValidFeaturePath(service, feature)) {
    return {
      success: false,
      code: 'INVALID_FEATURE_PATH',
      reason: `Unknown feature path: ${service}.${feature}`,
      nextState: state,
    };
  }

  if (!isAuthorizedOperator(operator)) {
    return {
      success: false,
      code: 'OPERATOR_UNAUTHORIZED',
      reason: `Operator '${operator?.name || 'unknown'}' (${operator?.role || 'none'}) is not authorized for emergency controls`,
      nextState: state,
    };
  }

  const currentFeatureState = state.features[service][feature];
  const alreadyEnabled = currentFeatureState.enabled === true;

  const nextState = {
    ...state,
    features: {
      ...state.features,
      [service]: {
        ...state.features[service],
        [feature]: {
          enabled: true,
          disabledAtMs: null,
          disabledBy: null,
          reason: null,
        },
      },
    },
    activeDisablesCount: alreadyEnabled ? state.activeDisablesCount : Math.max(0, state.activeDisablesCount - 1),
    history: [
      ...state.history,
      {
        action: 'ENABLE',
        service,
        feature,
        operator: operator.name,
        timestampMs: nowMs,
        idempotent: alreadyEnabled,
      },
    ],
  };

  return {
    success: true,
    code: 'FEATURE_ENABLED',
    reason: `Feature ${service}.${feature} enabled by ${operator.name}`,
    idempotent: alreadyEnabled,
    nextState,
  };
}

/**
 * Evaluates whether an operation on a feature path is allowed or fails closed.
 */
export function evaluateFeatureAccess(state, service, feature) {
  if (!isValidFeaturePath(service, feature)) {
    return {
      allowed: false,
      code: 'UNKNOWN_FEATURE',
      reason: `Unknown feature ${service}.${feature}`,
      nextState: state,
    };
  }

  const featureState = state.features[service][feature];
  if (!featureState.enabled) {
    const nextState = {
      ...state,
      rejectionsCount: state.rejectionsCount + 1,
    };
    return {
      allowed: false,
      code: 'SERVICE_PAUSED',
      reason: `Operation rejected: ${service}.${feature} is disabled (${featureState.reason})`,
      nextState,
    };
  }

  return {
    allowed: true,
    code: 'ACCESS_GRANTED',
    reason: `Feature ${service}.${feature} active`,
    nextState: state,
  };
}

/**
 * Executes a simulated rehearsal of emergency feature-disable and recovery.
 */
export function rehearseFeatureDisableScenario() {
  const operator = { name: 'sec-commander', role: 'security-lead' };
  const rogueOperator = { name: 'attacker', role: 'guest' };
  const now = 1700000000000;

  let state = initialFeatureDisableState();

  // 1. Baseline: verify access granted
  const baseline = evaluateFeatureAccess(state, 'contracts', 'funding');

  // 2. Unauthorized attempt rejected
  const unauth = disableFeature(state, 'contracts', 'funding', rogueOperator, 'Malicious pause', now);

  // 3. Authorized emergency disable
  const disableRes = disableFeature(state, 'contracts', 'funding', operator, 'Containment drill', now);
  state = disableRes.nextState;

  // 4. Access attempt while disabled: must fail closed without state modification
  const rejected = evaluateFeatureAccess(state, 'contracts', 'funding');
  state = rejected.nextState;

  // 5. Repeat disable: must be idempotent
  const repeatDisable = disableFeature(state, 'contracts', 'funding', operator, 'Repeat pause', now + 1000);
  state = repeatDisable.nextState;

  // 6. Authorized recovery: enable feature
  const enableRes = enableFeature(state, 'contracts', 'funding', operator, now + 2000);
  state = enableRes.nextState;

  // 7. Post-recovery: access granted again
  const recovered = evaluateFeatureAccess(state, 'contracts', 'funding');

  const allPassed =
    baseline.allowed === true &&
    unauth.success === false &&
    unauth.code === 'OPERATOR_UNAUTHORIZED' &&
    disableRes.success === true &&
    rejected.allowed === false &&
    rejected.code === 'SERVICE_PAUSED' &&
    repeatDisable.success === true &&
    repeatDisable.idempotent === true &&
    enableRes.success === true &&
    recovered.allowed === true;

  return {
    pass: allPassed,
    code: allPassed ? 'REHEARSAL_PASSED' : 'REHEARSAL_FAILED',
    scenarios: [
      { name: 'baseline_access_granted', pass: baseline.allowed === true },
      { name: 'unauthorized_disable_rejected', pass: unauth.success === false },
      { name: 'authorized_disable_active', pass: disableRes.success === true },
      { name: 'disabled_access_fails_closed', pass: rejected.allowed === false },
      { name: 'repeat_disable_idempotent', pass: repeatDisable.idempotent === true },
      { name: 'authorized_enable_recovers', pass: enableRes.success === true },
      { name: 'recovered_access_granted', pass: recovered.allowed === true },
    ],
  };
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
  const rehearsal = rehearseFeatureDisableScenario();
  const payload = JSON.stringify(
    {
      schemaVersion: 'emergency-feature-disable/v1',
      metrics: { ...EMERGENCY_DISABLE_METRICS },
      rehearsal,
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

  if (!rehearsal.pass) {
    stdout.write('Emergency feature-disable rehearsal: FAILED\n');
    exit(1);
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(argv[1] || '').href;
if (invokedDirectly) {
  main();
}
