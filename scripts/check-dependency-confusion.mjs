#!/usr/bin/env node

/**
 * Dependency Confusion Detection Script
 *
 * This script audits the pnpm workspace for dependency confusion vulnerabilities
 * by checking for unexpected external resolutions of internal package names.
 *
 * Internal package names are discovered dynamically from pnpm-workspace.yaml
 * and each workspace member's package.json — not from a hardcoded list — so new
 * workspace packages are protected automatically.
 *
 * The script checks against all known public registries, not just npmjs.org,
 * to catch confusion attacks from GitHub Packages, Yarn, JFrog, Verdaccio,
 * and common mirror endpoints.
 *
 * Usage: node scripts/check-dependency-confusion.mjs
 *
 * Exports:
 *   parseWorkspacePatterns  — extract package-dir globs from pnpm-workspace.yaml
 *   expandGlobs             — resolve globs to concrete directory paths
 *   discoverWorkspacePackages — collect all package.json names from workspace dirs
 *   extractPackageSection   — extract the lockfile section for a given package
 *   checkLockfileForConfusion — scan lockfile content for confusion vulnerabilities
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';

// ── Known external registries beyond npmjs.org ──────────────────────────────

const EXTERNAL_REGISTRIES = [
  'registry.npmjs.org',
  'npm.pkg.github.com',
  'registry.yarnpkg.com',
  'npm.proxy.aliyuncs.com',
  'registry.npmmirror.com',
  'registry.npm.taobao.org',
  'npm.jfrog.io',
  'registry.verdaccio.org',
  'codeload.github.com',
  'npm.packages.nuxeo.com',
];

// Fallback scopes used only when dynamic discovery yields nothing.
const FALLBACK_SCOPES = ['@iln', '@invoice-liquidity'];

// ── Exported functions (testable without running the script) ────────────────

/**
 * Parse the `packages:` section of pnpm-workspace.yaml and return the list
 * of path/glob strings.
 *
 * The YAML format is simple: lines under `packages:` starting with `-`.
 */
export function parseWorkspacePatterns(workspaceYamlContent) {
  const lines = workspaceYamlContent.split('\n');
  let inPackagesSection = false;
  const patterns = [];

  for (const line of lines) {
    // A top-level key at indent 0 marks a new section
    if (/^\S/.test(line)) {
      inPackagesSection = line.startsWith('packages:');
      continue;
    }

    if (inPackagesSection) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-')) {
        // Extract the value after the dash, strip quotes
        let value = trimmed.replace(/^-\s*/, '').trim();
        value = value.replace(/^['"]|['"]$/g, '');
        if (value) patterns.push(value);
      }
    }
  }

  return patterns;
}

/**
 * Resolve a set of glob patterns (as used in pnpm-workspace.yaml) to concrete
 * directory paths relative to rootDir.
 *
 * Supports `*` wildcards (directory-level) and exact paths.
 */
export function expandGlobs(patterns, rootDir) {
  const dirs = [];

  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      // Exact path
      const dir = join(rootDir, pattern);
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        dirs.push(dir);
      }
      continue;
    }

    // Wildcard pattern — e.g. "packages/*"
    const parts = pattern.split('/');
    let currentDirs = [rootDir];

    for (const part of parts) {
      if (part === '*') {
        // Expand to all immediate subdirectories
        const nextDirs = [];
        for (const dir of currentDirs) {
          if (existsSync(dir)) {
            for (const entry of readdirSync(dir)) {
              const entryPath = join(dir, entry);
              if (statSync(entryPath).isDirectory()) {
                nextDirs.push(entryPath);
              }
            }
          }
        }
        currentDirs = nextDirs;
      } else {
        currentDirs = currentDirs.map((d) => join(d, part));
      }
    }

    for (const dir of currentDirs) {
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        dirs.push(dir);
      }
    }
  }

  return dirs;
}

/**
 * Discover all workspace package names by reading package.json from each
 * workspace member directory.
 *
 * Returns { names: string[], scopes: string[], unscoped: string[] }.
 */
export function discoverWorkspacePackages(rootDir) {
  const workspaceYamlPath = join(rootDir, 'pnpm-workspace.yaml');
  const patterns = [];

  if (existsSync(workspaceYamlPath)) {
    const content = readFileSync(workspaceYamlPath, 'utf-8');
    patterns.push(...parseWorkspacePatterns(content));
  }

  // Always include the root package itself
  const dirs = [rootDir, ...expandGlobs(patterns, rootDir)];

  const names = new Set();
  const scopes = new Set();
  const unscoped = [];

  for (const dir of dirs) {
    const pkgJsonPath = join(dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    } catch {
      continue;
    }

    const name = pkgJson.name;
    if (!name) continue;

    names.add(name);

    if (name.startsWith('@')) {
      // Scoped package — extract the scope
      const scope = name.substring(0, name.indexOf('/'));
      if (scope) scopes.add(scope);
    } else {
      unscoped.push(name);
    }
  }

  return {
    names: [...names].sort(),
    scopes: [...scopes].sort(),
    unscoped: [...unscoped].sort(),
  };
}

/**
 * Extract the section of lockfile pertaining to a specific package.
 *
 * Exported so tests can verify the parsing logic.
 */
export function extractPackageSection(lockfile, packageName) {
  const lines = lockfile.split('\n');
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  // Match both `pkgname:` (importers section) and `'pkgname@version':`
  // (packages section) formats in pnpm lockfiles
  const startPattern = new RegExp(`^\\s*['"]?${escapedName}(?:@[^'"]*)?['"]?:`);

  let startIndex = -1;
  let endIndex = -1;
  let baseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    if (startPattern.test(lines[i])) {
      startIndex = i;
      baseIndent = lines[i].search(/\S/);
      break;
    }
  }

  if (startIndex === -1) return null;

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    const indent = line.search(/\S/);
    if (indent <= baseIndent && indent >= 0) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) endIndex = lines.length;

  return lines.slice(startIndex, endIndex).join('\n');
}

/**
 * Check lockfile content for dependency confusion vulnerabilities.
 *
 * Returns { errors: [], warnings: [], checkedPackages: number }.
 */
export function checkLockfileForConfusion(lockfile, internalPackages) {
  const errors = [];
  const warnings = [];

  const { names, scopes, unscoped } = internalPackages;
  const effectiveScopes = scopes.length > 0 ? scopes : FALLBACK_SCOPES;

  // Check for external resolutions of scoped internal packages
  for (const scope of effectiveScopes) {
    const escapedScope = scope.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const scopePattern = new RegExp(`${escapedScope}\\/[^:\\s]+:`, 'g');
    const matches = lockfile.match(scopePattern) || [];

    for (const match of matches) {
      const pkgName = match.replace(/:$/, '');

      const pkgSection = extractPackageSection(lockfile, pkgName);
      if (!pkgSection) continue;

      // Skip if it's explicitly using workspace: or link: protocol
      if (pkgSection.includes('workspace:') || pkgSection.includes('link:')) {
        continue;
      }

      // Check if it's resolving to any external registry
      const resolvesExternal = EXTERNAL_REGISTRIES.some((reg) =>
        pkgSection.includes(reg)
      );

      // Also check for generic resolution: without workspace/link protocol
      const hasResolution = pkgSection.includes('resolution:');

      if (resolvesExternal || hasResolution) {
        const registryMatch = EXTERNAL_REGISTRIES.find((reg) =>
          pkgSection.includes(reg)
        );
        errors.push({
          package: pkgName,
          message: `Unexpected external resolution for internal scoped package: ${pkgName}` +
            (registryMatch ? ` (registry: ${registryMatch})` : ''),
          severity: 'HIGH',
        });
      }
    }
  }

  // Check for unscoped internal packages resolving externally
  for (const pkg of unscoped) {
    const pkgSection = extractPackageSection(lockfile, pkg);
    if (pkgSection && !pkgSection.includes('link:') && !pkgSection.includes('workspace:')) {
      // Check if it resolves to any known external registry
      const resolvesExternal = EXTERNAL_REGISTRIES.some((reg) =>
        pkgSection.includes(reg)
      );
      if (resolvesExternal) {
        errors.push({
          package: pkg,
          message: `Unscoped internal package ${pkg} resolved to external registry. This is a dependency confusion vulnerability.`,
          severity: 'HIGH',
        });
      } else {
        warnings.push({
          package: pkg,
          message: `Unscoped internal package ${pkg} is vulnerable to confusion attack. Consider scoping or publishing placeholder.`,
          severity: 'MEDIUM',
        });
      }
    }
  }

  // Check for internal package names (full names) that appear in dependency
  // sections but resolve externally — catches cases where a name doesn't match
  // any scope prefix but is still a workspace package
  for (const pkgName of names) {
    const pkgSection = extractPackageSection(lockfile, pkgName);
    if (!pkgSection) continue;

    if (pkgSection.includes('workspace:') || pkgSection.includes('link:')) {
      continue;
    }

    const resolvesExternal = EXTERNAL_REGISTRIES.some((reg) =>
      pkgSection.includes(reg)
    );

    if (resolvesExternal) {
      // Only report if not already caught by scope-based check
      const alreadyReported = errors.some((e) => e.package === pkgName);
      if (!alreadyReported) {
        errors.push({
          package: pkgName,
          message: `Internal package ${pkgName} resolved to external registry instead of workspace.`,
          severity: 'HIGH',
        });
      }
    }
  }

  return {
    errors,
    warnings,
    checkedPackages: effectiveScopes.length + unscoped.length + names.length,
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

function main() {
  console.log('🔍 Checking for dependency confusion vulnerabilities...\n');

  const rootDir = process.cwd();

  // Dynamically discover internal packages
  const internalPackages = discoverWorkspacePackages(rootDir);
  console.log(
    `   Discovered ${internalPackages.names.length} workspace packages ` +
    `(${internalPackages.scopes.length} scopes, ${internalPackages.unscoped.length} unscoped).`
  );

  if (internalPackages.names.length === 0) {
    console.warn('   ⚠️  No workspace packages found. Falling back to hardcoded scopes.\n');
  } else {
    console.log(`   Scopes: ${internalPackages.scopes.join(', ') || '(none)'}`);
    console.log(`   Unscoped: ${internalPackages.unscoped.join(', ') || '(none)'}\n`);
  }

  let lockfile;
  try {
    lockfile = readFileSync(join(rootDir, 'pnpm-lock.yaml'), 'utf-8');
  } catch (error) {
    console.error('❌ Error: Could not read pnpm-lock.yaml');
    console.error(error.message);
    process.exit(1);
  }

  const { errors, warnings, checkedPackages } = checkLockfileForConfusion(
    lockfile,
    internalPackages
  );

  // Report results
  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ No dependency confusion vulnerabilities detected.\n');
    console.log(`Checked ${checkedPackages} internal packages across ${EXTERNAL_REGISTRIES.length} known registries.`);
    process.exit(0);
  }

  if (errors.length > 0) {
    console.error('❌ CRITICAL: Dependency confusion vulnerabilities detected:\n');
    errors.forEach((err, idx) => {
      console.error(`  ${idx + 1}. [${err.severity}] ${err.message}`);
    });
    console.error('');
  }

  if (warnings.length > 0) {
    console.warn('⚠️  Warnings:\n');
    warnings.forEach((warn, idx) => {
      console.warn(`  ${idx + 1}. [${warn.severity}] ${warn.message}`);
    });
    console.warn('');
  }

  if (errors.length > 0) {
    console.error('Fix required: Remove external resolutions of internal packages from pnpm-lock.yaml');
    console.error('Run: pnpm install --frozen-lockfile to regenerate lockfile');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.warn('Warnings detected but not blocking. Review and address before mainnet.');
    process.exit(0);
  }
}

// Run only when executed directly, not when imported
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (isMain) {
  main();
}
