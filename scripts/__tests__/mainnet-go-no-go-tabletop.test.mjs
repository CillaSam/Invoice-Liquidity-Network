/**
 * Regression suite for the independent mainnet go/no-go tabletop (#1330).
 * Dependency-free: runs with `node --test`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_NAME,
  DEFAULT_TABLETOP_CONFIG,
  REQUIRED_REVIEWER_AREAS,
  REQUIRED_SCENARIO_IDS,
  TABLETOP_SCHEMA,
  evaluateReviewers,
  evaluateScenario,
  evaluateTabletop,
  isPlaceholder,
  parseIsoDateTime,
} from '../hardening/mainnet-go-no-go-tabletop.mjs';

const AS_OF_MS = Date.parse('2026-11-23T00:00:00.000Z');
const EXECUTED_AT = '2026-11-20T00:00:00.000Z';
const SIGNED_AT = '2026-11-21T00:00:00.000Z';
const CHECKLIST_OWNERS = [
  '@infrastructure-lead',
  '@sre-oncall',
  '@devops-oncall',
  '@security-lead',
  '@release-lead',
];

function context(overrides = {}) {
  return {
    asOfMs: AS_OF_MS,
    exists: () => true,
    checklistOwners: CHECKLIST_OWNERS,
    ...overrides,
  };
}

function scenario(id, overrides = {}) {
  return {
    id,
    status: 'PASS',
    decision: 'GO',
    expectedControl: `documented ${id} control`,
    observedResult: `rehearsed ${id} outcome`,
    evidencePath: `docs/evidence/${id}.md`,
    owner: `@owner-${id}`,
    recoveryPath: `Roll back ${id} and re-run the tabletop.`,
    decisionLog: [{ at: EXECUTED_AT, actor: '@tabletop-lead', outcome: 'GO' }],
    ...overrides,
  };
}

function validRecord(overrides = {}) {
  return {
    schemaVersion: TABLETOP_SCHEMA,
    control: CONTROL_NAME,
    owner: '@release-lead',
    decision: 'GO',
    executedAt: EXECUTED_AT,
    checklistRevision: 'upstream/dev@1ffd4b6',
    blockers: [],
    scenarios: REQUIRED_SCENARIO_IDS.map((id) => scenario(id)),
    reviewers: REQUIRED_REVIEWER_AREAS.map((area) => ({
      area,
      name: `@reviewer-${area}`,
      relationship: 'independent',
      signoff: 'Signed',
      signedAt: SIGNED_AT,
    })),
    ...overrides,
  };
}

describe('Mainnet go/no-go tabletop control (#1330)', () => {
  it('strictly parses UTC timestamps and detects placeholders', () => {
    assert.equal(parseIsoDateTime(EXECUTED_AT), Date.parse(EXECUTED_AT));
    assert.equal(parseIsoDateTime('2026-11-20T00:00:00+00:00'), null);
    assert.equal(parseIsoDateTime('2026-02-30T00:00:00.000Z'), null);
    assert.equal(isPlaceholder('Pending'), true);
    assert.equal(isPlaceholder('@release-lead'), false);
  });

  it('requires a verified scenario to have evidence, an owner, and a recovery path', () => {
    assert.equal(evaluateScenario(scenario('example'), context()).pass, true);
    assert.equal(
      evaluateScenario(scenario('example', { status: 'FAIL' }), context()).code,
      'TABLETOP_SCENARIO_FAILED'
    );
    assert.equal(
      evaluateScenario(scenario('example', { decision: 'NO_GO' }), context()).code,
      'TABLETOP_SCENARIO_NO_GO'
    );
    assert.equal(
      evaluateScenario(scenario('example', { evidencePath: '' }), context()).code,
      'TABLETOP_EVIDENCE_MISSING'
    );
    assert.equal(
      evaluateScenario(scenario('example', { recoveryPath: 'TBD' }), context()).code,
      'TABLETOP_RECOVERY_MISSING'
    );
    assert.equal(
      evaluateScenario(scenario('example', { evidencePath: 'missing.md' }), context({ exists: (p) => p !== 'missing.md' })).code,
      'TABLETOP_EVIDENCE_MISSING'
    );
  });

  it('rejects unsigned, stale, future-dated, and non-independent reviewers', () => {
    assert.equal(evaluateReviewers(validRecord().reviewers, CHECKLIST_OWNERS, AS_OF_MS).every((c) => c.pass), true);

    const unsigned = evaluateReviewers(
      validRecord().reviewers.map((reviewer, index) =>
        index === 0 ? { ...reviewer, signoff: 'Pending' } : reviewer
      ),
      CHECKLIST_OWNERS,
      AS_OF_MS
    );
    assert.ok(unsigned.some((c) => c.code === 'TABLETOP_REVIEWER_NOT_SIGNED' && !c.pass));

    const conflicted = evaluateReviewers(
      validRecord().reviewers.map((reviewer, index) =>
        index === 0 ? { ...reviewer, name: '@security-lead' } : reviewer
      ),
      CHECKLIST_OWNERS,
      AS_OF_MS
    );
    assert.ok(conflicted.some((c) => c.code === 'TABLETOP_REVIEWER_NOT_INDEPENDENT' && !c.pass));

    const stale = evaluateReviewers(validRecord().reviewers, CHECKLIST_OWNERS, Date.parse('2027-01-01T00:00:00.000Z'));
    assert.ok(stale.some((c) => c.code === 'TABLETOP_REVIEWER_STALE' && !c.pass));

    const future = evaluateReviewers(
      validRecord().reviewers.map((reviewer, index) =>
        index === 0 ? { ...reviewer, signedAt: '2026-12-01T00:00:00.000Z' } : reviewer
      ),
      CHECKLIST_OWNERS,
      AS_OF_MS
    );
    assert.ok(future.some((c) => c.code === 'TABLETOP_REVIEWER_STALE' && !c.pass));
  });

  it('approves a fully signed tabletop and is deterministic on replay', () => {
    const result = evaluateTabletop(validRecord(), context());
    assert.equal(result.pass, true);
    assert.equal(result.decision, 'GO');
    assert.equal(result.code, 'TABLETOP_GO');
    assert.equal(result.owner, '@release-lead');
    assert.deepEqual(result, evaluateTabletop(validRecord(), context()));
    assert.equal(result.metrics.decisions, 'iln_go_no_go_decisions');
  });

  it('fails closed for missing scenarios, unresolved blockers, and stale records', () => {
    const missing = evaluateTabletop(validRecord({ scenarios: validRecord().scenarios.slice(1) }), context());
    assert.equal(missing.pass, false);
    assert.equal(missing.decision, 'NO_GO');
    assert.equal(missing.code, 'TABLETOP_SCENARIO_FAILED');

    const blocked = evaluateTabletop(
      validRecord({ blockers: [{ id: 'audit-finding', owner: '@security-lead' }] }),
      context()
    );
    assert.equal(blocked.code, 'TABLETOP_UNRESOLVED_BLOCKERS');

    const stale = evaluateTabletop(validRecord(), context({ asOfMs: Date.parse('2027-01-01T00:00:00.000Z') }));
    assert.equal(stale.code, 'TABLETOP_STALE_OR_FUTURE');
    assert.equal(stale.decision, 'NO_GO');
  });

  it('fails closed for a NO_GO decision or invalid record shape', () => {
    assert.equal(
      evaluateTabletop(validRecord({ decision: 'NO_GO' }), context()).code,
      'TABLETOP_OVERALL_NO_GO'
    );
    assert.equal(evaluateTabletop(null, context()).code, 'TABLETOP_RECORD_INVALID');
    assert.equal(evaluateTabletop([], context()).code, 'TABLETOP_RECORD_INVALID');
    assert.equal(
      evaluateTabletop(validRecord({ schemaVersion: 'other' }), context()).code,
      'TABLETOP_SCHEMA_MISMATCH'
    );
  });

  it('carries an owner and recovery path on every NO_GO result', () => {
    const result = evaluateTabletop(validRecord({ decision: 'NO_GO' }), context());
    assert.equal(result.owner, '@release-lead');
    assert.match(result.recovery, /NO_GO/);
  });

  it('uses the documented default freshness configuration', () => {
    assert.equal(DEFAULT_TABLETOP_CONFIG.maxRecordAgeDays, 30);
    assert.equal(DEFAULT_TABLETOP_CONFIG.maxSignoffAgeDays, 30);
    assert.equal(REQUIRED_SCENARIO_IDS.length, 7);
    assert.equal(REQUIRED_REVIEWER_AREAS.length, 6);
  });
});
