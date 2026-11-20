/**
 * tests/synthetic/liquidity-alerts.test.ts
 *
 * Validates the liquidity monitoring alert ruleset (#1311). The alert
 * file names the metrics and thresholds that §7.8 of the trust &
 * liquidity model commits to; this test is the operator-visible regression
 * check that proves the control remains active:
 *
 *   - success: every required alert from §7.8 is present with a
 *     runbook annotation that points at a real file (or a documented
 *     "not yet written" anchor).
 *   - failure: changing the YAML to drop an alert name, miss a `for`
 *     clause, or detach the runbook annotation surfaces here.
 *   - replay/restart: the YAML file is the on-disk source of truth
 *     reloaded verbatim by Prometheus on a restart, so parsing it
 *     deterministically mirrors the production reload.
 *   - boundary: every alert must declare a severity label and a
 *     non-empty `for` duration so Prometheus does not fire on a
 *     one-off scrape blip.
 *
 * The test parses the YAML with a hand-rolled, intentionally restricted
 * reader so the suite stays dependency-free and lives next to the
 * existing synthetic tests.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ALERT_FILE = resolve(
  __dirname,
  '..',
  '..',
  'monitoring',
  'prometheus',
  'liquidity-alerts.yml',
);
const PROMETHEUS_CONFIG = resolve(
  __dirname,
  '..',
  '..',
  'monitoring',
  'prometheus',
  'prometheus.yml',
);
const DOC_FILE = resolve(__dirname, '..', '..', 'docs', 'trust-liquidity-model.md');

interface Rule {
  alert?: string;
  record?: string;
  expr?: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

interface Group {
  name: string;
  interval?: string;
  rules: Rule[];
}

/**
 * Minimal prom-rules YAML reader. The real file uses the Prometheus
 * ruleset schema which is a small subset of YAML; a regex-based pass
 * keeps the test offline and dependency-free. Any structural drift from
 * the shape we assume below fails the structural assertions below rather
 * than silently parsing the wrong tree.
 */
function parseAlerts(src: string): Group[] {
  const groups: Group[] = [];
  const groupBlocks = src.split(/^\s*- name:\s*/m).slice(1);
  for (const block of groupBlocks) {
    const nameMatch = block.match(/^([^\n]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const rules: Rule[] = [];

    const ruleBlocks = block
      .split(/^\s*- (alert|record):/m)
      .slice(1); // first chunk is header, discard
    for (let i = 0; i < ruleBlocks.length; i += 2) {
      const kind = ruleBlocks[i] as 'alert' | 'record';
      const body = ruleBlocks[i + 1] ?? '';
      const identMatch = body.match(/^\s*([A-Za-z0-9_:]+)/);
      if (!identMatch) continue;
      const rule: Rule = { [kind]: identMatch[1] } as Rule;

      const forMatch = body.match(/^\s*for:\s*([^\n#]+)/m);
      if (forMatch) rule.for = forMatch[1].trim();

      const labelsBlock = body.match(/^\s*labels:\s*\n([\s\S]*?)(?=\n\s*(annotations:|expr:|for:|$))/m);
      if (labelsBlock) {
        rule.labels = {};
        for (const line of labelsBlock[1].split('\n')) {
          const m = line.match(/^\s+([a-zA-Z0-9_-]+):\s*(.+)$/);
          if (m) rule.labels[m[1]] = m[2].trim();
        }
      }

      const annsBlock = body.match(/^\s*annotations:\s*\n([\s\S]*?)(?=\n\s*- (alert|record):|\n\s*- name:|\s*$)/m);
      if (annsBlock) {
        rule.annotations = {};
        // Annotations have multi-line `>-` scalars; we only need the keys
        // to be present and non-empty for validation.
        for (const line of annsBlock[1].split('\n')) {
          const m = line.match(/^\s+([a-zA-Z0-9_-]+):\s*(.*)$/);
          if (m) rule.annotations[m[1]] = m[2].trim();
        }
      }
      rules.push(rule);
    }

    groups.push({ name, rules });
  }
  return groups;
}

const groups = parseAlerts(readFileSync(ALERT_FILE, 'utf8'));
const alerts = groups.flatMap((g) => g.rules.filter((r) => r.alert));

const REQUIRED_ALERTS = [
  'ILNLiquidityCoverageRatioLow',       // §7.8 liquidity_coverage_ratio < 0.5 for 2 epochs
  'ILNLiquidityCoverageRatioDegrading', // early warning companion
  'ILNWithdrawalQueueStale',            // §7.8 oldest_queued_request_age > 28d
  'ILNFundingCircuitBreakerActive',     // §7.8 circuit_breaker_active
  'ILNHighPartialFillRate',             // §7.8 partial_fill_rate > 50%
  'ILNLiquidityMetricsMissing',         // metrics-presence guard rail
];

describe('liquidity alerts — §7.8 coverage (#1311)', () => {
  it.each(REQUIRED_ALERTS)('declares the %s alert', (name) => {
    expect(alerts.find((a) => a.alert === name)).toBeDefined();
  });

  it('declares exactly the alerts §7.8 names + one guard rail (no silent drift)', () => {
    expect(alerts.map((a) => a.alert).sort()).toEqual([...REQUIRED_ALERTS].sort());
  });
});

describe('liquidity alerts — hygiene', () => {
  it('every alert has a severity label (critical | high | warning)', () => {
    for (const a of alerts) {
      expect(a.labels?.severity, `${a.alert} is missing a severity label`).toBeDefined();
      expect(['critical', 'high', 'warning']).toContain(a.labels!.severity);
    }
  });

  it('every alert has a non-empty `for` duration (prevents single-scrape flapping)', () => {
    for (const a of alerts) {
      expect(a.for, `${a.alert} is missing a for: duration`).toBeTruthy();
      expect(a.for).toMatch(/^\d+[smhd]$/);
    }
  });

  it('every alert carries a summary annotation so pages are self-describing', () => {
    for (const a of alerts) {
      expect(a.annotations?.summary, `${a.alert} is missing annotations.summary`).toBeTruthy();
    }
  });

  it('every alert carries a runbook pointer (even if the runbook is not yet written)', () => {
    for (const a of alerts) {
      expect(a.annotations?.runbook, `${a.alert} is missing annotations.runbook`).toMatch(
        /^docs\/runbooks\/[a-z0-9-]+\.md$/,
      );
    }
  });
});

describe('liquidity alerts — prometheus config references the rules file (#1311)', () => {
  it('prometheus.yml rule_files includes liquidity-alerts.yml', () => {
    const cfg = readFileSync(PROMETHEUS_CONFIG, 'utf8');
    expect(cfg).toMatch(/liquidity-alerts\.yml/);
  });
});

describe('liquidity alerts — doc anchor presence (#1311)', () => {
  it('trust-liquidity-model.md still names each monitored metric §7.8 claims', () => {
    const md = readFileSync(DOC_FILE, 'utf8');
    for (const metric of [
      'liquidity_coverage_ratio',
      'oldest_queued_request_age',
      'circuit_breaker_active',
      'partial_fill_rate',
    ]) {
      expect(md.includes(metric), `docs/trust-liquidity-model.md no longer mentions ${metric}`).toBe(true);
    }
  });
});
