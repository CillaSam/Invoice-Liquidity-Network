# RFC Process

Significant changes to ILN — new token types, fee model changes, governance redesigns, new contract mechanics — require community discussion before engineering begins. The RFC (Request for Comments) process provides a consistent, transparent path for proposing and deciding on those changes.

Minor changes (bug fixes, documentation, small SDK improvements) do not need an RFC. Use the normal issue and PR flow described in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## When to write an RFC

Write an RFC if the change:

- modifies the on-chain contract interface or data model
- introduces or removes a token or fee mechanism
- changes how governance works
- has significant cross-repo impact (contract + SDK + frontend)
- is large enough that reversing it after deployment would be costly

If you are unsure, open a GitHub Discussion first. Maintainers will tell you whether an RFC is needed.

---

## Lifecycle

```
Draft → Open for Comment (≥ 2 weeks) → Final Comment Period (1 week) → Accepted / Rejected
```

| Status | Meaning |
|--------|---------|
| **Draft** | Author is writing. Not yet ready for community review. |
| **Open for Comment** | PR is open. Community feedback is actively collected. Minimum two weeks. |
| **Final Comment Period** | No major open questions remain. One week for last objections before a decision. |
| **Accepted** | Approved by maintainers. Implementation may begin. |
| **Rejected** | Not approved. The RFC is closed with a recorded reason. |

The status is updated in the RFC file itself as it progresses. Maintainers move an RFC into Final Comment Period by updating the status and leaving a comment on the PR.

---

## Submitting an RFC

1. Copy `rfcs/0000-template.md` to `rfcs/0000-your-feature-name.md`. Keep the number `0000` until a maintainer assigns the next available number.
2. Fill in all sections. Placeholders are not acceptable for an Open for Comment submission.
3. Open a PR against `dev` (the repository default branch) with the branch name `rfc/your-feature-name`.
4. A maintainer will assign the RFC number, rename the file (e.g. `0002-your-feature-name.md`), and update the status to **Open for Comment**.
5. Discussion happens in the PR comments. The author is expected to update the RFC in response to significant feedback.
6. After the Final Comment Period, maintainers record a decision in the PR and either merge (Accepted) or close (Rejected) it.

---

## After acceptance

An accepted RFC becomes the source of truth for the implementation, so its
implementation status is part of the RFC, not a note that can be forgotten. The
implementing PR should reference the RFC number and note any deviations that
arose during engineering. If a deviation is significant, reopen discussion on
the RFC before merging the implementation.

### Implementation-status enforcement

Every RFC file carries three header fields in addition to `Status`:

```markdown
- **Implementation status:** not-started
- **Implementation evidence:** #1234; sdk/src/client.ts
- **Last verified:** 2026-11-20
```

| Implementation status | Meaning | Required evidence |
| --- | --- | --- |
| `not-applicable` | The RFC is not accepted, so there is nothing to implement | None |
| `not-started` | Accepted, no implementation work merged yet | Tracking issue(s) or a PR that starts it |
| `in-progress` | Some implementation merged, RFC not fully satisfied | PR(s), issue(s), or code path |
| `implemented` | The accepted design is implemented | PR(s) or the code path that implements it |
| `deferred` | Accepted but deliberately postponed | The decision/issue recording the deferral |

The rules, enforced by `node scripts/check-rfc-status.mjs` in CI:

1. An **accepted** RFC must not be `not-applicable` and must name evidence.
2. Any implementation claim other than `not-applicable` must name evidence; a
   bare `—` is treated as missing.
3. An `implemented` or `in-progress` claim must have a `Last verified` date no
   more than **180 days** old. This is the anti-divergence control: a claim that
   nobody has checked against the code stops passing CI.
4. A non-accepted RFC must use `not-applicable`. Implementation work that begins
   before acceptance is a process failure, not a status to record.
5. Every RFC must appear exactly once in the index below, with the same status,
   implementation status, and last-verified date as its file.

When implementation diverges, fix the RFC in the same PR as the code change:
update the status, evidence, and `Last verified` date, or open an amendment RFC
if the design itself changed. Do not leave "Accepted" standing next to code
that no longer matches it.

Run the check locally with:

```bash
pnpm check:rfc-status
pnpm test:rfc-status
```

---

## Retrospective RFCs and policy debt

Not every material decision is recorded before it is merged. When a decision has already been made, but it is clearly policy- or governance-scale, maintainers may still open a retrospective RFC to document it after the fact. This is required when the change:

- alters governance assumptions or threshold parameters;
- creates a cross-repo authority or rollout policy;
- changes canonical docs or standards that other teams rely on; or
- would be costly to reverse, even if it was implemented as an operational patch.

A retrospective RFC must state:

1. what decision was made;
2. why the normal RFC path was skipped;
3. whether the decision was intended to be temporary or durable;
4. what risk or trade-off was accepted; and
5. what process tightening prevents recurrence.

Maintainers should label such PRs as policy or governance changes, and reviewers should require either a linked RFC or an explicit retrospective RFC before approving material changes that affect broader protocol risk.

---

## RFC index

The index is checked against the RFC files; update the row whenever a field in
the RFC header changes.

| Number | Title | Status | Implementation status | Last verified | Tracking issues |
|--------|-------|--------|-----------------------|---------------|-----------------|
| [0001](../rfcs/0001-dutch-auction-funding.md) | Dutch Auction Funding | Accepted | in-progress | 2026-11-20 | #6, #7, #8, #10 |
| [0002](../rfcs/0002-package-naming-convention.md) | Package Naming Convention | Draft | not-applicable | 2026-11-20 | — |
| [0003](../rfcs/0003-rfc-process-retrospective-audit.md) | RFC Process Retrospective Audit | Accepted | implemented | 2026-11-20 | #1119 |
