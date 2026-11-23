import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const {
  parseLimit,
  checkBudget,
  detectStaleThresholds,
  validateConfig,
  STALE_RATIO,
} = require('../check-bundle-size.js');

// ── parseLimit ───────────────────────────────────────────────────────────────

describe('parseLimit', () => {
  it('parses KB values', () => {
    assert.equal(parseLimit('110 KB'), 110 * 1024);
    assert.equal(parseLimit('1.5 KB'), Math.round(1.5 * 1024));
  });

  it('parses MB values', () => {
    assert.equal(parseLimit('2 MB'), 2 * 1024 * 1024);
    assert.equal(parseLimit('0.5 MB'), Math.round(0.5 * 1024 * 1024));
  });

  it('parses B values', () => {
    assert.equal(parseLimit('1024 B'), 1024);
    assert.equal(parseLimit('500 B'), 500);
  });

  it('is case-insensitive', () => {
    assert.equal(parseLimit('110 kb'), 110 * 1024);
    assert.equal(parseLimit('2 mb'), 2 * 1024 * 1024);
  });

  it('throws on invalid format', () => {
    assert.throws(() => parseLimit('invalid'), /Invalid limit format/);
    assert.throws(() => parseLimit('110'), /Invalid limit format/);
    assert.throws(() => parseLimit('110 KB extra'), /Invalid limit format/);
  });
});

// ── validateConfig ──────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('accepts a valid config with budgets', () => {
    const config = {
      budgets: [
        { path: 'dist/index.mjs', limit: '110 KB' },
        { path: 'dist/index.cjs', limit: '120 KB' },
      ],
    };
    const result = validateConfig(config);
    assert.equal(result.valid, true);
  });

  it('rejects null config', () => {
    const result = validateConfig(null);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('null'));
  });

  it('rejects config with missing budgets array', () => {
    const result = validateConfig({});
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('budgets'));
  });

  it('rejects config with empty budgets array', () => {
    const result = validateConfig({ budgets: [] });
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('empty'));
  });

  it('rejects budget entry missing path', () => {
    const result = validateConfig({ budgets: [{ limit: '100 KB' }] });
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('path'));
  });

  it('rejects budget entry missing limit', () => {
    const result = validateConfig({ budgets: [{ path: 'dist/index.mjs' }] });
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('limit'));
  });

  it('rejects budget entry with unparseable limit', () => {
    const result = validateConfig({
      budgets: [{ path: 'dist/index.mjs', limit: 'not-a-size' }],
    });
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Invalid limit format'));
  });
});

// ── checkBudget ─────────────────────────────────────────────────────────────

describe('checkBudget', () => {
  it('reports OK when a file is within the limit', () => {
    // Create a temp file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
    const tmpFile = path.join(tmpDir, 'test.mjs');
    fs.writeFileSync(tmpFile, 'x'.repeat(1024)); // 1 KB file

    const result = checkBudget({ path: 'test.mjs', limit: '10 KB' }, tmpDir);
    assert.equal(result.status, 'ok');
    assert.equal(result.path, 'test.mjs');
    assert.ok(parseFloat(result.sizeKB) < 10, 'size should be under limit');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('reports OVER when a file exceeds the limit', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
    const tmpFile = path.join(tmpDir, 'test.mjs');
    fs.writeFileSync(tmpFile, 'x'.repeat(20 * 1024)); // 20 KB file

    const result = checkBudget({ path: 'test.mjs', limit: '10 KB' }, tmpDir);
    assert.equal(result.status, 'over');
    assert.ok(result.message.includes('OVER BUDGET'));

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('reports MISSING when the file does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));

    const result = checkBudget({ path: 'nonexistent.mjs', limit: '10 KB' }, tmpDir);
    assert.equal(result.status, 'missing');
    assert.ok(result.message.includes('MISSING'));

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ── detectStaleThresholds ────────────────────────────────────────────────────

describe('detectStaleThresholds', () => {
  it('does not flag budgets near the limit', () => {
    const checked = [
      { path: 'dist/index.mjs', sizeKB: '90.00', limitDisplay: '110 KB', size: 90 * 1024, limit: 110 * 1024 },
    ];
    const stale = detectStaleThresholds(checked);
    assert.deepEqual(stale, []);
  });

  it('flags budgets far below the limit (stale threshold)', () => {
    const checked = [
      { path: 'dist/index.mjs', sizeKB: '20.00', limitDisplay: '110 KB', size: 20 * 1024, limit: 110 * 1024 },
    ];
    const stale = detectStaleThresholds(checked);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].path, 'dist/index.mjs');
    assert.ok(stale[0].ratio < STALE_RATIO, 'ratio should be below STALE_RATIO');
  });

  it('flags multiple stale budgets', () => {
    const checked = [
      { path: 'dist/index.mjs', sizeKB: '20.00', limitDisplay: '110 KB', size: 20 * 1024, limit: 110 * 1024 },
      { path: 'dist/index.cjs', sizeKB: '10.00', limitDisplay: '120 KB', size: 10 * 1024, limit: 120 * 1024 },
      { path: 'dist/index.umd.js', sizeKB: '90.00', limitDisplay: '100 KB', size: 90 * 1024, limit: 100 * 1024 },
    ];
    const stale = detectStaleThresholds(checked);
    assert.equal(stale.length, 2);
    assert.ok(stale.some((s) => s.path === 'dist/index.mjs'));
    assert.ok(stale.some((s) => s.path === 'dist/index.cjs'));
    assert.ok(!stale.some((s) => s.path === 'dist/index.umd.js'));
  });

  it('handles exactly at the stale ratio boundary', () => {
    const size = 55 * 1024;
    const limit = 110 * 1024; // ratio = 0.5 exactly
    const checked = [
      { path: 'dist/boundary.mjs', sizeKB: '55.00', limitDisplay: '110 KB', size, limit },
    ];
    // At exactly 50%, it should NOT be flagged (ratio < STALE_RATIO is false at 0.5)
    const stale = detectStaleThresholds(checked);
    assert.deepEqual(stale, []);
  });

  it('skips entries without size or limit', () => {
    const checked = [
      { path: 'dist/unknown.mjs', sizeKB: '0', limitDisplay: '110 KB' },
    ];
    const stale = detectStaleThresholds(checked);
    assert.deepEqual(stale, []);
  });
});
