/**
 * Regression suite for the on-call escalation and handoff control (#1329).
 * Dependency-free: runs with `node --test`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_NAME,
  DEFAULT_ON_CALL_CONFIG,
  MANIFEST_SCHEMA_VERSION,
  evaluateChecklist,
  evaluateOnCallReadiness,
  evaluateOwners,
  evaluateRotation,
  evaluateSlas,
  headingAnchors,
  isPlaceholder,
  parseCalendarDate,
} from '../hardening/on-call-escalation-handoff.mjs';

const AS_OF_MS = Date.parse('2026-11-23T00:00:00.000Z');
const RUNBOOK = `# On-call Runbook

## 2. Owners and escalation

Details.

## 3. Handoff checklist

Details.

## 4. Recovery path

Details.
`;

const NAV_TS = "export default { 'on-call-escalation-handoff': { title: 'On-call' } };";
const NAV_JSON = JSON.stringify({ 'on-call-escalation-handoff': 'On-call Escalation and Handoff' });
const CHECKLIST_MD = [
  '| Item | Owner | Artifact |',
  '| On-call escalation and handoff | Infrastructure lead | ops/on-call-checklist.json |',
  '| Canonical page | Infrastructure lead | on-call-escalation-handoff |',
].join('\n');

const FILES = new Map([
  ['docs/runbooks/on-call-escalation-handoff.md', RUNBOOK],
  ['packages/docs/content/on-call-escalation-handoff.mdx', '# On-call Escalation and Handoff'],
  ['docs/mainnet-launch-checklist.md', CHECKLIST_MD],
  ['packages/docs/content/_meta.ts', NAV_TS],
  ['docs/_meta.json', NAV_JSON],
]);

function context(overrides = {}) {
  return {
    asOfMs: AS_OF_MS,
    runbookText: RUNBOOK,
    exists: (path) => FILES.has(path),
    readText: (path) => FILES.get(path) ?? '',
    ...overrides,
  };
}

function validManifest(overrides = {}) {
  return {
    control: CONTROL_NAME,
    version: MANIFEST_SCHEMA_VERSION,
    owners: {
      primary: '@infrastructure-lead',
      oncall: '@sre-oncall',
      secondary: '@devops-oncall',
      escalation: '@security-lead',
      checklist_owner: '@infrastructure-lead',
    },
    channels: { war_room: '#incident-response', pager_webhook_env: 'ALERT_WEBHOOK_URL' },
    sla: { ack_minutes: 15, p1_escalation_minutes: 15, p2_escalation_minutes: 60 },
    rotation: {
      interval_days: 7,
      handoff_window_hours: 24,
      last_handoff: '2026-11-23',
      next_handoff_due: '2026-11-30',
    },
    checklist: [
      { id: 'owner-assigned', owner: '@infrastructure-lead', runbook_anchor: '#2-owners-and-escalation' },
      { id: 'p1-path-tested', owner: '@security-lead', runbook_anchor: '#2-owners-and-escalation' },
      { id: 'recovery-confirmed', owner: '@devops-oncall', runbook_anchor: '#4-recovery-path' },
    ],
    runbook: 'docs/runbooks/on-call-escalation-handoff.md',
    published_page: 'packages/docs/content/on-call-escalation-handoff.mdx',
    evidence: 'docs/mainnet-launch-checklist.md',
    ...overrides,
  };
}

describe('On-call escalation and handoff control (#1329)', () => {
  it('guards calendar parsing and placeholder owners', () => {
    assert.equal(parseCalendarDate('2026-11-23'), AS_OF_MS);
    assert.equal(parseCalendarDate('2026-02-30'), null);
    assert.equal(parseCalendarDate('23-11-2026'), null);
    assert.equal(isPlaceholder('TBD'), true);
    assert.equal(isPlaceholder(' @sre-oncall '), false);
  });

  it('derives GitHub-style heading anchors from runbook headings', () => {
    const anchors = headingAnchors(RUNBOOK);
    assert.ok(anchors.has('#2-owners-and-escalation'));
    assert.ok(anchors.has('#3-handoff-checklist'));
    assert.ok(anchors.has('#4-recovery-path'));
  });

  it('rejects placeholder and missing role owners', () => {
    const checks = evaluateOwners({ primary: 'TBD', oncall: '@sre-oncall' });
    assert.equal(checks.filter((entry) => !entry.pass).length, 4);
    assert.ok(checks.every((entry) => entry.code === 'ON_CALL_OWNER_MISSING'));
  });

  it('enforces acknowledgement and escalation SLAs', () => {
    assert.ok(evaluateSlas({ ack_minutes: 15, p1_escalation_minutes: 15, p2_escalation_minutes: 60 }).every((c) => c.pass));
    assert.equal(
      evaluateSlas({ ack_minutes: 30, p1_escalation_minutes: 15, p2_escalation_minutes: 60 })[0].code,
      'ON_CALL_ACK_SLA_INVALID'
    );
    assert.equal(
      evaluateSlas({ ack_minutes: 15, p1_escalation_minutes: 30, p2_escalation_minutes: 60 })[1].code,
      'ON_CALL_P1_SLA_INVALID'
    );
    assert.equal(
      evaluateSlas({ ack_minutes: 15, p1_escalation_minutes: 15, p2_escalation_minutes: 10 })[2].code,
      'ON_CALL_P2_SLA_INVALID'
    );
  });

  it('rejects inconsistent, overdue, and malformed handoff dates', () => {
    const rotation = {
      interval_days: 7,
      handoff_window_hours: 24,
      last_handoff: '2026-11-23',
      next_handoff_due: '2026-11-30',
    };
    assert.ok(evaluateRotation(rotation, AS_OF_MS).checks.every((c) => c.pass));

    const inconsistent = evaluateRotation({ ...rotation, next_handoff_due: '2026-12-01' }, AS_OF_MS);
    assert.equal(inconsistent.checks.find((c) => c.code === 'ON_CALL_HANDOFF_DATE_INCONSISTENT').pass, false);

    const overdue = evaluateRotation(rotation, Date.parse('2026-12-01T00:00:00.000Z'));
    assert.equal(overdue.checks.find((c) => c.code === 'ON_CALL_HANDOFF_OVERDUE').pass, false);

    const malformed = evaluateRotation({ ...rotation, last_handoff: '2026-02-30' }, AS_OF_MS);
    assert.equal(malformed.checks.find((c) => c.code === 'ON_CALL_HANDOFF_DATES_INVALID').pass, false);
  });

  it('warns without failing when a handoff is due soon', () => {
    const result = evaluateOnCallReadiness(
      validManifest({ rotation: { interval_days: 7, handoff_window_hours: 24, last_handoff: '2026-11-16', next_handoff_due: '2026-11-23' } }),
      context()
    );
    assert.equal(result.pass, true);
    assert.deepEqual(
      result.warnings.map((warning) => warning.code),
      ['ON_CALL_HANDOFF_DUE_SOON']
    );
  });

  it('rejects checklist items without unique ids, owners, or live anchors', () => {
    const result = evaluateChecklist(
      [
        { id: 'dup', owner: '@a', runbook_anchor: '#2-owners-and-escalation' },
        { id: 'dup', owner: '@b', runbook_anchor: '#2-owners-and-escalation' },
        { id: 'missing-anchor', owner: '@c', runbook_anchor: '#99-missing' },
      ],
      RUNBOOK
    );
    assert.ok(result.checks.some((c) => c.code === 'ON_CALL_CHECKLIST_ID_INVALID' && !c.pass));
    assert.ok(result.checks.some((c) => c.code === 'ON_CALL_RUNBOOK_ANCHOR_MISSING' && !c.pass));
  });

  it('approves a complete manifest and is byte-identical on replay', () => {
    const result = evaluateOnCallReadiness(validManifest(), context());
    assert.equal(result.pass, true);
    assert.equal(result.code, 'ON_CALL_READY');
    assert.equal(result.owner, '@infrastructure-lead');
    assert.equal(result.warnings.length, 0);
    assert.deepEqual(result, evaluateOnCallReadiness(validManifest(), context()));
    assert.equal(result.metrics.failures, 'iln_on_call_checklist_failures_total');
  });

  it('fails closed for placeholder owners, missing nav, and missing evidence links', () => {
    const placeholder = evaluateOnCallReadiness(
      validManifest({ owners: { ...validManifest().owners, oncall: 'Pending' } }),
      context()
    );
    assert.equal(placeholder.pass, false);
    assert.equal(placeholder.code, 'ON_CALL_OWNER_MISSING');

    const noNav = evaluateOnCallReadiness(
      validManifest(),
      context({ readText: (path) => (path.endsWith('_meta.ts') ? '' : FILES.get(path) ?? '') })
    );
    assert.equal(noNav.code, 'ON_CALL_CANONICAL_NAV_MISSING');

    const noEvidence = evaluateOnCallReadiness(
      validManifest(),
      context({ readText: (path) => (path.endsWith('mainnet-launch-checklist.md') ? '' : FILES.get(path) ?? '') })
    );
    assert.equal(noEvidence.code, 'ON_CALL_EVIDENCE_LINK_MISSING');
  });

  it('fails closed for malformed or missing manifests', () => {
    assert.equal(evaluateOnCallReadiness(null, context()).code, 'ON_CALL_MANIFEST_INVALID');
    assert.equal(evaluateOnCallReadiness([], context()).code, 'ON_CALL_MANIFEST_INVALID');
    assert.equal(
      evaluateOnCallReadiness(validManifest({ control: 'other-control' }), context()).code,
      'ON_CALL_CONTROL_MISMATCH'
    );
    assert.equal(
      evaluateOnCallReadiness(validManifest({ version: 99 }), context()).code,
      'ON_CALL_SCHEMA_VERSION_MISMATCH'
    );
  });

  it('exposes the owned recovery path in every failure result', () => {
    const result = evaluateOnCallReadiness(validManifest({ rotation: { last_handoff: 'bad' } }), context());
    assert.equal(result.pass, false);
    assert.match(result.recovery, /real handoff/);
  });

  it('uses the documented default configuration', () => {
    assert.equal(DEFAULT_ON_CALL_CONFIG.maxAckMinutes, 15);
    assert.equal(DEFAULT_ON_CALL_CONFIG.maxP1EscalationMinutes, 15);
    assert.equal(DEFAULT_ON_CALL_CONFIG.maxHandoffWindowHours, 24);
  });
});
