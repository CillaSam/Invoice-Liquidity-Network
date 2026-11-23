#!/usr/bin/env node
//
// Bundle-size budget checker.
//
// Reads sdk/.bundle-size.json and verifies that built bundles stay within
// their declared size limits. In addition to the basic over-budget check,
// the script now also detects:
//
//   • **Stale thresholds** — budgets whose actual file size is far below the
//     limit (less than 50 %), which may indicate the threshold was set too
//     high and never tightened.
//   • **Empty-budget guard** — fails when the config file exists but has no
//     budgets, so the script cannot silently pass without checking anything.
//   • **False-success guard** — fails when every budget file is missing,
//     preventing a "pass" when nothing was actually measured.
//
// Exports (for unit testing):
//   parseLimit       — convert "110 KB" → bytes
//   checkBudget      — check a single budget entry
//   detectStaleThresholds — flag budgets far below their limit
//   validateConfig   — validate the config structure (non-empty, parseable)

const fs = require('node:fs');
const path = require('node:path');

const STALE_RATIO = 0.5; // Warn when actual size < 50% of limit

// ── Exported functions (testable without running the script) ────────────────

/**
 * Parse a human-readable size limit (e.g. "110 KB") into bytes.
 */
function parseLimit(limit) {
  const match = limit.match(/^([\d.]+)\s*(KB|MB|B)$/i);
  if (!match) throw new Error(`Invalid limit format: ${limit}`);
  const value = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  switch (unit) {
    case 'B':
      return value;
    case 'KB':
      return value * 1024;
    case 'MB':
      return value * 1024 * 1024;
    default:
      return value;
  }
}

/**
 * Check a single budget entry.
 *
 * @param {Object} budget — { path, limit }
 * @param {string} sdkDir — base directory for resolving relative paths
 * @returns {{ status: 'ok'|'over'|'missing', path: string, sizeKB?: string,
 *            limitDisplay: string, message: string }}
 */
function checkBudget(budget, sdkDir) {
  const filePath = path.join(sdkDir, budget.path);
  const limit = parseLimit(budget.limit);
  const limitDisplay = budget.limit;

  if (!fs.existsSync(filePath)) {
    return {
      status: 'missing',
      path: budget.path,
      limitDisplay,
      message: `MISSING: ${budget.path}`,
    };
  }

  const stat = fs.statSync(filePath);
  const size = stat.size;
  const sizeKB = (size / 1024).toFixed(2);

  if (size > limit) {
    return {
      status: 'over',
      path: budget.path,
      sizeKB,
      limitDisplay,
      message: `OVER BUDGET: ${budget.path} is ${sizeKB} KB (limit: ${limitDisplay})`,
    };
  }

  return {
    status: 'ok',
    path: budget.path,
    sizeKB,
    limitDisplay,
    size,
    limit,
    message: `OK: ${budget.path} is ${sizeKB} KB (limit: ${limitDisplay})`,
  };
}

/**
 * Detect budgets whose actual file size is far below the declared limit.
 *
 * @param {Array<{ path: string, size?: number, limit: number }>} checked —
 *   results from checkBudget that had status 'ok'
 * @returns {Array<{ path: string, sizeKB: string, limitDisplay: string,
 *           ratio: number }>}
 */
function detectStaleThresholds(checked) {
  const stale = [];

  for (const result of checked) {
    if (result.size === undefined || result.limit === undefined) continue;
    const ratio = result.size / result.limit;
    if (ratio < STALE_RATIO) {
      stale.push({
        path: result.path,
        sizeKB: result.sizeKB,
        limitDisplay: result.limitDisplay,
        ratio: Math.round(ratio * 100) / 100,
      });
    }
  }

  return stale;
}

/**
 * Validate the config structure before processing.
 *
 * @param {Object} config — parsed JSON from .bundle-size.json
 * @returns {{ valid: boolean, error?: string }}
 */
function validateConfig(config) {
  if (!config) {
    return { valid: false, error: 'Config is null or undefined' };
  }

  if (!Array.isArray(config.budgets)) {
    return { valid: false, error: 'Config missing "budgets" array' };
  }

  if (config.budgets.length === 0) {
    return { valid: false, error: 'Config has empty budgets array — nothing to check' };
  }

  for (const budget of config.budgets) {
    if (!budget.path || typeof budget.path !== 'string') {
      return { valid: false, error: `Budget entry missing "path" string: ${JSON.stringify(budget)}` };
    }
    if (!budget.limit || typeof budget.limit !== 'string') {
      return { valid: false, error: `Budget entry missing "limit" string: ${JSON.stringify(budget)}` };
    }
    // Verify the limit is parseable
    try {
      parseLimit(budget.limit);
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  return { valid: true };
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  parseLimit,
  checkBudget,
  detectStaleThresholds,
  validateConfig,
  STALE_RATIO,
};

// ── Main entry point ─────────────────────────────────────────────────────────

if (require.main === module) {
  const configPath = path.join(__dirname, '..', 'sdk', '.bundle-size.json');
  const sdkDir = path.join(__dirname, '..', 'sdk');

  if (!fs.existsSync(configPath)) {
    console.error('Missing bundle-size config at sdk/.bundle-size.json');
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.error(`Failed to parse sdk/.bundle-size.json: ${e.message}`);
    process.exit(1);
  }

  // Validate config structure — catch empty or malformed configs before
  // silently passing with no actual checks.
  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error(`Invalid bundle-size config: ${validation.error}`);
    process.exit(1);
  }

  let hasFailures = false;
  let missingCount = 0;
  let okCount = 0;
  const okResults = [];

  for (const budget of config.budgets) {
    const result = checkBudget(budget, sdkDir);

    switch (result.status) {
      case 'missing':
        console.error(result.message);
        hasFailures = true;
        missingCount++;
        break;
      case 'over':
        console.error(result.message);
        hasFailures = true;
        break;
      case 'ok':
        console.log(result.message);
        okCount++;
        okResults.push(result);
        break;
    }
  }

  // ── Stale threshold detection ──────────────────────────────────────────────
  const stale = detectStaleThresholds(okResults);
  if (stale.length > 0) {
    console.log('\n📊 Stale thresholds (actual size far below limit):');
    stale.forEach((s) => {
      console.log(`  • ${s.path}: ${s.sizeKB} KB is ${Math.round(s.ratio * 100)}% of the ${s.limitDisplay} limit`);
    });
    console.log('  Consider tightening these thresholds to catch regressions earlier.');
  }

  // ── False-success guard ───────────────────────────────────────────────────
  //
  // If every budget file was missing, the check didn't measure anything.
  // Report a failure rather than letting the script pass because "no over-budget
  // files were found" — that would be a false success.
  if (missingCount === config.budgets.length && missingCount > 0) {
    console.error(
      '\n❌ All budget files are missing — run the SDK build before checking bundle sizes.'
    );
    process.exit(1);
  }

  // ── Empty-budget guard ──────────────────────────────────────────────────────
  //
  // validateConfig already catches empty budgets, but we also guard here in
  // case the config was modified after validation.
  if (okCount === 0 && missingCount === 0) {
    console.error('\n❌ No bundle-size budgets were checked. The config has no entries.');
    process.exit(1);
  }

  if (hasFailures) {
    console.error(
      '\nBundle size budget exceeded. If this increase is intentional, update sdk/.bundle-size.json.'
    );
    process.exit(1);
  }

  console.log('\nAll bundle sizes within budget.');
}
