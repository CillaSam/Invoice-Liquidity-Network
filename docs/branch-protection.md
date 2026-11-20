# Branch protection for `main` and `dev`

This document records the branch protection that is **actually configured** on
the repository, the rules that were previously assumed, and the gaps a
maintainer still needs to close. It covers both long-lived branches because the
default branch is `dev`.

> **Last audited:** 2026-11-20, against the GitHub REST API for
> `Invoice-Liquidity-Network/Invoice-Liquidity-Network`:
> `/branches/{branch}/protection`, `/rulesets`, and `/rulesets/{id}`.
> Re-run the commands in [Verification](#verification) before relying on this
> table; a GitHub setting is not versioned with the code.

## Verified live configuration

| Setting | `main` | `dev` |
| --- | --- | --- |
| Repository default branch | No | **Yes** |
| Legacy branch protection (`/branches/{branch}/protection`) | Not configured (HTTP 404) | Not configured (HTTP 404) |
| Active repository rulesets covering the branch | `Require malware indicators check` | `Require malware indicators check` |
| Required status checks | `malware indicators` (GitHub Actions, integration `15368`) | same |
| Strict "require branches to be up to date" | `false` | `false` |
| "Do not enforce on create" | `false` | `false` |
| Pull-request review requirement | **None** | **None** |
| Dismiss stale approvals | **None** | **None** |
| Require linear history | **None** | **None** |
| Restrict deletions | **None** | **None** |
| Restrict force pushes | **None** | **None** |
| Bypass actors on the active ruleset | **None** (`bypass_actors: []`; `current_user_can_bypass: never`) | same |

A second repository ruleset named `main` exists but is **disabled**. It would
block deletions and non-fast-forward pushes if enabled, and it has no ref
conditions and no bypass actors. Because enforcement is `disabled`, it currently
has no effect on either branch.

Organization-level rulesets could add further rules. They were not audited:
`GET /orgs/Invoice-Liquidity-Network/rulesets` requires the `admin:org` token
scope, which the audit token did not have. No claim is made about them.

### What this means

The only merge gate currently enforced by GitHub is the `malware indicators`
check. Direct pushes, force pushes, branch deletion, unreviewed merges, and
non-linear history are **not blocked by repository rules** on `dev` or `main`.
CODEOWNERS exists and covers the main areas, but without a review requirement it
is advisory only.

## Drift from the previous version of this document

| Previous claim | Verified state (2026-11-20) | Risk |
| --- | --- | --- |
| Protection is configured on `main` | No legacy protection on `main`; its ruleset is disabled | History deletion/rewrite is possible |
| At least 1 approval and CODEOWNERS review required | No review rule in any active ruleset | Unreviewed merges are possible |
| Stale approvals are dismissed | Not configured | Stale review state after new commits |
| Linear history is required | Not configured | Merge commits and non-linear history allowed |
| Force pushes are restricted | Not configured on `dev`; `main` ruleset disabled | Destructive rewrites are possible |
| Long list of required checks (`CI / Node.js coverage (≥80%)`, `Coverage / Run tests and collect coverage`, `CI / Core · format`, …) | Only `malware indicators` is required | Most documented gates are advisory at merge time |
| `scripts/verify-branch-protection.sh` checks the documented rules | The script reads only the legacy `/protection` endpoint, which returns 404 here | The script cannot see rulesets and exits 1 without diagnosing the real state |

The check names in the previous list have also drifted from the workflows:
`node-coverage` no longer exists as a CI job, and coverage is now split across
several jobs in `coverage.yml` (see below). A required-check list must be
re-derived from the workflow files, not copied forward.

## Checks that currently run on pull requests

This is an inventory, not a required-check list. "Always" means the workflow has
no path filter; "path-filtered" means the job is absent from unrelated PRs.

| Workflow | Check context | PR trigger | Notes |
| --- | --- | --- | --- |
| `CI` | `CI / Run Node.js tests` | Always | Always runs |
| `CI` | `CI / Shared package type tests` | Always | `tsc` + `tsd` over `packages/shared` |
| `CI` | `CI / Dependency license compliance check` | Always | License gate |
| `CI` | `CI / Core · install` | Always | Setup only |
| `CI` | `CI / Core · format` | Always | Format/Prettier diff gate |
| `CI` | `CI / Core · lint` | **Push only** | `if: github.event_name == 'push'` |
| `CI` | `CI / Core · type-check` | **Push only** | `if: github.event_name == 'push'` |
| `CI` | `CI / Core · test`, `CI / Core · build` | **Skipped on PRs** | Depend on the push-only lint/type-check jobs |
| `CI` | `CI / Run tests`, `CI / Build contract`, `CI / Lint code`, `CI / SDK types in sync` | Path-filtered | Only when `backend/**` or `.gitmodules` change |
| `CI` | `CI / Validate package.json consistency`, `CI / Guard against non-pnpm lockfiles`, `CI / Dependency version consistency`, `CI / Monorepo map drift check`, `CI / Cross-repo version compatibility check`, `CI / SDK RC pack smoke (#1212)`, `CI / Secret scanning` | Path-filtered or always | Advisory unless required |
| `Coverage` | `Coverage / Rust coverage (backend)`, `Coverage / Node.js coverage (notifications)`, `Coverage / Node.js coverage (SDK)`, `Coverage / Node.js coverage (oracle-service, 95% gate)`, `Coverage / Node.js coverage (CLI)`, `Coverage / Node.js coverage (Indexer)` | Always/path-filtered | Old single `Run tests and collect coverage` job no longer exists |
| `CodeQL Analysis` | `CodeQL Analysis / Analyze (typescript)` and `Analyze (rust)` | Always | Matrix job name is `Analyze (<language>)` |
| `PR title lint` | `PR title lint / lint` | Always | Conventional-title gate |
| `Dead Code Check` | `Dead Code Check / knip` | Always | Dead-code gate |
| `Malware Indicators` | `malware indicators` | Always | **The only currently required check** |

`E2E Nightly` is scheduled and `E2E Integration` depends on the `RUN_E2E`
repository variable; neither is a merge-time gate. SDK, changeset, scripts, and
release jobs are path-filtered and should be required only when their paths are
relevant.

## Recommended target configuration

The following is the intended end state. It is a recommendation, not a
description of live settings.

### Reviews and history (both `main` and `dev`)

1. Require a pull request before merging.
2. Require at least **1 approving review**.
3. Require review from **CODEOWNERS**.
4. Dismiss stale approvals when new commits are pushed.
5. Require linear history.
6. Block deletions and force pushes.
7. Do **not** grant a blanket administrator bypass (see
   [Administrator exceptions](#administrator-exceptions)).

### Required status checks

Start with checks that run on every PR and cannot be path-filtered away:

```
malware indicators
CI / Run Node.js tests
CI / Shared package type tests
CI / Dependency license compliance check
CI / Core · install
CI / Core · format
PR title lint / lint
Dead Code Check / knip
CodeQL Analysis / Analyze (typescript)
```

Add backend-only checks (`CI / Run tests`, `CI / Build contract`,
`CI / Lint code`, `CI / SDK types in sync`) only if the ruleset supports
"required when present" semantics, or if the branch is protected against missing
checks. A path-filtered check that is unconditionally required will block every
PR that does not touch `backend/`.

Coverage gates should be required per component only if their workflows are
reliable on unrelated PRs. The oracle 95% gate is the strictest and is the one
most worth enforcing; the other coverage jobs may be better as advisory checks
until their path filters are settled.

### The `dev` default branch

Because `dev` is the default branch, protect it at least as strictly as `main`.
The previous version of this document protected only `main`, which left the
branch that receives most merges with no review or history rules. If the team
intends to keep `main` as a release-only branch, its disabled ruleset should be
enabled or removed so the repository does not present a protection that does not
exist.

## Gaps and flags for maintainer attention

### 1. No review requirement (highest risk)

CODEOWNERS is present and covers `sdk/`, `docs/`, `scripts/`,
`.github/workflows/`, `SECURITY.md`, and a catch-all. Without a review rule it
does not block anything. Enabling one review plus CODEOWNERS is the single
highest-value change in this audit.

### 2. Core lint and type-check still skip pull requests

`core-lint` and `core-type-check` in `ci.yml` still carry
`if: github.event_name == 'push'`. As a result `core-test` and `core-build`
(which depend on them) are skipped on PRs. Type errors and lint violations can
reach `dev` and are only caught afterwards.

**Recommended fix:** remove those `if:` conditions, then add
`CI / Core · lint` and `CI / Core · type-check` to the required checks once the
jobs are known to pass on PRs.

### 3. Active ruleset has no bypass, but administrators can edit rules

The active malware ruleset reports `bypass_actors: []` and
`current_user_can_bypass: never`. That is the desired posture: no role or team
can merge past the check. It does not prevent organization owners from editing
or disabling the ruleset itself. Protecting ruleset administration is an
organization-level control and is outside what this repository's API token can
verify.

### 4. Required checks on path-filtered jobs

If `CI / Run tests`, `CI / Build contract`, `CI / Lint code`, or
`CI / SDK types in sync` are added as unconditional required checks, PRs that do
not touch `backend/` will wait forever for checks that never start. Configure
the ruleset to evaluate them only when present, or do not require them globally.

### 5. The verification script is legacy-only

`scripts/verify-branch-protection.sh` calls the legacy
`/branches/{branch}/protection` endpoint. That endpoint returns 404 for both
branches, so the script exits 1 without inspecting the active ruleset. Treat its
output as "legacy protection is absent", not as a complete audit. Use the
commands below until the script is extended to read `/rulesets`.

## Administrator exceptions

- **Active ruleset:** no bypass actors. No user, team, or app is exempt from
  `malware indicators`; the authenticated auditor itself reports
  `current_user_can_bypass: never`.
- **Disabled `main` ruleset:** no bypass actors either, but this is moot while
  enforcement is disabled.
- **Recommendation:** keep the bypass list empty, or limit it to a single
  audited release automation identity. Every bypass use should be recorded in
  the PR or release ticket, and the list should be reviewed quarterly. A blanket
  "repository admin" bypass makes the rules advisory.
- **Not verified:** organization-level rulesets and organization owner
  permissions; the audit token lacks `admin:org`.

## Verification

```bash
REPO=Invoice-Liquidity-Network/Invoice-Liquidity-Network

# Legacy protection (404 here means "not configured", not "no rules at all")
gh api "repos/$REPO/branches/dev/protection"
gh api "repos/$REPO/branches/main/protection"

# Repository rulesets: list, then inspect each id
gh api "repos/$REPO/rulesets"
gh api "repos/$REPO/rulesets/26396203"   # Require malware indicators check (active)
gh api "repos/$REPO/rulesets/20285608"   # main (disabled)

# Default branch and merge settings
gh api "repos/$REPO" --jq '{default_branch, allow_merge_commit, allow_squash_merge, allow_rebase_merge}'
```

Compare the `rules[].type` and `rules[].parameters.required_status_checks`
values with the tables above. A change to `conditions.ref_name.include` can
narrow a ruleset to one branch without changing its `enforcement` value, so
check both.

> `scripts/verify-branch-protection.sh <owner> <repo> [branch]` remains useful
> only for repositories still using the legacy branch-protection API. Do not add
> it to CI for this repository in its current form.
