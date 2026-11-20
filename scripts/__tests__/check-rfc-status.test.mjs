import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  auditRepository,
  parseIndex,
  parseRfc,
  validateIndex,
  validateRfc,
} from '../check-rfc-status.mjs';

const TODAY = new Date('2026-11-20T00:00:00Z');

function makeRfc(overrides = {}) {
  const fields = {
    status: 'Accepted',
    implementationStatus: 'implemented',
    evidence: 'PR #123',
    lastVerified: '2026-11-20',
    ...overrides,
  };
  return `# RFC 0042 — Sample RFC

- **Status:** ${fields.status}
- **Implementation status:** ${fields.implementationStatus}
- **Implementation evidence:** ${fields.evidence}
- **Last verified:** ${fields.lastVerified}

---

## Summary

Sample.
`;
}

function codes(findings) {
  return findings.map((finding) => finding.code);
}

describe('parseRfc', () => {
  it('reads the number, title, and status fields from the header', () => {
    const rfc = parseRfc(makeRfc(), '0042-sample-rfc.md');

    assert.equal(rfc.number, '0042');
    assert.equal(rfc.title, 'Sample RFC');
    assert.equal(rfc.status, 'Accepted');
    assert.equal(rfc.implementationStatus, 'implemented');
    assert.equal(rfc.evidence, 'PR #123');
    assert.equal(rfc.lastVerified, '2026-11-20');
  });

  it('treats an em-dash evidence placeholder as absent', () => {
    const rfc = parseRfc(
      makeRfc({ implementationStatus: 'not-applicable', evidence: '—' }),
      '0042-sample-rfc.md'
    );

    assert.equal(rfc.evidence, null);
  });
});

describe('validateRfc', () => {
  it('accepts an accepted, implemented RFC with evidence and a fresh date', () => {
    const findings = validateRfc(parseRfc(makeRfc(), '0042-sample-rfc.md'), { today: TODAY });
    assert.deepEqual(findings, []);
  });

  it('rejects an accepted RFC with no implementation status', () => {
    const findings = validateRfc(
      parseRfc(
        makeRfc({ implementationStatus: 'not-applicable', evidence: '—' }),
        '0042-sample-rfc.md'
      ),
      { today: TODAY }
    );

    assert.ok(codes(findings).includes('ACCEPTED_WITHOUT_IMPLEMENTATION_STATUS'));
  });

  it('rejects an implemented claim with no evidence', () => {
    const findings = validateRfc(
      parseRfc(makeRfc({ evidence: '—' }), '0042-sample-rfc.md'),
      { today: TODAY }
    );

    assert.ok(codes(findings).includes('ACCEPTED_WITHOUT_EVIDENCE'));
    assert.ok(codes(findings).includes('MISSING_EVIDENCE'));
  });

  it('flags an implementation claim that was not re-verified in 180 days', () => {
    const findings = validateRfc(
      parseRfc(makeRfc({ lastVerified: '2025-01-01' }), '0042-sample-rfc.md'),
      { today: TODAY }
    );

    assert.ok(codes(findings).includes('STALE_VERIFICATION'));
  });

  it('rejects an implementation status on an unaccepted RFC', () => {
    const findings = validateRfc(
      parseRfc(makeRfc({ status: 'Draft', implementationStatus: 'in-progress' }), '0042-sample-rfc.md'),
      { today: TODAY }
    );

    assert.ok(codes(findings).includes('IMPLEMENTATION_STATUS_ON_UNACCEPTED_RFC'));
  });

  it('accepts a draft with not-applicable and no evidence', () => {
    const findings = validateRfc(
      parseRfc(
        makeRfc({ status: 'Draft', implementationStatus: 'not-applicable', evidence: '—' }),
        '0042-sample-rfc.md'
      ),
      { today: TODAY }
    );

    assert.deepEqual(findings, []);
  });

  it('rejects a file-name/title number mismatch', () => {
    const findings = validateRfc(parseRfc(makeRfc(), '0043-other.md'), { today: TODAY });
    assert.ok(codes(findings).includes('NUMBER_MISMATCH'));
  });

  it('rejects an invalid last-verified date', () => {
    const findings = validateRfc(
      parseRfc(makeRfc({ lastVerified: '20-11-2026' }), '0042-sample-rfc.md'),
      { today: TODAY }
    );

    assert.ok(codes(findings).includes('INVALID_LAST_VERIFIED'));
  });
});

const INDEX_DOC = `# RFC Process

| Number | Title | Status | Implementation status | Last verified |
| --- | --- | --- | --- | --- |
| [0042](../rfcs/0042-sample-rfc.md) | Sample RFC | Accepted | implemented | 2026-11-20 |
`;

describe('parseIndex', () => {
  it('finds the table that has Number and Implementation status columns', () => {
    const rows = parseIndex(INDEX_DOC);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].number, '0042');
    assert.equal(rows[0].status, 'Accepted');
    assert.equal(rows[0].implementationStatus, 'implemented');
    assert.equal(rows[0].lastVerified, '2026-11-20');
  });
});

describe('validateIndex', () => {
  const rfc = parseRfc(makeRfc(), '0042-sample-rfc.md');

  it('accepts an index row that matches the RFC', () => {
    assert.deepEqual(validateIndex(parseIndex(INDEX_DOC), [rfc]), []);
  });

  it('flags a status that disagrees with the RFC file', () => {
    const doc = INDEX_DOC.replace('| Accepted | implemented |', '| Draft | not-applicable |');
    const findings = validateIndex(parseIndex(doc), [rfc]);
    assert.ok(codes(findings).includes('INDEX_STATUS_MISMATCH'));
    assert.ok(codes(findings).includes('INDEX_IMPLEMENTATION_MISMATCH'));
  });

  it('flags an RFC missing from the index', () => {
    const findings = validateIndex([], [rfc]);
    assert.ok(codes(findings).includes('RFC_MISSING_FROM_INDEX'));
  });

  it('flags an index row with no RFC file', () => {
    const findings = validateIndex(parseIndex(INDEX_DOC), []);
    assert.ok(codes(findings).includes('INDEX_ROW_WITHOUT_RFC'));
  });
});

describe('repository audit', () => {
  it('keeps the checked-in RFCs and index consistent', () => {
    const { errors } = auditRepository({ today: TODAY });
    assert.deepEqual(errors, []);
  });
});
