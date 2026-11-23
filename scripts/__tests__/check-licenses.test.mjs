import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isSingleLicenseAllowed,
  isLicenseAllowed,
  detectStaleAllowlist,
  detectStaleOwnPackages,
  discoverWorkspacePackageNames,
  parseWorkspacePatterns,
  ALLOWLIST,
  BLOCKLIST,
  OWN_PACKAGES,
} = require('../check-licenses.js');

// ── isSingleLicenseAllowed ──────────────────────────────────────────────────

describe('isSingleLicenseAllowed', () => {
  it('accepts permissive licenses in the allowlist', () => {
    assert.equal(isSingleLicenseAllowed('MIT'), true);
    assert.equal(isSingleLicenseAllowed('Apache-2.0'), true);
    assert.equal(isSingleLicenseAllowed('ISC'), true);
    assert.equal(isSingleLicenseAllowed('BSD-3-Clause'), true);
    assert.equal(isSingleLicenseAllowed('0BSD'), true);
    assert.equal(isSingleLicenseAllowed('BlueOak-1.0.0'), true);
  });

  it('rejects copyleft licenses in the blocklist', () => {
    assert.equal(isSingleLicenseAllowed('GPL-3.0'), false);
    assert.equal(isSingleLicenseAllowed('LGPL-2.1'), false);
    assert.equal(isSingleLicenseAllowed('AGPL-3.0'), false);
    assert.equal(isSingleLicenseAllowed('SSPL-1.0'), false);
    assert.equal(isSingleLicenseAllowed('Commons Clause'), false);
  });

  it('rejects unknown licenses not in any list', () => {
    assert.equal(isSingleLicenseAllowed('WTFPL'), false);
    assert.equal(isSingleLicenseAllowed('UNLICENSED'), false);
    assert.equal(isSingleLicenseAllowed(''), false);
  });

  it('is case-insensitive', () => {
    assert.equal(isSingleLicenseAllowed('mit'), true);
    assert.equal(isSingleLicenseAllowed('apache-2.0'), true);
    assert.equal(isSingleLicenseAllowed('gpl-3.0'), false);
  });

  it('matches BSD variants by prefix', () => {
    assert.equal(isSingleLicenseAllowed('BSD-2-Clause'), true);
    assert.equal(isSingleLicenseAllowed('BSD-3-Clause'), true);
    assert.equal(isSingleLicenseAllowed('BSD-3-Clause-No-Nuclear-License'), true);
  });
});

// ── isLicenseAllowed ─────────────────────────────────────────────────────────

describe('isLicenseAllowed', () => {
  it('handles compound OR expressions (any part allowed → allowed)', () => {
    assert.equal(isLicenseAllowed('MIT OR Apache-2.0'), true);
    assert.equal(isLicenseAllowed('GPL-3.0 OR MIT'), true);
  });

  it('handles compound AND expressions (all parts must be allowed)', () => {
    assert.equal(isLicenseAllowed('MIT AND Apache-2.0'), true);
    assert.equal(isLicenseAllowed('MIT AND GPL-3.0'), false);
  });

  it('rejects null/undefined/empty', () => {
    assert.equal(isLicenseAllowed(null), false);
    assert.equal(isLicenseAllowed(undefined), false);
    assert.equal(isLicenseAllowed(''), false);
  });

  it('handles array of license names', () => {
    assert.equal(isLicenseAllowed(['MIT', 'Apache-2.0']), true);
    assert.equal(isLicenseAllowed(['GPL-3.0', 'MIT']), true);
    assert.equal(isLicenseAllowed(['GPL-3.0', 'AGPL-3.0']), false);
  });

  it('strips parentheses and asterisks', () => {
    assert.equal(isLicenseAllowed('(MIT)'), true);
    assert.equal(isLicenseAllowed('MIT*'), true);
  });
});

// ── detectStaleAllowlist ─────────────────────────────────────────────────────

describe('detectStaleAllowlist', () => {
  it('returns empty when every allowlist entry is encountered', () => {
    const encountered = new Set(['MIT', 'APACHE-2.0', 'ISC', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', '0BSD', 'BLUEOAK-1.0.0', 'CC-BY-4.0']);
    const stale = detectStaleAllowlist(ALLOWLIST, encountered);
    assert.deepEqual(stale, []);
  });

  it('flags allowlist entries that no dependency uses', () => {
    const encountered = new Set(['MIT', 'ISC', 'BSD-3-CLAUSE']);
    const stale = detectStaleAllowlist(ALLOWLIST, encountered);
    assert.ok(stale.includes('Apache-2.0'));
    assert.ok(stale.includes('BlueOak-1.0.0'));
    assert.ok(stale.includes('CC-BY-4.0'));
    assert.ok(stale.includes('0BSD'));
    assert.ok(stale.includes('BSD-2-Clause'));
    // MIT, ISC, BSD-3-Clause should not be stale
    assert.ok(!stale.includes('MIT'));
    assert.ok(!stale.includes('ISC'));
    assert.ok(!stale.includes('BSD-3-Clause'));
  });

  it('returns all entries when nothing was encountered', () => {
    const stale = detectStaleAllowlist(ALLOWLIST, new Set());
    assert.equal(stale.length, ALLOWLIST.length);
  });

  it('matches compound licenses by prefix', () => {
    // If we encounter "MIT-0", it should count as using "MIT"
    const encountered = new Set(['MIT-0', 'ISC']);
    const stale = detectStaleAllowlist(['MIT', 'ISC', 'Apache-2.0'], encountered);
    assert.deepEqual(stale, ['Apache-2.0']);
  });
});

// ── detectStaleOwnPackages ───────────────────────────────────────────────────

describe('detectStaleOwnPackages', () => {
  it('returns empty when OWN_PACKAGES matches workspace packages exactly', () => {
    const workspace = ['@iln/sdk', '@iln/sdk-next', '@iln/indexer'];
    const own = ['@iln/sdk', '@iln/sdk-next', '@iln/indexer'];
    const { stale, missing } = detectStaleOwnPackages(own, workspace);
    assert.deepEqual(stale, []);
    assert.deepEqual(missing, []);
  });

  it('flags OWN_PACKAGES entries no longer in workspace as stale', () => {
    const workspace = ['@iln/sdk', '@iln/indexer'];
    const own = ['@iln/sdk', '@iln/indexer', '@iln/removed-pkg'];
    const { stale } = detectStaleOwnPackages(own, workspace);
    assert.deepEqual(stale, ['@iln/removed-pkg']);
  });

  it('flags workspace packages missing from OWN_PACKAGES', () => {
    const workspace = ['@iln/sdk', '@iln/indexer', '@iln/new-pkg'];
    const own = ['@iln/sdk', '@iln/indexer'];
    const { missing } = detectStaleOwnPackages(own, workspace);
    assert.deepEqual(missing, ['@iln/new-pkg']);
  });

  it('handles both stale and missing simultaneously', () => {
    const workspace = ['@iln/sdk', '@iln/new-pkg'];
    const own = ['@iln/sdk', '@iln/old-pkg'];
    const { stale, missing } = detectStaleOwnPackages(own, workspace);
    assert.deepEqual(stale, ['@iln/old-pkg']);
    assert.deepEqual(missing, ['@iln/new-pkg']);
  });
});

// ── parseWorkspacePatterns ──────────────────────────────────────────────────

describe('parseWorkspacePatterns', () => {
  it('extracts glob patterns from pnpm-workspace.yaml', () => {
    const yaml = "packages:\n  - sdk\n  - cli\n  - 'packages/*'\n";
    assert.deepEqual(parseWorkspacePatterns(yaml), ['sdk', 'cli', 'packages/*']);
  });

  it('returns empty for YAML without packages section', () => {
    assert.deepEqual(parseWorkspacePatterns('foo: bar\n'), []);
  });
});

// ── discoverWorkspacePackageNames ───────────────────────────────────────────

describe('discoverWorkspacePackageNames', () => {
  it('discovers package names from the real monorepo', () => {
    const root = require('path').resolve(__dirname, '..', '..');
    const names = discoverWorkspacePackageNames(root);
    assert.ok(names.length > 0, 'should discover at least some packages');
    assert.ok(names.includes('@iln/sdk'), 'should include @iln/sdk');
    assert.ok(names.includes('@invoice-liquidity/cli'), 'should include @invoice-liquidity/cli');
  });
});
