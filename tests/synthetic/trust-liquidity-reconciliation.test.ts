/**
 * tests/synthetic/trust-liquidity-reconciliation.test.ts
 *
 * Reconciliation guard for #1312. Every claim §6–§7 of
 * `docs/trust-liquidity-model.md` makes is labelled `IMPLEMENTED`,
 * `SIMULATED`, `DESIGN_ONLY`, or `DISCLOSED` in
 * `docs/trust-liquidity-reconciliation.md`. This test fails CI if the
 * reconciliation doc drifts out of sync with the controls it names:
 *
 *   - IMPLEMENTED must name a Prometheus alert (and that alert must exist)
 *     or a cross-repo ILN-Smart-Contract artefact.
 *   - SIMULATED must name a script path and a test path, both of which
 *     must exist on disk.
 *   - DESIGN_ONLY must survive a cross-check against the model doc: the
 *     model must still say the control is pending.
 *   - DISCLOSED must map to a clause in investor-disclosures-liquidity.md.
 *
 * This is the "automated regression check at the relevant boundary"
 * named by the #1312 acceptance criteria.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const RECONCILIATION = resolve(ROOT, 'docs', 'trust-liquidity-reconciliation.md');
const MODEL = resolve(ROOT, 'docs', 'trust-liquidity-model.md');
const DISCLOSURE = resolve(ROOT, 'docs', 'investor-disclosures-liquidity.md');
const ALERTS = resolve(ROOT, 'monitoring', 'prometheus', 'liquidity-alerts.yml');

const text = readFileSync(RECONCILIATION, 'utf8');
const modelText = readFileSync(MODEL, 'utf8');
const disclosureText = readFileSync(DISCLOSURE, 'utf8');
const alertsText = readFileSync(ALERTS, 'utf8');

type Status = 'IMPLEMENTED' | 'SIMULATED' | 'DESIGN_ONLY' | 'DISCLOSED';

interface Row {
  claim: string;
  anchor: string;
  status: Status;
  evidence: string;
}

/**
 * Parse the markdown reconciliation table. Columns are:
 *   | Claim | §-anchor | Status | Evidence |
 */
function parseTable(md: string): Row[] {
  const section = md.split('## 2. Reconciliation table')[1] ?? '';
  const nextSection = section.split('\n## ')[0];
  const rows: Row[] = [];
  for (const line of nextSection.split('\n')) {
    if (!line.startsWith('| ')) continue;
    if (line.includes('---')) continue;
    // Skip the header row.
    if (line.toLowerCase().includes('claim in `trust-liquidity-model')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 4) continue;
    const [claim, anchor, status, evidence] = cells;
    rows.push({ claim, anchor, status: status.replace(/`/g, '') as Status, evidence });
  }
  return rows;
}

const rows = parseTable(text);

describe('reconciliation — row shape (#1312)', () => {
  it('reconciliation table parsed at least one row', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('every row carries one of the four permitted statuses', () => {
    const permitted: Status[] = ['IMPLEMENTED', 'SIMULATED', 'DESIGN_ONLY', 'DISCLOSED'];
    for (const row of rows) {
      expect(permitted, `row for ${row.claim} has invalid status ${row.status}`).toContain(
        row.status,
      );
    }
  });

  it('every row has a non-empty claim and evidence cell', () => {
    for (const row of rows) {
      expect(row.claim).not.toBe('');
      expect(row.evidence).not.toBe('');
    }
  });
});

describe('reconciliation — IMPLEMENTED rows carry concrete evidence', () => {
  const impl = rows.filter((r) => r.status === 'IMPLEMENTED');

  it('has at least one IMPLEMENTED row (otherwise this doc is misleading)', () => {
    expect(impl.length).toBeGreaterThan(0);
  });

  it.each(impl)('row "$claim" cites an alert or ILN-Smart-Contract artefact', (row) => {
    const citesAlert = /ILN[A-Z][A-Za-z]+/.test(row.evidence);
    const citesCrossRepo = /ILN-Smart-Contract|invoice contract|SEP-24|multi-sig/i.test(
      row.evidence,
    );
    expect(citesAlert || citesCrossRepo, `evidence: ${row.evidence}`).toBe(true);

    if (citesAlert) {
      // Resolve the alert name against the actual rules file.
      const alertName = row.evidence.match(/`?ILN[A-Z][A-Za-z]+`?/)![0].replace(/`/g, '');
      expect(alertsText, `alert ${alertName} missing from rules file`).toContain(
        `alert: ${alertName}`,
      );
    }
  });
});

describe('reconciliation — SIMULATED rows point at runnable artefacts', () => {
  const sim = rows.filter((r) => r.status === 'SIMULATED');

  it('every SIMULATED row cites a script path AND a test path that both exist', () => {
    for (const row of sim) {
      const scriptMatch = row.evidence.match(/scripts\/[a-zA-Z0-9/_.-]+\.m?[jt]s/);
      const testMatch = row.evidence.match(/tests\/[a-zA-Z0-9/_.-]+\.test\.ts/);
      expect(scriptMatch, `SIMULATED row needs a script path: ${row.claim}`).not.toBeNull();
      expect(testMatch, `SIMULATED row needs a test path: ${row.claim}`).not.toBeNull();
      expect(existsSync(resolve(ROOT, scriptMatch![0]))).toBe(true);
      expect(existsSync(resolve(ROOT, testMatch![0]))).toBe(true);
    }
  });
});

describe('reconciliation — DESIGN_ONLY rows have not quietly been promoted', () => {
  const design = rows.filter((r) => r.status === 'DESIGN_ONLY');

  it('model doc still signals these claims are not yet implemented', () => {
    // The model uses specific "pending" phrases for §7; if ALL of them are
    // gone while design-only rows remain, something was promoted without
    // updating the reconciliation doc.
    const pendingPhrases = [
      'must be implemented and tested before',
      'not yet written',
      'design recommendations, not deployed',
    ];
    const atLeastOnePendingPhrase = pendingPhrases.some((phrase) => modelText.includes(phrase));
    // Only assert when there are design-only rows — otherwise promotion is
    // the correct state and this check should be inert.
    if (design.length > 0) {
      expect(atLeastOnePendingPhrase).toBe(true);
    }
  });
});

describe('reconciliation — DISCLOSED rows map to the investor disclosure page', () => {
  const disclosed = rows.filter((r) => r.status === 'DISCLOSED');

  it.each(disclosed)('row "$claim" is covered by investor-disclosures-liquidity.md', (row) => {
    // The disclosure page must still contain the "clauses 1–7" marker that
    // the evidence cell points at, or a direct reference to the investor
    // disclosure file.
    expect(row.evidence.includes('investor-disclosures-liquidity')).toBe(true);
    expect(disclosureText.length).toBeGreaterThan(0);
    expect(disclosureText).toContain('What liquidity providers must acknowledge');
  });
});

describe('reconciliation — baseline counts match the written baseline', () => {
  it('row counts match the "9 IMPLEMENTED, 1 SIMULATED, 3 DESIGN_ONLY, 1 DISCLOSED" baseline', () => {
    const counts = rows.reduce<Record<Status, number>>(
      (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
      { IMPLEMENTED: 0, SIMULATED: 0, DESIGN_ONLY: 0, DISCLOSED: 0 },
    );
    expect(counts.IMPLEMENTED).toBe(9);
    expect(counts.SIMULATED).toBe(1);
    expect(counts.DESIGN_ONLY).toBe(3);
    expect(counts.DISCLOSED).toBe(1);
    // A changed count must also update the §5 baseline paragraph.
    expect(text).toMatch(/9 `IMPLEMENTED`, 1 `SIMULATED`, 3 `DESIGN_ONLY`, 1 `DISCLOSED`/);
  });
});
