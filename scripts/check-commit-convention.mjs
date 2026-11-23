#!/usr/bin/env node
/**
 * Consistency validator for the commit / PR-title convention (#959).
 *
 * `commitlint.config.js` is loaded by two independent enforcement points:
 * the `commit-msg` Husky hook and `.github/workflows/pr-title-lint.yml`.
 * A rule that one applies and the other does not would surprise
 * contributors, and a documented example that the linter rejects is worse.
 *
 * This script asserts that:
 *   1. both enforcement points pass `--config commitlint.config.js`
 *   2. a sample valid subject is accepted by the resolved config
 *   3. a sample invalid subject is rejected by the resolved config
 *   4. the type list documented in CONTRIBUTING.md matches `type-enum`
 *   5. release-automation commits (e.g. `chore(release): 1.2.3`) are accepted
 *   6. merge commits are handled with a documented, explicit decision
 *   7. revert commits are handled with a documented, explicit decision
 *   8. multi-line messages with a body are handled correctly
 *
 * Usage:
 *   node scripts/check-commit-convention.mjs
 *
 * Exports (for unit testing):
 *   loadConfig           — load and return commitlint.config.js
 *   checkEnforcementPoints — verify both enforcement points reference the config
 *   checkContributingTypes — verify CONTRIBUTING.md documents all configured types
 *   lint                 — run commitlint on a message (requires commitlint installed)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Exported functions (testable without running the script) ────────────────

/**
 * Load commitlint.config.js from the given root directory.
 */
export function loadConfig(root) {
  const require = createRequire(import.meta.url);
  return require(join(root, 'commitlint.config.js'));
}

/**
 * Check that both enforcement points reference the config explicitly.
 * Returns { passed: string[], failed: string[] }.
 */
export function checkEnforcementPoints(root) {
  const enforcementPoints = [
    ['.husky/commit-msg', join(root, '.husky/commit-msg')],
    ['.github/workflows/pr-title-lint.yml', join(root, '.github/workflows/pr-title-lint.yml')],
  ];

  const passed = [];
  const failed = [];

  for (const [label, path] of enforcementPoints) {
    const contents = readFileSync(path, 'utf8');
    if (contents.includes('--config commitlint.config.js')) {
      passed.push(`${label} passes commitlint.config.js explicitly`);
    } else {
      failed.push(`${label} does not pass --config commitlint.config.js (relies on auto-discovery)`);
    }
  }

  return { passed, failed };
}

/**
 * Check that CONTRIBUTING.md documents all configured types and references
 * the config file.
 * Returns { passed: string[], failed: string[] }.
 */
export function checkContributingTypes(root, config) {
  const passed = [];
  const failed = [];

  const documented = config.rules['type-enum'][2].filter((type) => type !== 'always');
  const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');

  const undocumented = documented.filter((type) => !contributing.includes(`\`${type}\``));
  if (undocumented.length === 0) {
    passed.push(`CONTRIBUTING.md documents all ${documented.length} configured types`);
  } else {
    failed.push(`CONTRIBUTING.md does not document: ${undocumented.join(', ')}`);
  }

  if (!contributing.includes('commitlint.config.js')) {
    failed.push('CONTRIBUTING.md does not point at commitlint.config.js');
  } else {
    passed.push('CONTRIBUTING.md points at commitlint.config.js');
  }

  return { passed, failed };
}

/**
 * Run commitlint on a message and return true if accepted, false if rejected.
 * Requires commitlint to be installed in the project.
 */
export function lint(message, root) {
  try {
    execFileSync('npx', ['--no', '--', 'commitlint', '--config', 'commitlint.config.js'], {
      input: `${message}\n`,
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────

const root = join(__dirname, '..');
const config = loadConfig(root);
const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}

function pass(msg) {
  console.log(`✅ ${msg}`);
}

function note(msg) {
  notes.push(msg);
  console.log(`ℹ️  ${msg}`);
}

// ── 1. Both enforcement points reference the same config explicitly ──────────

{
  const { passed, failed } = checkEnforcementPoints(root);
  passed.forEach(pass);
  failed.forEach(fail);
}

// ── 2 & 3. The resolved config accepts and rejects the right subjects ─────────

const validSubject = 'fix(indexer): retry Horizon cursor on 429';
if (lint(validSubject, root)) {
  pass(`accepted a valid subject: ${validSubject}`);
} else {
  fail(`rejected a valid subject: ${validSubject}`);
}

const invalidSubject = 'security: add gitleaks pre-commit hook via Husky';
if (!lint(invalidSubject, root)) {
  pass(`rejected an invalid subject: ${invalidSubject}`);
} else {
  fail(`accepted an invalid subject: ${invalidSubject} (type-enum not enforced?)`);
}

// ── 4. CONTRIBUTING.md documents exactly the configured types ────────────────

{
  const { passed, failed } = checkContributingTypes(root, config);
  passed.forEach(pass);
  failed.forEach(fail);
}

// ── 5. Release-automation commits are accepted ───────────────────────────────
//
// Changesets or similar tools produce commits like "chore(release): 1.2.3".
// These must be accepted because `chore` is in type-enum and the scope
// `release` is valid.

const releaseCommit = 'chore(release): 1.2.3';
if (lint(releaseCommit, root)) {
  pass(`accepted release-automation commit: ${releaseCommit}`);
} else {
  fail(`rejected release-automation commit: ${releaseCommit} (would break release workflows)`);
}

// ── 6. Merge commits ─────────────────────────────────────────────────────────
//
// A regular (non-squash) merge commit has a subject like
// "Merge pull request #123 from org/branch". The conventional-commit type-enum
// rule rejects this because "Merge" is not a valid type. This repo uses
// squash-merge (the PR title becomes the commit subject), so merge commits
// from forks or manual merges are expected to be rare. We document this as a
// known edge case: the Husky hook will reject non-squash merge commits, which
// is intentional for this repo's workflow.

const mergeCommit = 'Merge pull request #123 from Invoice-Liquidity-Network/feature-branch';
const mergeAccepted = lint(mergeCommit, root);
if (!mergeAccepted) {
  pass(`rejected non-squash merge commit: "${mergeCommit}" (expected for squash-merge workflow)`);
} else {
  note(`accepted merge commit: "${mergeCommit}" — merge commits are not blocked by type-enum`);
}

// ── 7. Revert commits ────────────────────────────────────────────────────────
//
// The conventional-commits spec defines a `revert` type for revert commits.
// It is NOT in this repo's type-enum, so revert commits created by
// `git revert --no-edit` (which produce "Revert "feat(sdk): ..."") or
// manual `revert: ...` messages will be rejected.
//
// This is a documented decision: contributors should use `fix` or `refactor`
// with a scope and mention the reverted commit in the body instead.

const revertCommit = 'revert: feat(sdk): add Freighter network mismatch guard';
const revertAccepted = lint(revertCommit, root);
if (!revertAccepted) {
  pass(`rejected revert commit: "${revertCommit}" (revert not in type-enum; use fix/refactor)`);
} else {
  note(`accepted revert commit: "${revertCommit}" — revert type is available`);
}

// Also test git's auto-generated revert format
const gitRevertFormat = 'Revert "feat(sdk): add Freighter network mismatch guard"\n\nThis reverts commit abc123.';
const gitRevertAccepted = lint(gitRevertFormat, root);
if (!gitRevertAccepted) {
  pass(`rejected git-auto revert format: "Revert ..." (expected; not conventional-commit type)`);
} else {
  note(`accepted git-auto revert format`);
}

// ── 8. Multi-line messages with body are handled ────────────────────────────
//
// Commitlint validates the header (first line) and optionally the body.
// A valid header with a body should be accepted.

const multilineMessage = 'fix(sdk): handle Freighter network mismatch\n\nWhen the user switches networks in Freighter, the SDK previously continued with the old network. This adds a guard that throws on mismatch.\n\nCloses #959.';
if (lint(multilineMessage, root)) {
  pass(`accepted multi-line message with body (header + body + footer)`);
} else {
  fail(`rejected multi-line message with body — check header-length or body-max-line-length rules`);
}

// ── 9. Empty message is rejected ─────────────────────────────────────────────

const emptyMessage = '';
if (!lint(emptyMessage, root)) {
  pass(`rejected empty commit message`);
} else {
  fail(`accepted empty commit message — should always be rejected`);
}

// ── Report ───────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error('');
  for (const failure of failures) {
    console.error(`❌ ${failure}`);
  }
  console.error('\n✗ Commit / PR-title convention is inconsistent.');
  process.exit(1);
}

console.log('');
console.log('✅ Commit and PR-title lint rules are consistent');
