#!/usr/bin/env node
// Task 1: Dependency License Checker Script
//
// Audits dependency licenses across the pnpm workspace against an allowlist
// and blocklist.  In addition to checking for violations, the script now also
// detects **stale allowlist entries** (licenses in the allowlist that no
// dependency actually uses) and **stale OWN_PACKAGES entries** (packages that
// no longer exist in the workspace), so the exemption list stays accurate as
// the monorepo evolves.
//
// Usage: node scripts/check-licenses.js
//
// Exports (for unit testing):
//   isSingleLicenseAllowed    — check a single license against allow/block list
//   isLicenseAllowed          — check a compound license expression
//   detectStaleAllowlist      — find allowlist entries never encountered
//   detectStaleOwnPackages    — find OWN_PACKAGES entries no longer in workspace
//   discoverWorkspacePackageNames — collect package.json names from workspace

const path = require('path');
const fs = require('node:fs');

const ALLOWLIST = [
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
]; // BlueOak is a highly permissive, MIT-like license
const BLOCKLIST = ['GPL', 'LGPL', 'AGPL', 'SSPL', 'Commons Clause'];
const OWN_PACKAGES = [
  'invoice-liquidity-network',
  '@iln/sdk',
  '@iln/sdk-next',
  '@invoice-liquidity/cli',
  'iln-indexer',
  'iln-notifications',
  '@iln/indexer',
];

// ── License evaluation (exported for testing) ────────────────────────────────

function isSingleLicenseAllowed(license) {
  const upperLicense = license.toUpperCase();

  // 1. Check blocklist first
  for (const blocked of BLOCKLIST) {
    const blockedUpper = blocked.toUpperCase();
    if (upperLicense.includes(blockedUpper)) {
      return false;
    }
  }

  // 2. Check allowlist
  for (const allowed of ALLOWLIST) {
    const allowedUpper = allowed.toUpperCase();
    if (
      upperLicense === allowedUpper ||
      upperLicense.startsWith(allowedUpper + '-') ||
      upperLicense.startsWith(allowedUpper + ' ') ||
      (allowedUpper.startsWith('BSD') && upperLicense.startsWith(allowedUpper))
    ) {
      return true;
    }
  }

  return false;
}

function isLicenseAllowed(licenseName) {
  if (!licenseName) return false;

  if (Array.isArray(licenseName)) {
    return licenseName.some((l) => isLicenseAllowed(l));
  }

  const cleanLicense = licenseName.trim().replace(/[*()]/g, '');

  if (cleanLicense.toUpperCase().includes(' OR ')) {
    const options = cleanLicense.split(/\s+OR\s+/i).map((o) => o.trim());
    return options.some((opt) => isSingleLicenseAllowed(opt));
  }

  const partsAnd = cleanLicense.split(/\s+AND\s+|[;,/]/i).map((p) => p.trim());
  return partsAnd.every((part) => isSingleLicenseAllowed(part));
}

// ── Stale-exemption detection (exported for testing) ────────────────────────

/**
 * Detect allowlist entries that no dependency actually uses.
 *
 * @param {string[]} allowlist — the ALLOWLIST array
 * @param {Set<string>} encounteredLicenses — upper-cased license names found
 *   during scanning (each individual component, not compound expressions)
 * @returns {string[]} stale entries (lower-cased as in the original allowlist)
 */
function detectStaleAllowlist(allowlist, encounteredLicenses) {
  return allowlist.filter((allowed) => {
    const upper = allowed.toUpperCase();
    // An allowlist entry is stale if no encountered license matches it.
    // We match by prefix to handle compound licenses like "MIT-0" matching "MIT".
    return ![...encounteredLicenses].some(
      (enc) =>
        enc === upper ||
        enc.startsWith(upper + '-') ||
        enc.startsWith(upper + ' ') ||
        (upper.startsWith('BSD') && enc.startsWith(upper))
    );
  });
}

/**
 * Detect OWN_PACKAGES entries that no longer correspond to a workspace package,
 * and workspace packages missing from OWN_PACKAGES.
 *
 * @param {string[]} ownPackages — the OWN_PACKAGES array
 * @param {string[]} workspacePackageNames — names discovered from package.json
 * @returns {{ stale: string[], missing: string[] }}
 *   stale: OWN_PACKAGES entries with no matching workspace package
 *   missing: workspace package names not in OWN_PACKAGES (excluding private
 *   packages without a publishable name)
 */
function detectStaleOwnPackages(ownPackages, workspacePackageNames) {
  const workspaceSet = new Set(workspacePackageNames);
  const ownSet = new Set(ownPackages);

  // Stale: in OWN_PACKAGES but not a workspace package
  const stale = ownPackages.filter((pkg) => !workspaceSet.has(pkg));

  // Missing: workspace package not in OWN_PACKAGES, but only if it has a
  // publishable name (private packages with no public name are skipped)
  const missing = workspacePackageNames.filter(
    (pkg) =>
      !ownSet.has(pkg) &&
      // Also check scope-based prefixes already covered by ownSet
      !ownPackages.some(
        (own) => pkg.startsWith(own.split('/')[0] + '/') || pkg === own
      )
  );

  return { stale, missing };
}

/**
 * Discover all workspace package names by parsing pnpm-workspace.yaml and
 * reading package.json from each member directory.
 */
function discoverWorkspacePackageNames(rootDir) {
  const workspaceYamlPath = path.join(rootDir, 'pnpm-workspace.yaml');
  const patterns = [];

  if (fs.existsSync(workspaceYamlPath)) {
    const content = fs.readFileSync(workspaceYamlPath, 'utf-8');
    patterns.push(...parseWorkspacePatterns(content));
  }

  // Always include root
  const dirs = [rootDir, ...expandGlobs(patterns, rootDir)];
  const names = new Set();

  for (const dir of dirs) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;

    let pkgJson;
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    } catch {
      continue;
    }

    if (pkgJson.name) {
      names.add(pkgJson.name);
    }
  }

  return [...names].sort();
}

/**
 * Parse the `packages:` section of pnpm-workspace.yaml.
 */
function parseWorkspacePatterns(content) {
  const lines = content.split('\n');
  let inPackages = false;
  const patterns = [];

  for (const line of lines) {
    if (/^\S/.test(line)) {
      inPackages = line.startsWith('packages:');
      continue;
    }
    if (inPackages) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-')) {
        let value = trimmed.replace(/^-\s*/, '').trim();
        value = value.replace(/^['"]|['"]$/g, '');
        if (value) patterns.push(value);
      }
    }
  }

  return patterns;
}

/**
 * Resolve pnpm-workspace glob patterns to concrete directory paths.
 */
function expandGlobs(patterns, rootDir) {
  const dirs = [];

  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      const dir = path.join(rootDir, pattern);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        dirs.push(dir);
      }
      continue;
    }

    const parts = pattern.split('/');
    let currentDirs = [rootDir];

    for (const part of parts) {
      if (part === '*') {
        const next = [];
        for (const dir of currentDirs) {
          if (fs.existsSync(dir)) {
            for (const entry of fs.readdirSync(dir)) {
              const entryPath = path.join(dir, entry);
              if (fs.statSync(entryPath).isDirectory()) {
                next.push(entryPath);
              }
            }
          }
        }
        currentDirs = next;
      } else {
        currentDirs = currentDirs.map((d) => path.join(d, part));
      }
    }

    for (const dir of currentDirs) {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        dirs.push(dir);
      }
    }
  }

  return dirs;
}

// ── Scanning ────────────────────────────────────────────────────────────────

// Packages to scan
const packagesToScan = [
  { name: 'Root', path: path.resolve(__dirname, '..') },
  { name: 'SDK', path: path.resolve(__dirname, '../sdk') },
  { name: 'CLI', path: path.resolve(__dirname, '../cli') },
  { name: 'Indexer', path: path.resolve(__dirname, '../indexer') },
  { name: 'Notifications', path: path.resolve(__dirname, '../notifications') },
  { name: 'Packages/Indexer', path: path.resolve(__dirname, '../packages/indexer') },
];

let totalViolations = 0;
const encounteredLicenses = new Set(); // upper-cased individual components

/**
 * Normalise a license expression into individual uppercase components
 * so we can track which allowlist entries are actually used.
 */
function trackEncounteredLicense(licenseName) {
  if (!licenseName) return;
  if (Array.isArray(licenseName)) {
    licenseName.forEach(trackEncounteredLicense);
    return;
  }
  const clean = licenseName.trim().replace(/[*()]/g, '');
  // Split on OR / AND / ; / , / /
  const parts = clean
    .split(/\s+OR\s+|\s+AND\s+|[;,/]/i)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  for (const part of parts) {
    encounteredLicenses.add(part);
  }
}

function checkPath(pkg) {
  return new Promise((resolve) => {
    console.log(`\n🔍 Auditing license compliance for ${pkg.name}...`);

    const checker = require('license-checker-rseidelsohn');
    checker.init(
      {
        start: pkg.path,
        production: true, // Only check production dependencies
        failOn: BLOCKLIST.join(';'), // Fail on blocklist
      },
      (err, packages) => {
        if (err) {
          // Sometimes license-checker returns an error if no packages found
          if (err.message && err.message.includes('No packages found')) {
            console.log(`✅ No production dependencies found in ${pkg.name}.`);
            return resolve();
          }
          console.error(`❌ Error scanning ${pkg.name}:`, err.message || err);
          totalViolations++;
          return resolve();
        }

        const violations = [];
        const checked = [];

        for (const [pkgNameVer, pkgInfo] of Object.entries(packages)) {
          const name = pkgNameVer.substring(0, pkgNameVer.lastIndexOf('@'));

          // Skip own monorepo packages
          if (
            OWN_PACKAGES.includes(name) ||
            name.startsWith('@invoice-liquidity/') ||
            name.startsWith('@iln/')
          ) {
            continue;
          }

          const licenses = pkgInfo.licenses;
          const isAllowed = isLicenseAllowed(licenses);

          // Track which licenses we encounter (for stale allowlist detection)
          trackEncounteredLicense(licenses);

          if (!isAllowed) {
            violations.push({
              package: pkgNameVer,
              license: licenses,
              repository: pkgInfo.repository || 'N/A',
            });
          } else {
            checked.push({ package: pkgNameVer, license: licenses });
          }
        }

        if (violations.length > 0) {
          console.error(`❌ Found ${violations.length} license violation(s) in ${pkg.name}:`);
          violations.forEach((v) => {
            console.error(`  - Package: ${v.package}`);
            console.error(`    License: ${v.license}`);
            console.error(`    Repo:    ${v.repository}`);
          });
          totalViolations += violations.length;
        } else {
          console.log(
            `✅ ${pkg.name} compliance check passed! Audited ${checked.length} packages.`
          );
        }
        resolve();
      }
    );
  });
}

async function run() {
  for (const pkg of packagesToScan) {
    await checkPath(pkg);
  }

  // ── Stale-allowlist audit ─────────────────────────────────────────────────
  const staleAllowlist = detectStaleAllowlist(ALLOWLIST, encounteredLicenses);
  if (staleAllowlist.length > 0) {
    console.log('\n📋 Stale allowlist entries (no dependency uses these licenses):');
    staleAllowlist.forEach((l) => console.log(`  • ${l}`));
    console.log('  These can be removed from ALLOWLIST to keep the list accurate.');
  }

  // ── Stale OWN_PACKAGES audit ──────────────────────────────────────────────
  const rootDir = path.resolve(__dirname, '..');
  const workspaceNames = discoverWorkspacePackageNames(rootDir);
  const { stale, missing } = detectStaleOwnPackages(OWN_PACKAGES, workspaceNames);

  if (stale.length > 0) {
    console.log('\n📋 Stale OWN_PACKAGES entries (no longer in workspace):');
    stale.forEach((p) => console.log(`  • ${p}`));
  }

  if (missing.length > 0) {
    console.log('\n⚠️  Workspace packages missing from OWN_PACKAGES:');
    missing.forEach((p) => console.log(`  • ${p}`));
    console.log('  These will be scanned as external dependencies. Add them to OWN_PACKAGES.');
  }

  // ── Final result ──────────────────────────────────────────────────────────
  console.log('\n======================================');
  if (totalViolations > 0) {
    console.error(`🚨 License audit failed with ${totalViolations} total violation(s).`);
    console.error('Please resolve the offending dependencies before releasing.');
    console.log('======================================');
    process.exit(1);
  } else {
    console.log('🎉 All packages passed license compliance checks!');
    console.log('======================================');
    process.exit(0);
  }
}

// ── Exports for testing ─────────────────────────────────────────────────────

module.exports = {
  isSingleLicenseAllowed,
  isLicenseAllowed,
  detectStaleAllowlist,
  detectStaleOwnPackages,
  discoverWorkspacePackageNames,
  parseWorkspacePatterns,
  expandGlobs,
  ALLOWLIST,
  BLOCKLIST,
  OWN_PACKAGES,
};

// Run only when executed directly, not when required
if (require.main === module) {
  run().catch((err) => {
    console.error('Unexpected error running license check:', err);
    process.exit(1);
  });
}
