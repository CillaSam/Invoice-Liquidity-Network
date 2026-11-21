#!/usr/bin/env node

/**
 * RFC implementation-status enforcement (issue #1533).
 *
 * An accepted RFC is a source of truth for the implementation. A status field
 * that nobody checks drifts: the RFC says "Accepted", the code moved on, and
 * the next reader cannot tell whether the gap is deliberate. This check makes
 * the declaration machine-readable and blocking:
 *
 *   - every RFC carries `Status`, `Implementation status`,
 *     `Implementation evidence`, and `Last verified`;
 *   - an accepted RFC may not be `not-applicable`, and every non-`not-applicable`
 *     status must name its evidence (PR, issue, or code path);
 *   - `implemented` and other implementation claims must have been re-verified
 *     within 180 days, so an old claim cannot silently stand in for code;
 *   - docs/rfc-process.md's index must list every RFC exactly once with the
 *     same status values as the RFC file.
 *
 * The check is intentionally dependency-free so it can run in the smallest CI
 * job and in a pre-commit hook.
 *
 * Usage:
 *   node scripts/check-rfc-status.mjs [--json[=report.json]] [--help]
 *
 * Exit codes: 0 when the repository is consistent, 1 on any error.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_ROOT = resolve(__dirname, '..');

export const RFC_STATUSES = [
  'draft',
  'open for comment',
  'final comment period',
  'accepted',
  'rejected',
];

export const IMPLEMENTATION_STATUSES = [
  'not-applicable',
  'not-started',
  'in-progress',
  'implemented',
  'deferred',
];

/** An `implemented` claim older than this must be re-verified. */
export const STALE_AFTER_DAYS = 180;

const FIELD_NAMES = ['Status', 'Implementation status', 'Last verified'];

function canonical(value) {
  return String(value ?? '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function headerBlock(content) {
  return content.split(/^---\s*$/m)[0] ?? '';
}

function field(header, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = header.match(new RegExp(`^-\\s*\\*\\*${escaped}:\\*\\*\\s*(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

/** Empty values and typographic placeholders mean "not supplied". */
function valueOrNull(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value === '—' || value === '-' || value === 'n/a' || value === 'N/A') {
    return null;
  }
  return value;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function daysSince(isoDate, today) {
  const then = new Date(`${isoDate}T00:00:00Z`).getTime();
  return Math.floor((today.getTime() - then) / 86_400_000);
}

/**
 * Parse one RFC file. Structural errors are recorded on the returned object;
 * `validateRfc` turns them into findings so callers can decide how to report.
 */
export function parseRfc(content, fileName = '') {
  const header = headerBlock(content);
  const titleMatch = content.match(/^#\s+RFC\s+(\d{4})\s+[—–-]\s+(.+)$/m);
  const fileNameNumber = (fileName.match(/^(\d{4})/) ?? [])[1] ?? null;

  return {
    fileName,
    number: titleMatch ? titleMatch[1] : fileNameNumber,
    title: titleMatch ? titleMatch[2].trim() : null,
    fileNameNumber,
    status: valueOrNull(field(header, 'Status')),
    implementationStatus: valueOrNull(field(header, 'Implementation status')),
    evidence: valueOrNull(field(header, 'Implementation evidence')),
    // The evidence field may legitimately hold `—` for not-applicable RFCs, so
    // record whether the line exists separately from whether it has a value.
    evidencePresent: /^-\s*\*\*Implementation evidence:\*\*/m.test(header),
    lastVerified: valueOrNull(field(header, 'Last verified')),
  };
}

/**
 * Validate one parsed RFC against the process rules. Returns findings shaped
 * as `{ code, message }`; an empty array means the RFC is consistent.
 *
 * `today` is injectable so tests are not tied to the wall clock.
 */
export function validateRfc(rfc, { today = new Date() } = {}) {
  const findings = [];
  const add = (code, message) => findings.push({ code, message });

  if (!rfc.title) {
    add('MISSING_TITLE', 'RFC must have a title in the form "# RFC 0000 — Title".');
  }
  if (!rfc.number) {
    add('MISSING_NUMBER', 'RFC must declare a four-digit number in its title or file name.');
  }
  if (rfc.number && rfc.fileNameNumber && rfc.number !== rfc.fileNameNumber) {
    add(
      'NUMBER_MISMATCH',
      `RFC title number ${rfc.number} does not match file name number ${rfc.fileNameNumber}.`
    );
  }

  for (const name of FIELD_NAMES) {
    const key =
      name === 'Status'
        ? 'status'
        : name === 'Implementation status'
          ? 'implementationStatus'
          : 'lastVerified';
    if (!rfc[key]) {
      add('MISSING_FIELD', `Missing required field "**${name}:**".`);
    }
  }
  if (!rfc.evidencePresent) {
    add('MISSING_FIELD', 'Missing required field "**Implementation evidence:**".');
  }

  const status = canonical(rfc.status);
  if (rfc.status && !RFC_STATUSES.includes(status)) {
    add('INVALID_STATUS', `Unknown RFC status "${rfc.status}".`);
  }

  const implementation = canonical(rfc.implementationStatus);
  if (rfc.implementationStatus && !IMPLEMENTATION_STATUSES.includes(implementation)) {
    add(
      'INVALID_IMPLEMENTATION_STATUS',
      `Unknown implementation status "${rfc.implementationStatus}" (expected one of ${IMPLEMENTATION_STATUSES.join(', ')}).`
    );
  }

  if (rfc.lastVerified && !isIsoDate(rfc.lastVerified)) {
    add('INVALID_LAST_VERIFIED', `"Last verified" must be a valid YYYY-MM-DD date.`);
  }

  if (status === 'accepted') {
    if (implementation === 'not-applicable') {
      add(
        'ACCEPTED_WITHOUT_IMPLEMENTATION_STATUS',
        'An accepted RFC must declare an implementation status.'
      );
    }
    if (!rfc.evidence) {
      add(
        'ACCEPTED_WITHOUT_EVIDENCE',
        'An accepted RFC must name its implementation evidence (PR, issue, or code path).'
      );
    }
  } else if (rfc.status && implementation !== 'not-applicable') {
    add(
      'IMPLEMENTATION_STATUS_ON_UNACCEPTED_RFC',
      'Only accepted RFCs may claim an implementation status; use not-applicable before acceptance.'
    );
  }

  if (implementation !== 'not-applicable' && implementation !== '' && !rfc.evidence) {
    add(
      'MISSING_EVIDENCE',
      `Implementation status "${rfc.implementationStatus}" requires "Implementation evidence".`
    );
  }

  if (
    rfc.lastVerified &&
    isIsoDate(rfc.lastVerified) &&
    implementation !== 'not-applicable' &&
    daysSince(rfc.lastVerified, today) > STALE_AFTER_DAYS
  ) {
    add(
      'STALE_VERIFICATION',
      `Implementation status was last verified on ${rfc.lastVerified}, more than ${STALE_AFTER_DAYS} days ago. Re-check the code and update the date.`
    );
  }

  return findings;
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function plainText(cell) {
  return cell
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .trim();
}

/**
 * Parse the RFC index table from docs/rfc-process.md.
 *
 * The table is identified by a "Number" column and an "Implementation status"
 * column, so other tables in the document are ignored.
 */
export function parseIndex(content) {
  const lines = content.split('\n');
  let headers = null;
  const rows = [];

  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      headers = null;
      continue;
    }
    const cells = splitRow(line);
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) {
      continue;
    }
    if (!headers) {
      headers = cells.map(canonical);
      continue;
    }
    const numberIndex = headers.indexOf('number');
    const implIndex = headers.indexOf('implementation status');
    if (numberIndex === -1 || implIndex === -1) {
      headers = null;
      continue;
    }
    const number = (cells[numberIndex].match(/(\d{4})/) ?? [])[1] ?? null;
    rows.push({
      number,
      title: plainText(cells[headers.indexOf('title')] ?? ''),
      status: plainText(cells[headers.indexOf('status')] ?? ''),
      implementationStatus: plainText(cells[implIndex] ?? ''),
      lastVerified: plainText(cells[headers.indexOf('last verified')] ?? ''),
    });
  }

  return rows;
}

/**
 * Cross-check the parsed index against the parsed RFC files.
 */
export function validateIndex(indexRows, rfcs) {
  const findings = [];
  const add = (code, message) => findings.push({ code, message });

  const byNumber = new Map();
  for (const rfc of rfcs) {
    if (!rfc.number) {
      continue;
    }
    if (byNumber.has(rfc.number)) {
      add('DUPLICATE_RFC_NUMBER', `RFC ${rfc.number} appears more than once in rfcs/.`);
      continue;
    }
    byNumber.set(rfc.number, rfc);
  }

  const indexed = new Map();
  for (const row of indexRows) {
    if (!row.number) {
      add('INDEX_ROW_WITHOUT_NUMBER', `RFC index row has no four-digit number: ${row.title || '(no title)'}.`);
      continue;
    }
    if (indexed.has(row.number)) {
      add('DUPLICATE_INDEX_ROW', `RFC ${row.number} appears more than once in the index.`);
      continue;
    }
    indexed.set(row.number, row);

    const rfc = byNumber.get(row.number);
    if (!rfc) {
      add('INDEX_ROW_WITHOUT_RFC', `RFC ${row.number} is indexed but rfcs/ has no matching file.`);
      continue;
    }

    const expected = {
      status: canonical(rfc.status),
      implementationStatus: canonical(rfc.implementationStatus),
      lastVerified: rfc.lastVerified ?? '',
    };
    if (canonical(row.status) !== expected.status) {
      add(
        'INDEX_STATUS_MISMATCH',
        `RFC ${row.number}: index status "${row.status}" does not match the RFC file "${rfc.status}".`
      );
    }
    if (canonical(row.implementationStatus) !== expected.implementationStatus) {
      add(
        'INDEX_IMPLEMENTATION_MISMATCH',
        `RFC ${row.number}: index implementation status "${row.implementationStatus}" does not match the RFC file "${rfc.implementationStatus}".`
      );
    }
    if (row.lastVerified !== expected.lastVerified) {
      add(
        'INDEX_LAST_VERIFIED_MISMATCH',
        `RFC ${row.number}: index last-verified "${row.lastVerified}" does not match the RFC file "${rfc.lastVerified}".`
      );
    }
  }

  for (const rfc of byNumber.values()) {
    if (!indexed.has(rfc.number)) {
      add('RFC_MISSING_FROM_INDEX', `RFC ${rfc.number} (${rfc.fileName}) is not listed in docs/rfc-process.md.`);
    }
  }

  return findings;
}

/**
 * Audit the repository: parse every RFC, validate it, and cross-check the index.
 * Returns `{ errors, rfcs, indexRows }`.
 */
export function auditRepository({ root = DEFAULT_ROOT, today = new Date() } = {}) {
  const rfcsDir = join(root, 'rfcs');
  const processDoc = join(root, 'docs', 'rfc-process.md');
  const errors = [];

  if (!existsSync(rfcsDir)) {
    return {
      errors: [{ code: 'MISSING_RFCS_DIR', message: `${rfcsDir} does not exist.` }],
      rfcs: [],
      indexRows: [],
    };
  }

  const files = readdirSync(rfcsDir)
    .filter((name) => /^\d{4}-.+\.md$/.test(name) && !name.startsWith('0000-'))
    .sort();

  const rfcs = files.map((name) => {
    const content = readFileSync(join(rfcsDir, name), 'utf8');
    const rfc = parseRfc(content, name);
    for (const finding of validateRfc(rfc, { today })) {
      errors.push({ ...finding, file: `rfcs/${name}` });
    }
    return rfc;
  });

  if (!existsSync(processDoc)) {
    errors.push({ code: 'MISSING_INDEX', message: 'docs/rfc-process.md does not exist.' });
    return { errors, rfcs, indexRows: [] };
  }

  const indexRows = parseIndex(readFileSync(processDoc, 'utf8'));
  for (const finding of validateIndex(indexRows, rfcs)) {
    errors.push({ ...finding, file: 'docs/rfc-process.md' });
  }

  return { errors, rfcs, indexRows };
}

function printHelp() {
  console.log(`Usage: node scripts/check-rfc-status.mjs [--json[=path]] [--help]

Checks every rfcs/*.md file and the RFC index in docs/rfc-process.md.
An accepted RFC must declare an implementation status and evidence, and a
non-not-applicable claim must have been verified within ${STALE_AFTER_DAYS} days.

Options:
  --json[=path]  Write the findings as JSON (to stdout or the given path).
  --help         Show this help.`);
}

function main(argv) {
  if (argv.includes('--help')) {
    printHelp();
    return 0;
  }

  const jsonArg = argv.find((arg) => arg === '--json' || arg.startsWith('--json='));
  const { errors, rfcs, indexRows } = auditRepository();

  if (jsonArg) {
    const report = {
      ok: errors.length === 0,
      checked: rfcs.length,
      indexed: indexRows.length,
      errors,
    };
    const payload = `${JSON.stringify(report, null, 2)}\n`;
    const target = jsonArg.includes('=') ? jsonArg.slice('--json='.length) : '';
    if (target) {
      writeFileSync(target, payload);
      console.log(`RFC status report written to ${target}`);
    } else {
      process.stdout.write(payload);
    }
    return errors.length === 0 ? 0 : 1;
  }

  if (errors.length === 0) {
    console.log(`RFC status OK: ${rfcs.length} RFC(s), all indexed and implementation statuses valid.`);
    return 0;
  }

  for (const error of errors) {
    const location = error.file ? `${error.file}: ` : '';
    console.error(`❌ ${location}${error.message}`);
  }
  console.error(`\n${errors.length} RFC status error(s). See docs/rfc-process.md for the rules.`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  process.exitCode = main(process.argv.slice(2));
}
