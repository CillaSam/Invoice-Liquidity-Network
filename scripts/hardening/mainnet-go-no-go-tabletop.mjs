#!/usr/bin/env node
/**
 * Independent go/no-go tabletop decision engine for issue #1330.
 *
 * This is a production control, not a prose checklist: it reads a signed
 * tabletop record and fails closed when a required scenario is missing,
 * unresolved, unevidenced, stale, or reviewed by someone who owns a mainnet
 * checklist item. The evaluators are pure, so replay/restart runs with the
 * same `--as-of` timestamp are byte-identical.
 *
 * Usage:
 *   node scripts/hardening/mainnet-go-no-go-tabletop.mjs \
 *     [--record docs/evidence/mainnet-go-no-go-tabletop.json] \
 *     [--repo-root .] [--as-of 2026-11-23T00:00:00.000Z] [--report report.json]
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_RECORD = 'docs/evidence/mainnet-go-no-go-tabletop.json';
export const DEFAULT_ON_CALL_MANIFEST = 'ops/on-call-checklist.json';
export const TABLETOP_SCHEMA = 'mainnet-go-no-go-tabletop/v1';
export const CONTROL_NAME = 'mainnet-go-no-go-tabletop';

export const TABLETOP_METRICS = Object.freeze({
  evaluations: 'iln_go_no_go_tabletop_evaluations_total',
  failures: 'iln_go_no_go_tabletop_failures_total',
  blockers: 'iln_go_no_go_blockers_total',
  decisions: 'iln_go_no_go_decisions',
});

export const DEFAULT_TABLETOP_CONFIG = Object.freeze({
  maxRecordAgeDays: 30,
  maxSignoffAgeDays: 30,
});

export const REQUIRED_SCENARIO_IDS = Object.freeze([
  'anchor-outage-insolvency',
  'lp-withdrawal-stress',
  'contract-pause-unpause',
  'indexer-replay-recovery',
  'notification-circuit-breaker',
  'config-poisoning',
  'governance-veto',
]);

export const REQUIRED_REVIEWER_AREAS = Object.freeze([
  'protocol-security',
  'liquidity-controls',
  'infrastructure-failover',
  'smart-contracts',
  'sdk',
  'release',
]);

const PLACEHOLDER = /^(?:tbd|pending|unassigned|unknown|none|n\/a|na|@example|example)$/i;

export function isPlaceholder(value) {
  return typeof value !== 'string' || value.trim().length === 0 || PLACEHOLDER.test(value.trim());
}

export function parseIsoDateTime(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value ? millis : null;
}

function check(name, pass, code, detail) {
  return { name, pass: Boolean(pass), code, detail };
}

function checklistOwnersFromManifest(manifest) {
  if (!manifest || typeof manifest.owners !== 'object') return [];
  return Object.values(manifest.owners).filter((value) => typeof value === 'string');
}

export function evaluateScenario(scenario, context = {}) {
  const exists = context.exists ?? (() => false);
  const asOfMs = context.asOfMs ?? Date.now();
  const id = typeof scenario?.id === 'string' ? scenario.id : 'unknown';
  const checks = [
    check('id', !isPlaceholder(id), 'TABLETOP_SCENARIO_ID_INVALID', 'scenario id required'),
    check('status', scenario?.status === 'PASS', 'TABLETOP_SCENARIO_FAILED', `${id} must PASS`),
    check('decision', scenario?.decision === 'GO', 'TABLETOP_SCENARIO_NO_GO', `${id} must be GO`),
    check(
      'expectedControl',
      !isPlaceholder(scenario?.expectedControl),
      'TABLETOP_CONTROL_MISSING',
      `${id} must name the control under test`
    ),
    check(
      'observedResult',
      !isPlaceholder(scenario?.observedResult),
      'TABLETOP_OBSERVATION_MISSING',
      `${id} must record the observed result`
    ),
    check(
      'evidencePath',
      !isPlaceholder(scenario?.evidencePath) && exists(scenario.evidencePath),
      'TABLETOP_EVIDENCE_MISSING',
      `${id} must link existing repository-local evidence`
    ),
    check(
      'owner',
      !isPlaceholder(scenario?.owner),
      'TABLETOP_OWNER_MISSING',
      `${id} must have a named owner`
    ),
    check(
      'recoveryPath',
      !isPlaceholder(scenario?.recoveryPath),
      'TABLETOP_RECOVERY_MISSING',
      `${id} must document a recovery path`
    ),
  ];

  const decisionLog = Array.isArray(scenario?.decisionLog) ? scenario.decisionLog : [];
  checks.push(
    check(
      'decisionLog',
      decisionLog.length > 0 &&
        decisionLog.every(
          (entry) =>
            parseIsoDateTime(entry?.at) !== null &&
            parseIsoDateTime(entry.at) <= asOfMs &&
            !isPlaceholder(entry?.actor) &&
            !isPlaceholder(entry?.outcome)
        ),
      'TABLETOP_DECISION_LOG_INVALID',
      `${id} needs at least one signed, non-future decision log entry`
    )
  );

  const failed = checks.find((entry) => !entry.pass);
  return {
    id,
    pass: !failed,
    code: failed ? failed.code : 'TABLETOP_SCENARIO_VERIFIED',
    checks,
  };
}

export function evaluateReviewers(reviewers, checklistOwners = [], asOfMs, config = DEFAULT_TABLETOP_CONFIG) {
  const checks = [];
  const list = Array.isArray(reviewers) ? reviewers : [];
  const owners = new Set(checklistOwners.map((value) => value.trim().toLowerCase()));

  for (const area of REQUIRED_REVIEWER_AREAS) {
    const matches = list.filter((reviewer) => reviewer?.area === area);
    checks.push(
      check(
        `reviewer:${area}:present`,
        matches.length > 0,
        'TABLETOP_REVIEWER_MISSING',
        `independent ${area} reviewer required`
      )
    );
    for (const reviewer of matches) {
      const signedAt = parseIsoDateTime(reviewer?.signedAt);
      checks.push(
        check(
          `reviewer:${area}:name`,
          !isPlaceholder(reviewer?.name),
          'TABLETOP_REVIEWER_PLACEHOLDER',
          `${area} reviewer must be named`
        ),
        check(
          `reviewer:${area}:independence`,
          reviewer?.relationship === 'independent' &&
            !owners.has(String(reviewer?.name ?? '').trim().toLowerCase()),
          'TABLETOP_REVIEWER_NOT_INDEPENDENT',
          `${area} reviewer must be independent of checklist owners`
        ),
        check(
          `reviewer:${area}:signoff`,
          reviewer?.signoff === 'Signed',
          'TABLETOP_REVIEWER_NOT_SIGNED',
          `${area} reviewer sign-off must be Signed`
        ),
        check(
          `reviewer:${area}:freshness`,
          signedAt !== null &&
            signedAt <= asOfMs &&
            asOfMs - signedAt <= config.maxSignoffAgeDays * 86400000,
          'TABLETOP_REVIEWER_STALE',
          `${area} reviewer sign-off must be within ${config.maxSignoffAgeDays} days and not in the future`
        )
      );
    }
  }
  return checks;
}

export function evaluateTabletop(record, context = {}) {
  const asOfMs = context.asOfMs ?? Date.now();
  const config = { ...DEFAULT_TABLETOP_CONFIG, ...(context.config ?? {}) };
  const exists = context.exists ?? (() => false);
  const checklistOwners = context.checklistOwners ?? [];

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return {
      control: CONTROL_NAME,
      pass: false,
      decision: 'NO_GO',
      code: 'TABLETOP_RECORD_INVALID',
      checks: [check('record:shape', false, 'TABLETOP_RECORD_INVALID', 'record object required')],
      blockers: [],
      owner: null,
      recovery:
        'Restore docs/evidence/mainnet-go-no-go-tabletop.json from version control and rerun the gate.',
      metrics: { ...TABLETOP_METRICS },
    };
  }

  const executedAt = parseIsoDateTime(record.executedAt);
  const scenarios = Array.isArray(record.scenarios) ? record.scenarios : [];
  const scenarioById = new Map(scenarios.map((scenario) => [scenario?.id, scenario]));
  const scenarioResults = REQUIRED_SCENARIO_IDS.map((id) =>
    evaluateScenario(scenarioById.get(id) ?? { id }, { exists, asOfMs })
  );
  const blockers = Array.isArray(record.blockers) ? record.blockers : [];

  const checks = [
    check(
      'record:schema',
      record.schemaVersion === TABLETOP_SCHEMA,
      'TABLETOP_SCHEMA_MISMATCH',
      `schemaVersion must be ${TABLETOP_SCHEMA}`
    ),
    check(
      'record:decision',
      record.decision === 'GO',
      'TABLETOP_OVERALL_NO_GO',
      'overall tabletop decision must be GO'
    ),
    check(
      'record:owner',
      !isPlaceholder(record.owner),
      'TABLETOP_OWNER_MISSING',
      'tabletop owner must be named'
    ),
    check(
      'record:checklistRevision',
      !isPlaceholder(record.checklistRevision),
      'TABLETOP_CHECKLIST_REVISION_MISSING',
      'tabletop must cite the checklist revision under test'
    ),
    check(
      'record:executedAt',
      executedAt !== null &&
        executedAt <= asOfMs &&
        asOfMs - executedAt <= config.maxRecordAgeDays * 86400000,
      'TABLETOP_STALE_OR_FUTURE',
      `tabletop must be dated within ${config.maxRecordAgeDays} days and not in the future`
    ),
    check(
      'record:blockers',
      blockers.length === 0,
      'TABLETOP_UNRESOLVED_BLOCKERS',
      'all blockers must be resolved before GO'
    ),
    ...scenarioResults.map((result) =>
      check(`scenario:${result.id}`, result.pass, result.code, result.id)
    ),
    ...evaluateReviewers(record.reviewers, checklistOwners, asOfMs, config),
  ];

  const failed = checks.find((entry) => !entry.pass);
  const decision = failed ? 'NO_GO' : 'GO';
  return {
    control: CONTROL_NAME,
    pass: !failed,
    decision,
    code: failed ? failed.code : 'TABLETOP_GO',
    checks,
    blockers,
    owner: record.owner ?? null,
    asOf: new Date(asOfMs).toISOString(),
    scenarios: scenarioResults,
    recovery:
      'NO_GO: resolve the listed blocker(s), attach fresh repository-local evidence, obtain new independent Signed review, update the tabletop record, and rerun the gate.',
    metrics: { ...TABLETOP_METRICS },
  };
}

export function evaluateRepositoryTabletop(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const recordPath = resolve(repoRoot, options.record ?? DEFAULT_RECORD);
  const manifestPath = resolve(repoRoot, options.onCallManifest ?? DEFAULT_ON_CALL_MANIFEST);
  const exists = options.exists ?? ((relativePath) => existsSync(resolve(repoRoot, relativePath)));
  const asOfMs = options.asOfMs ?? Date.now();

  if (!existsSync(recordPath)) {
    return {
      control: CONTROL_NAME,
      pass: false,
      decision: 'NO_GO',
      code: 'TABLETOP_RECORD_MISSING',
      checks: [],
      blockers: [],
      owner: null,
      recovery: 'Restore docs/evidence/mainnet-go-no-go-tabletop.json and rerun the gate.',
      metrics: { ...TABLETOP_METRICS },
    };
  }

  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    return {
      control: CONTROL_NAME,
      pass: false,
      decision: 'NO_GO',
      code: 'TABLETOP_RECORD_MALFORMED',
      checks: [],
      blockers: [],
      owner: null,
      detail: error instanceof Error ? error.message : String(error),
      recovery: 'Repair the tabletop record JSON and rerun the gate.',
      metrics: { ...TABLETOP_METRICS },
    };
  }

  let checklistOwners = options.checklistOwners;
  if (!checklistOwners && existsSync(manifestPath)) {
    try {
      checklistOwners = checklistOwnersFromManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch {
      checklistOwners = [];
    }
  }

  return evaluateTabletop(record, {
    ...options,
    exists,
    asOfMs,
    checklistOwners: checklistOwners ?? [],
  });
}

function parseArgs(args) {
  const parsed = { record: DEFAULT_RECORD, repoRoot: null, asOf: null, report: null };
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].split('=', 2);
    if (flag === '--record') parsed.record = inline ?? args[++i];
    else if (flag === '--repo-root') parsed.repoRoot = inline ?? args[++i];
    else if (flag === '--as-of') parsed.asOf = inline ?? args[++i];
    else if (flag === '--report') parsed.report = inline ?? args[++i];
  }
  return parsed;
}

function main() {
  const args = parseArgs(argv.slice(2));
  const repoRoot = args.repoRoot ? resolve(args.repoRoot) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const asOfMs = args.asOf ? parseIsoDateTime(args.asOf) : Date.now();
  const result =
    asOfMs === null
      ? {
          control: CONTROL_NAME,
          pass: false,
          decision: 'NO_GO',
          code: 'TABLETOP_AS_OF_INVALID',
          checks: [],
          blockers: [],
          recovery: 'Pass --as-of with a full ISO-8601 UTC timestamp.',
          metrics: { ...TABLETOP_METRICS },
        }
      : evaluateRepositoryTabletop({ repoRoot, record: args.record, asOfMs });

  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (args.report) writeFileSync(args.report, payload);
  else stdout.write(payload);

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        '### Mainnet go/no-go tabletop (#1330)',
        '',
        `| Result | Decision | Code | Owner |`,
        `|---|---|---|---|`,
        `| ${result.pass ? '✅ pass' : '❌ fail'} | ${result.decision} | \`${result.code}\` | ${
          result.owner ?? 'unassigned'
        } |`,
        '',
        `Recovery: ${result.recovery}`,
        '',
      ].join('\n')
    );
  }

  if (!result.pass) {
    stdout.write(`Mainnet go/no-go tabletop: ${result.decision} (${result.code})\n`);
    exit(1);
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(argv[1] || '').href;
if (invokedDirectly) main();
