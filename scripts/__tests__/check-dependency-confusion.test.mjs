import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkspacePatterns,
  expandGlobs,
  discoverWorkspacePackages,
  extractPackageSection,
  checkLockfileForConfusion,
} from '../check-dependency-confusion.mjs';

// ── Sample data ─────────────────────────────────────────────────────────────

const SAMPLE_WORKSPACE_YAML = `# pnpm-workspace.yaml
packages:
  - sdk
  - cli
  - 'packages/*'
  - 'examples/*'
`;

const SAMPLE_LOCKFILE_CLEAN = `lockfileVersion: '6.0'

importers:
  .:
    dependencies:
      '@iln/sdk':
        specifier: workspace:*
        version: link:../sdk

packages:

  '@iln/sdk@workspace:..':
    resolution: {link: '../sdk'}
    id: '1.0.0'
`;

const SAMPLE_LOCKFILE_CONFUSED = `lockfileVersion: '6.0'

importers:
  .:
    dependencies:
      '@iln/sdk':
        specifier: workspace:*
        version: 1.0.0

packages:

  '@iln/sdk@npm://registry.npmjs.org/@iln/sdk/-/sdk-1.0.0.tgz':
    resolution: {tarball: https://registry.npmjs.org/@iln/sdk/-/sdk-1.0.0.tgz}
    id: '1.0.0'
`;

const SAMPLE_LOCKFILE_GITHUB = `lockfileVersion: '6.0'

importers:
  .:
    dependencies:
      '@iln/shared':
        specifier: workspace:*
        version: 1.0.0

packages:

  '@iln/shared@npm://npm.pkg.github.com/@iln/shared/-/shared-1.0.0.tgz':
    resolution: {tarball: https://npm.pkg.github.com/@iln/shared/-/shared-1.0.0.tgz}
    id: '1.0.0'
`;

// ── parseWorkspacePatterns ──────────────────────────────────────────────────

describe('parseWorkspacePatterns', () => {
  it('extracts path/glob entries from pnpm-workspace.yaml', () => {
    const patterns = parseWorkspacePatterns(SAMPLE_WORKSPACE_YAML);
    assert.deepEqual(patterns, ['sdk', 'cli', 'packages/*', 'examples/*']);
  });

  it('returns empty array when no packages section', () => {
    assert.deepEqual(parseWorkspacePatterns('# just a comment\nfoo: bar\n'), []);
  });

  it('handles quoted entries', () => {
    const yaml = "packages:\n  - 'sdk'\n  - \"cli\"\n  - packages/*\n";
    assert.deepEqual(parseWorkspacePatterns(yaml), ['sdk', 'cli', 'packages/*']);
  });

  it('ignores comment-only lines within packages section', () => {
    const yaml = "packages:\n  # this is a comment\n  - sdk\n  # another comment\n  - cli\n";
    assert.deepEqual(parseWorkspacePatterns(yaml), ['sdk', 'cli']);
  });
});

// ── extractPackageSection ───────────────────────────────────────────────────

describe('extractPackageSection', () => {
  it('extracts a package section from the lockfile', () => {
    const lockfile = `packages:\n\n  '@iln/sdk@workspace:..':\n    resolution: {link: '../sdk'}\n    id: '1.0.0'\n\n  'other-pkg@1.0.0':\n    resolution: {tarball: https://example.com}\n`;
    const section = extractPackageSection(lockfile, '@iln/sdk@workspace:..');
    assert.ok(section);
    assert.ok(section.includes('resolution'));
    assert.ok(section.includes("link: '../sdk'"));
  });

  it('returns null when the package is not found', () => {
    assert.equal(extractPackageSection(SAMPLE_LOCKFILE_CLEAN, '@nonexistent/pkg'), null);
  });
});

// ── checkLockfileForConfusion ───────────────────────────────────────────────

describe('checkLockfileForConfusion', () => {
  const internalPackages = {
    names: ['@iln/sdk', '@iln/shared'],
    scopes: ['@iln'],
    unscoped: [],
  };

  it('reports no errors when internal packages resolve via workspace:', () => {
    const { errors, warnings } = checkLockfileForConfusion(
      SAMPLE_LOCKFILE_CLEAN,
      internalPackages
    );
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  });

  it('detects dependency confusion when an internal package resolves to npmjs.org', () => {
    const { errors } = checkLockfileForConfusion(
      SAMPLE_LOCKFILE_CONFUSED,
      internalPackages
    );
    assert.ok(errors.length > 0, 'expected at least one error');
    assert.ok(errors.some((e) => e.package.includes('@iln/sdk')), 'error should reference @iln/sdk');
    assert.ok(errors.every((e) => e.severity === 'HIGH'));
  });

  it('detects dependency confusion via GitHub Packages registry', () => {
    const { errors } = checkLockfileForConfusion(
      SAMPLE_LOCKFILE_GITHUB,
      internalPackages
    );
    assert.ok(errors.length > 0, 'expected at least one error for GitHub Packages');
    assert.ok(
      errors.some((e) => e.message.includes('npm.pkg.github.com')),
      'error should mention GitHub Packages registry'
    );
  });

  it('warns about unscoped internal packages without external resolution', () => {
    const lockfile = `packages:\n\n  'iln-indexer@file:..':\n    resolution: {link: '../indexer'}\n`;
    const packages = {
      names: ['iln-indexer'],
      scopes: [],
      unscoped: ['iln-indexer'],
    };
    const { warnings } = checkLockfileForConfusion(lockfile, packages);
    // iln-indexer resolves via link: so no warning
    assert.equal(warnings.length, 0);
  });

  it('errors when an unscoped internal package resolves to an external registry', () => {
    const lockfile = `packages:\n\n  'iln-indexer@1.0.0':\n    resolution: {tarball: https://registry.npmjs.org/iln-indexer/-/iln-indexer-1.0.0.tgz}\n`;
    const packages = {
      names: ['iln-indexer'],
      scopes: [],
      unscoped: ['iln-indexer'],
    };
    const { errors } = checkLockfileForConfusion(lockfile, packages);
    assert.ok(errors.length > 0, 'expected an error for unscoped package on external registry');
    assert.ok(errors.some((e) => e.severity === 'HIGH'));
  });

  it('falls back to hardcoded scopes when no scopes are discovered', () => {
    const lockfile = `packages:\n\n  '@iln/sdk@1.0.0':\n    resolution: {tarball: https://registry.npmjs.org/@iln/sdk/-/sdk-1.0.0.tgz}\n`;
    const packages = {
      names: [],
      scopes: [],
      unscoped: [],
    };
    const { errors } = checkLockfileForConfusion(lockfile, packages);
    assert.ok(errors.length > 0, 'fallback scopes should still detect confusion');
  });
});

// ── expandGlobs ─────────────────────────────────────────────────────────────

describe('expandGlobs', () => {
  it('resolves exact paths', () => {
    const dirs = expandGlobs(['scripts'], process.cwd());
    assert.ok(dirs.some((d) => d.endsWith('/scripts')));
  });

  it('resolves wildcard patterns', () => {
    const dirs = expandGlobs(['packages/*'], process.cwd());
    assert.ok(dirs.length > 0, 'packages/* should expand to at least one directory');
    assert.ok(dirs.some((d) => d.includes('shared')), 'should include packages/shared');
  });

  it('returns empty for non-existent paths', () => {
    assert.deepEqual(expandGlobs(['nonexistent'], process.cwd()), []);
  });
});
