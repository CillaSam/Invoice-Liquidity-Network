#!/usr/bin/env node
/**
 * On-call escalation and handoff control for issue #1329.
 *
 * Documentation alone cannot fail a build. This dependency-free module reads
 * `ops/on-call-checklist.json` and fails closed when ownership is missing or
 * placeholder, escalation SLAs lapse, the handoff date is overdue, checklist
 * anchors disappear from the runbook, or the published canonical page and
 * navigation/mainnet-checklist evidence drift away.
 *
 * All evaluators are pure functions; the CLI only reads files and writes the
 * report, so replaying the same `--as-of` date yields byte-identical results.
 *
 * Usage:
 *   node scripts/hardening/on-call-escalation-handoff.mjs \
 *     [--manifest ops/on-call-checklist.json] [--repo-root .] \
 *     [--as-of YYYY-MM-DD] [--report path/to/report.json]
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_MANIFEST = 'ops/on-call-checklist.json';
export const CONTROL_NAME = 'on-call-escalation-handoff';
export const MANIFEST_SCHEMA_VERSION = 1;

export const ON_CALL_METRICS = Object.freeze({
  evaluations: 'iln_on_call_checklist_evaluations_total',
  failures: 'iln_on_call_checklist_failures_total',
  overdueHandoffs: 'iln_on_call_overdue_handoffs_total',
  dueSoonWarnings: 'iln_on_call_handoff_due_soon_total',
});

export const DEFAULT_ON_CALL_CONFIG = Object.freeze({
  maxAckMinutes: 15,
  maxP1EscalationMinutes: 15,
  minRemainingDays: 1,
  maxHandoffWindowHours: 24,
});

export const REQUIRED_OWNER_ROLES = Object.freeze([
  'primary',
  'oncall',
  'secondary',
  'escalation',
  'checklist_owner',
]);

const PLACEHOLDER = /^(?:tbd|pending|unassigned|unknown|none|n\/a|na|@example|example)$/i;

/** True for empty strings and well-known placeholder owner values. */
export function isPlaceholder(value) {
  return typeof value !== 'string' || value.trim().length === 0 || PLACEHOLDER.test(value.trim());
}

/** Strict UTC calendar-date parser: rejects rollover such as 2026-02-30. */
export function parseCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString().slice(0, 10) === value ? millis : null;
}

function check(name, pass, code, detail) {
  return { name, pass: Boolean(pass), code, detail };
}

export function evaluateOwners(owners) {
  return REQUIRED_OWNER_ROLES.map((role) =>
    check(
      `owner:${role}`,
      !isPlaceholder(owners?.[role]),
      'ON_CALL_OWNER_MISSING',
      `${role} must be a named, non-placeholder owner`
    )
  );
}

export function evaluateSlas(sla, config = DEFAULT_ON_CALL_CONFIG) {
  const ack = Number(sla?.ack_minutes);
  const p1 = Number(sla?.p1_escalation_minutes);
  const p2 = Number(sla?.p2_escalation_minutes);
  return [
    check(
      'sla:ack',
      Number.isFinite(ack) && ack > 0 && ack <= config.maxAckMinutes,
      'ON_CALL_ACK_SLA_INVALID',
      `ack_minutes must be between 1 and ${config.maxAckMinutes}`
    ),
    check(
      'sla:p1_escalation',
      Number.isFinite(p1) && p1 > 0 && p1 <= config.maxP1EscalationMinutes,
      'ON_CALL_P1_SLA_INVALID',
      `p1_escalation_minutes must be between 1 and ${config.maxP1EscalationMinutes}`
    ),
    check(
      'sla:p2_escalation',
      Number.isFinite(p2) && Number.isFinite(p1) && p2 >= p1,
      'ON_CALL_P2_SLA_INVALID',
      'p2_escalation_minutes must be at least p1_escalation_minutes'
    ),
  ];
}

export function evaluateRotation(rotation, asOfMs, config = DEFAULT_ON_CALL_CONFIG) {
  const last = parseCalendarDate(rotation?.last_handoff);
  const due = parseCalendarDate(rotation?.next_handoff_due);
  const intervalDays = Number(rotation?.interval_days);
  const windowHours = Number(rotation?.handoff_window_hours);
  const expectedDue = last === null ? null : last + intervalDays * 86400000;

  const checks = [
    check(
      'rotation:dates',
      last !== null && due !== null,
      'ON_CALL_HANDOFF_DATES_INVALID',
      'last_handoff and next_handoff_due must be strict YYYY-MM-DD dates'
    ),
    check(
      'rotation:interval',
      Number.isInteger(intervalDays) && intervalDays > 0 && intervalDays <= 31,
      'ON_CALL_ROTATION_INTERVAL_INVALID',
      'interval_days must be an integer between 1 and 31'
    ),
    check(
      'rotation:window',
      Number.isFinite(windowHours) &&
        windowHours > 0 &&
        windowHours <= config.maxHandoffWindowHours,
      'ON_CALL_HANDOFF_WINDOW_INVALID',
      `handoff_window_hours must be between 1 and ${config.maxHandoffWindowHours}`
    ),
    check(
      'rotation:consistent',
      expectedDue !== null && due === expectedDue,
      'ON_CALL_HANDOFF_DATE_INCONSISTENT',
      'next_handoff_due must equal last_handoff + interval_days'
    ),
    check(
      'rotation:current',
      due !== null && asOfMs <= due,
      'ON_CALL_HANDOFF_OVERDUE',
      'the on-call handoff is overdue; complete a real handoff before it lapses'
    ),
  ];

  const warnings = [];
  if (due !== null && asOfMs <= due && due - asOfMs <= config.minRemainingDays * 86400000) {
    warnings.push({
      code: 'ON_CALL_HANDOFF_DUE_SOON',
      detail: `handoff due within ${config.minRemainingDays} day(s)`,
    });
  }

  return { checks, warnings };
}

/** GitHub-style heading anchors derived from Markdown heading text. */
export function headingAnchors(markdown) {
  const anchors = new Set();
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const slug = match[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    if (slug) anchors.add(`#${slug}`);
  }
  return anchors;
}

export function evaluateChecklist(checklist, runbookText = '') {
  const checks = [];
  if (!Array.isArray(checklist) || checklist.length === 0) {
    checks.push(
      check('checklist:present', false, 'ON_CALL_CHECKLIST_MISSING', 'checklist must not be empty')
    );
    return { checks };
  }

  const anchors = headingAnchors(runbookText);
  const seen = new Set();
  checklist.forEach((item, index) => {
    const id = typeof item?.id === 'string' ? item.id : '';
    checks.push(
      check(
        `checklist:${index}:id`,
        id.length > 0 && !isPlaceholder(id) && !seen.has(id),
        'ON_CALL_CHECKLIST_ID_INVALID',
        'each checklist item needs a unique non-placeholder id'
      )
    );
    if (id) seen.add(id);
    checks.push(
      check(
        `checklist:${id || index}:owner`,
        !isPlaceholder(item?.owner),
        'ON_CALL_CHECKLIST_OWNER_MISSING',
        'each checklist item needs a named owner'
      )
    );
    checks.push(
      check(
        `checklist:${id || index}:anchor`,
        typeof item?.runbook_anchor === 'string' && anchors.has(item.runbook_anchor),
        'ON_CALL_RUNBOOK_ANCHOR_MISSING',
        'each checklist item must link to an existing runbook section'
      )
    );
  });
  return { checks };
}

/**
 * Pure evaluator. `context` may inject `exists`, `readText`, `asOfMs`,
 * `config`, and `runbookText`; defaults use the real filesystem.
 */
export function evaluateOnCallReadiness(manifest, context = {}) {
  const config = { ...DEFAULT_ON_CALL_CONFIG, ...(context.config ?? {}) };
  const asOfMs = context.asOfMs ?? Date.now();
  const repoRoot = context.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const exists = context.exists ?? ((relativePath) => existsSync(resolve(repoRoot, relativePath)));
  const readText =
    context.readText ?? ((relativePath) => readFileSync(resolve(repoRoot, relativePath), 'utf8'));
  const readTextOrEmpty = (relativePath) => {
    try {
      return readText(relativePath);
    } catch {
      return '';
    }
  };

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      control: CONTROL_NAME,
      pass: false,
      code: 'ON_CALL_MANIFEST_INVALID',
      owner: null,
      asOf: new Date(asOfMs).toISOString().slice(0, 10),
      checks: [check('manifest:shape', false, 'ON_CALL_MANIFEST_INVALID', 'manifest object required')],
      warnings: [],
      recovery:
        'Restore ops/on-call-checklist.json from version control and rerun the gate.',
      metrics: { ...ON_CALL_METRICS },
    };
  }

  const runbookPath = typeof manifest.runbook === 'string' ? manifest.runbook : '';
  const runbookText =
    context.runbookText ??
    (runbookPath && exists(runbookPath) ? readTextOrEmpty(runbookPath) : '');
  const rotation = evaluateRotation(manifest.rotation, asOfMs, config);
  const checklist = evaluateChecklist(manifest.checklist, runbookText);
  const requiredPaths = [manifest.runbook, manifest.published_page, manifest.evidence].filter(
    (value) => typeof value === 'string' && value.length > 0
  );

  const checks = [
    check(
      'manifest:control',
      manifest.control === CONTROL_NAME,
      'ON_CALL_CONTROL_MISMATCH',
      `control must be ${CONTROL_NAME}`
    ),
    check(
      'manifest:version',
      manifest.version === MANIFEST_SCHEMA_VERSION,
      'ON_CALL_SCHEMA_VERSION_MISMATCH',
      `version must be ${MANIFEST_SCHEMA_VERSION}`
    ),
    ...evaluateOwners(manifest.owners),
    ...evaluateSlas(manifest.sla, config),
    ...rotation.checks,
    ...checklist.checks,
    ...requiredPaths.map((path) =>
      check(
        `path:${path}`,
        exists(path),
        'ON_CALL_DEPENDENCY_MISSING',
        `required file missing: ${path}`
      )
    ),
  ];

  if (manifest.published_page) {
    const canonicalTs = readTextOrEmpty('packages/docs/content/_meta.ts');
    const legacyJson = readTextOrEmpty('docs/_meta.json');
    const pageKey = manifest.published_page
      .replace(/^packages\/docs\/content\//, '')
      .replace(/\.mdx$/, '');
    checks.push(
      check(
        'docs:canonical-nav',
        canonicalTs.includes(pageKey),
        'ON_CALL_CANONICAL_NAV_MISSING',
        `${pageKey} must be registered in packages/docs/content/_meta.ts`
      ),
      check(
        'docs:legacy-nav',
        legacyJson.includes(pageKey),
        'ON_CALL_LEGACY_NAV_MISSING',
        `${pageKey} must be registered in docs/_meta.json`
      )
    );
  }

  if (manifest.evidence && exists(manifest.evidence)) {
    const checklistText = readTextOrEmpty(manifest.evidence);
    checks.push(
      check(
        'evidence:mainnet-checklist',
        checklistText.includes('on-call-escalation-handoff') &&
          checklistText.includes('ops/on-call-checklist.json'),
        'ON_CALL_EVIDENCE_LINK_MISSING',
        'mainnet checklist must link the canonical page and manifest'
      )
    );
  }

  const failed = checks.find((entry) => !entry.pass);
  return {
    control: CONTROL_NAME,
    pass: !failed,
    code: failed ? failed.code : 'ON_CALL_READY',
    owner: manifest.owners?.checklist_owner ?? null,
    asOf: new Date(asOfMs).toISOString().slice(0, 10),
    checks,
    warnings: rotation.warnings,
    recovery:
      'Update the manifest only after a real handoff is recorded in the runbook; restore missing owners, runbook anchors, published pages, or navigation entries, then rerun the gate.',
    metrics: { ...ON_CALL_METRICS },
  };
}

export function evaluateRepositoryOnCallManifest(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manifestPath = resolve(repoRoot, options.manifest ?? DEFAULT_MANIFEST);
  if (!existsSync(manifestPath)) {
    return {
      control: CONTROL_NAME,
      pass: false,
      code: 'ON_CALL_MANIFEST_MISSING',
      owner: null,
      checks: [],
      warnings: [],
      recovery: 'Restore ops/on-call-checklist.json from version control and rerun the gate.',
      metrics: { ...ON_CALL_METRICS },
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      control: CONTROL_NAME,
      pass: false,
      code: 'ON_CALL_MANIFEST_MALFORMED',
      owner: null,
      checks: [],
      warnings: [],
      detail: error instanceof Error ? error.message : String(error),
      recovery: 'Repair the JSON syntax in ops/on-call-checklist.json and rerun the gate.',
      metrics: { ...ON_CALL_METRICS },
    };
  }
  return evaluateOnCallReadiness(manifest, { ...options, repoRoot });
}

function parseArgs(args) {
  const parsed = { manifest: DEFAULT_MANIFEST, repoRoot: null, asOf: null, report: null };
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].split('=', 2);
    if (flag === '--manifest') parsed.manifest = inline ?? args[++i];
    else if (flag === '--repo-root') parsed.repoRoot = inline ?? args[++i];
    else if (flag === '--as-of') parsed.asOf = inline ?? args[++i];
    else if (flag === '--report') parsed.report = inline ?? args[++i];
  }
  return parsed;
}

function main() {
  const args = parseArgs(argv.slice(2));
  const repoRoot = args.repoRoot ? resolve(args.repoRoot) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const asOfMs = args.asOf ? parseCalendarDate(args.asOf) : Date.now();
  const result =
    asOfMs === null
      ? {
          control: CONTROL_NAME,
          pass: false,
          code: 'ON_CALL_AS_OF_INVALID',
          checks: [],
          warnings: [],
          recovery: 'Pass --as-of=YYYY-MM-DD with a valid UTC calendar date.',
          metrics: { ...ON_CALL_METRICS },
        }
      : evaluateRepositoryOnCallManifest({ repoRoot, manifest: args.manifest, asOfMs });

  const payload = `${JSON.stringify(result, null, 2)}\n`;
  if (args.report) writeFileSync(args.report, payload);
  else stdout.write(payload);

  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        '### On-call escalation and handoff (#1329)',
        '',
        `| Result | Code | Owner | As of |`,
        `|---|---|---|---|`,
        `| ${result.pass ? '✅ pass' : '❌ fail'} | \`${result.code}\` | ${
          result.owner ?? 'unassigned'
        } | ${result.asOf ?? 'unknown'} |`,
        '',
        `Recovery: ${result.recovery}`,
        '',
      ].join('\n')
    );
  }

  if (!result.pass) {
    stdout.write(`On-call control failed: ${result.code}\n`);
    exit(1);
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(argv[1] || '').href;
if (invokedDirectly) main();
