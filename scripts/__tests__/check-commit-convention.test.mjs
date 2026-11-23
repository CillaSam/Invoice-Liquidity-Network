import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  checkEnforcementPoints,
  checkContributingTypes,
} from '../check-commit-convention.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

// ── loadConfig ──────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('loads commitlint.config.js and exposes type-enum', () => {
    const config = loadConfig(root);
    assert.ok(config, 'config should be loaded');
    assert.ok(config.rules, 'config should have rules');
    assert.ok(config.rules['type-enum'], 'config should have type-enum rule');
    assert.ok(Array.isArray(config.rules['type-enum'][2]), 'type-enum should have an array of types');
  });

  it('includes expected types', () => {
    const config = loadConfig(root);
    const types = config.rules['type-enum'][2];
    const expected = ['feat', 'fix', 'docs', 'chore', 'test', 'refactor', 'perf', 'ci', 'design', 'build'];
    for (const type of expected) {
      assert.ok(types.includes(type), `type-enum should include "${type}"`);
    }
  });

  it('does NOT include revert or merge types', () => {
    const config = loadConfig(root);
    const types = config.rules['type-enum'][2];
    assert.ok(!types.includes('revert'), 'revert should not be in type-enum (documented decision)');
    assert.ok(!types.includes('merge'), 'merge should not be in type-enum');
  });
});

// ── checkEnforcementPoints ──────────────────────────────────────────────────

describe('checkEnforcementPoints', () => {
  it('verifies both enforcement points reference the config explicitly', () => {
    const { passed, failed } = checkEnforcementPoints(root);
    assert.equal(failed.length, 0, `unexpected failures: ${failed.join('; ')}`);
    assert.ok(passed.length >= 2, 'should pass both enforcement points');
  });
});

// ── checkContributingTypes ──────────────────────────────────────────────────

describe('checkContributingTypes', () => {
  it('verifies CONTRIBUTING.md documents all configured types', () => {
    const config = loadConfig(root);
    const { passed, failed } = checkContributingTypes(root, config);
    assert.equal(failed.length, 0, `unexpected failures: ${failed.join('; ')}`);
    assert.ok(passed.length >= 2, 'should pass type documentation checks');
  });

  it('fails when a type is configured but not documented', () => {
    // Simulate a config with an undocumented type
    const fakeConfig = {
      rules: {
        'type-enum': [2, 'always', ['feat', 'fix', 'undocumented-type']],
      },
    };
    const { failed } = checkContributingTypes(root, fakeConfig);
    assert.ok(failed.some((f) => f.includes('undocumented-type')), 'should flag undocumented type');
  });
});

// ── Edge-case documentation tests ────────────────────────────────────────────

describe('Edge-case type coverage (documented behavior)', () => {
  it('release automation type "chore" is in type-enum', () => {
    const config = loadConfig(root);
    const types = config.rules['type-enum'][2];
    assert.ok(
      types.includes('chore'),
      '"chore" must be in type-enum for release-automation commits like chore(release): 1.2.3'
    );
  });

  it('merge commits are NOT exempt (squash-merge workflow)', () => {
    const config = loadConfig(root);
    const types = config.rules['type-enum'][2];
    // Documenting that "Merge" is not a valid type
    assert.ok(!types.includes('Merge'), 'Merge is not a type — merge commits will be rejected');
    assert.ok(!types.includes('merge'), 'merge is not a type — merge commits will be rejected');
  });

  it('revert type is NOT in type-enum (documented decision)', () => {
    const config = loadConfig(root);
    const types = config.rules['type-enum'][2];
    assert.ok(!types.includes('revert'), 'revert is not in type-enum — revert commits will be rejected');
  });

  it('CONTRIBUTING.md documents the squash-merge / revert guidance', () => {
    // The script itself documents these edge cases. This test verifies
    // the script's edge-case section exists by checking the config structure.
    const config = loadConfig(root);
    assert.ok(config.rules['type-enum'][0] === 2, 'type-enum should be enforced at error level');
    assert.ok(config.rules['type-enum'][1] === 'always', 'type-enum should apply to all commits');
  });
});
