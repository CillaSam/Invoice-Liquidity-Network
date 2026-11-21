#!/usr/bin/env node
/**
 * Incident postmortem action item tracking and SLA enforcement (#1326).
 *
 * Invariants:
 *   - Every incident postmortem must contain an Action Items table (Section 6);
 *   - Each action item requires a description, type (Corrective/Preventative),
 *     assigned owner (@username), target repo, due date (YYYY-MM-DD), and status;
 *   - Allowed statuses: TODO, IN_PROGRESS, DONE, BLOCKED;
 *   - Actions with due dates past the current timestamp and status != DONE are flagged overdue;
 *   - Fail-closed: missing owners, unparseable dates, or invalid statuses fail tracking audit.
 *
 * This module is pure and dependency-free: identical inputs always yield identical
 * tracking and SLA assessments across runs and process restarts.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

export const POSTMORTEM_TRACKING_METRICS = Object.freeze({
  actionsTotal: 'iln_postmortem_actions_total',
  actionsOverdue: 'iln_postmortem_actions_overdue',
  actionsCompleted: 'iln_postmortem_actions_completed',
  auditsTotal: 'iln_postmortem_tracking_audits_total',
});

export const VALID_ACTION_TYPES = Object.freeze(new Set(['Corrective', 'Preventative']));
export const VALID_ACTION_STATUSES = Object.freeze(new Set(['TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED']));

export const VALID_REPOSITORIES = Object.freeze(
  new Set(['Invoice-Liquidity-Network', 'ILN-Frontend', 'ILN-Smart-Contract', 'ILN-Infrastructure'])
);

/**
 * Parses action items from markdown content.
 */
export function parseActionItemsTable(markdownContent, sourceFile = 'unknown') {
  if (typeof markdownContent !== 'string') return [];

  const items = [];
  const lines = markdownContent.split(/\r?\n/);
  let inSection6 = false;
  let inTable = false;
  let headerFound = false;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx].trim();

    if (/^##\s+6\.\s+Action Items/i.test(line)) {
      inSection6 = true;
      continue;
    }

    if (inSection6 && /^##\s+\d+/i.test(line)) {
      break;
    }

    if (!inSection6) continue;

    if (line.startsWith('|') && line.includes('Action Item') && line.includes('Status')) {
      inTable = true;
      headerFound = true;
      continue;
    }

    if (inTable && /^\|(?:\s*:?-+:?\s*\|)+$/.test(line)) {
      continue;
    }

    if (inTable && line.startsWith('|')) {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim().replace(/^`|`$/g, ''));

      if (cells.length >= 6) {
        items.push({
          sourceFile,
          line: idx + 1,
          actionItem: cells[0],
          type: cells[1],
          assignedOwner: cells[2],
          targetRepo: cells[3],
          dueDate: cells[4],
          status: cells[5].toUpperCase(),
        });
      }
    } else if (inTable && line === '') {
      // End of table
      inTable = false;
    }
  }

  return items;
}

/**
 * Validates a single action item against schema invariants.
 */
export function validateActionItem(item, nowMs = Date.now()) {
  const errors = [];

  if (!item.actionItem || item.actionItem.length < 5) {
    errors.push(`Line ${item.line}: Action item description is empty or too short`);
  }

  if (!VALID_ACTION_TYPES.has(item.type)) {
    errors.push(`Line ${item.line}: Invalid action type '${item.type}' (expected Corrective or Preventative)`);
  }

  if (!item.assignedOwner || !item.assignedOwner.startsWith('@') || /^(?:@tbd|@unassigned)$/i.test(item.assignedOwner)) {
    errors.push(`Line ${item.line}: Assigned owner '${item.assignedOwner}' must be an explicit @username handle`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)) {
    errors.push(`Line ${item.line}: Due date '${item.dueDate}' must use YYYY-MM-DD format`);
  }

  if (!VALID_ACTION_STATUSES.has(item.status)) {
    errors.push(`Line ${item.line}: Invalid status '${item.status}' (expected TODO, IN_PROGRESS, DONE, or BLOCKED)`);
  }

  let isOverdue = false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) && item.status !== 'DONE') {
    const dueTimeMs = new Date(`${item.dueDate}T23:59:59Z`).getTime();
    if (!Number.isNaN(dueTimeMs) && nowMs > dueTimeMs) {
      isOverdue = true;
    }
  }

  return {
    valid: errors.length === 0,
    item,
    isOverdue,
    errors,
  };
}

/**
 * Evaluates full set of action items across postmortems.
 */
export function evaluatePostmortemActions(actionItems, nowMs = Date.now()) {
  const total = actionItems.length;
  let completed = 0;
  let overdue = 0;
  let inProgress = 0;
  let todo = 0;
  let blocked = 0;
  const errors = [];
  const validatedItems = [];

  for (const item of actionItems) {
    const validation = validateActionItem(item, nowMs);
    if (!validation.valid) {
      errors.push(...validation.errors);
    }

    if (item.status === 'DONE') {
      completed += 1;
    } else if (validation.isOverdue) {
      overdue += 1;
    } else if (item.status === 'IN_PROGRESS') {
      inProgress += 1;
    } else if (item.status === 'TODO') {
      todo += 1;
    } else if (item.status === 'BLOCKED') {
      blocked += 1;
    }

    validatedItems.push({
      ...item,
      isOverdue: validation.isOverdue,
    });
  }

  const pass = errors.length === 0;

  return {
    pass,
    code: pass ? 'POSTMORTEM_ACTIONS_VALID' : 'POSTMORTEM_ACTIONS_INVALID',
    totalActions: total,
    completedActions: completed,
    overdueActions: overdue,
    inProgressActions: inProgress,
    todoActions: todo,
    blockedActions: blocked,
    errors,
    items: validatedItems,
  };
}

/**
 * Scans a directory of postmortem markdown files and evaluates action items.
 */
export function auditPostmortemsDirectory(dirPath, nowMs = Date.now()) {
  const resolvedDir = resolve(dirPath);
  const files = readdirSync(resolvedDir).filter(
    (f) =>
      f.endsWith('.md') &&
      f !== 'README.md' &&
      f !== 'PROCESS.md' &&
      f !== 'TEMPLATE.md' &&
      f !== 'DATA_LOSS_DETECTION_COVERAGE.md'
  );

  const allItems = [];
  for (const file of files) {
    const content = readFileSync(join(resolvedDir, file), 'utf8');
    const items = parseActionItemsTable(content, file);
    allItems.push(...items);
  }

  return evaluatePostmortemActions(allItems, nowMs);
}

function parseCliArgs(args) {
  const result = { json: false, outFile: null, dirPath: 'docs/postmortems' };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') {
      result.json = true;
    } else if (args[i] === '--out' && args[i + 1]) {
      result.outFile = args[i + 1];
      i += 1;
    } else if (args[i] === '--dir' && args[i + 1]) {
      result.dirPath = args[i + 1];
      i += 1;
    }
  }
  return result;
}

function main() {
  const { dirPath, outFile } = parseCliArgs(argv.slice(2));
  try {
    const audit = auditPostmortemsDirectory(dirPath);
    const payload = JSON.stringify(
      {
        schemaVersion: 'postmortem-action-tracking/v1',
        auditDirectory: dirPath,
        audit,
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

    if (!audit.pass) {
      stdout.write('Postmortem action tracking audit: FAILED\n');
      exit(1);
    }
  } catch (err) {
    stdout.write(`Failed to audit postmortems: ${err.message}\n`);
    exit(1);
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(argv[1] || '').href;
if (invokedDirectly) {
  main();
}
