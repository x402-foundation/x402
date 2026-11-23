---
name: contributing
description: Guidelines and conventions for contributing to the x402 codebase. Use when preparing a PR to the upstream x402-foundation/x402 repository such as fixing a bug or Issue, implementing a new feature, adding a mechanism/scheme or extension.
---

# Contributing to x402

## Reuse before writing new code

- Before writing anything, check in order whether the standard library (TS: ECMAScript and Node.js built-ins like `node:crypto`; Python: the stdlib; Go: packages like `net/http`, `encoding/json`, `crypto`), a native platform feature, or an already-installed dependency already does it; if so, use it.
- Always reuse shared and core utilities.
- No new dependencies if it can be avoided.

## Keep changes minimal

- Address a single issue per contribution, not multiple.
- Targeted edits, minimal diff, atomic commits.
- No abstractions or boilerplate that were not explicitly requested.
- No edits to legacy/v1 code; it is effectively frozen (security patches, and fixes that bring one SDK back in line with the others). This includes the paths `typescript/packages/legacy/`, `go/legacy`, `python/legacy` and the `java/` SDK.

## Code style

- Write clean, readable code (e.g. prefer guard clauses over nested conditionals, use descriptive names and small, single-purpose functions).
- Strong typing, avoid any weak types (`any`, `unknown`, and their equivalents in other languages). Research the codebase to find the correct type, reuse existing type definitions rather than redeclaring them and confirm no type errors remain.
- No overly defensive code or silent fallbacks.
- Apply DRY only where it reduces complexity; keep single-use logic inline rather than extracting a helper for it.

## SDK design

- Core packages never import mechanism or extension packages, and core holds no logic specific to one extension, network, or facilitator.
- Hooks may add data but never change data the protocol owns, and they run only for routes that opted in. A `before*` hook that throws fails closed; `after*` and failure hooks cannot change the outcome.
- A facilitator answers malformed client input with `isValid: false` and a stable reason code, never an HTTP 5xx. Payer-facing messages never include internal error text such as RPC URLs or storage errors.
- Reason codes are shared across SDKs: never change one without changing it in all three.
- A handler declines a paid request by returning a status of 400 or higher; any lower status settles.
- Protocol data travels in headers. The response body is the server's to define.
- New options keep the current behavior as the default. Anything with a tradeoff is opt-in, and a changed default needs an opt-out and a note in the changeset.
- No implicit fallbacks to public RPC or indexer endpoints; make them configurable.
- The same payload must produce the same outcome in TypeScript, Go and Python. Port fixes to shared behavior to the other SDKs (one SDK per PR is fine).

## Neutrality

- Keep code, docs, examples and e2e tests free of any specific facilitator, vendor, or third-party service. Limits or behavior specific to one facilitator belong in that facilitator's docs, not in the SDK.
- Third-party SDKs are not added to the e2e harness.
- The public `x402.org` facilitator is for testnets only.
- The ecosystem page no longer accepts submissions. Third-party extensions and utilities are listed in [`docs/dev-tools/third-party-extensions.md`](../../../docs/dev-tools/third-party-extensions.md): only packages that read or write `extensions` go in the extensions table.
- Supporting a new EVM chain needs no code change. To enable `$` prices on it, add a USD-pegged default asset in all three SDKs per [DEFAULT_ASSETS.md](../../../DEFAULT_ASSETS.md), with values checked against the deployed contract.

## Comments

- Write comments that help a new reader understand the codebase.
- Never narrate in-progress work or describe code being replaced.
- Write onchain - never "on-chain" or "on chain".
- Describe only this SDK's current behavior; don't reference other SDKs, commits, or issue numbers.
- Don't change/remove existing comments, unless strictly needed due to code changes.

## AI-assisted contributions

Follow the repository AI-assisted contribution policy in [CONTRIBUTING.md](../../../CONTRIBUTING.md#ai-assisted-contributions). Review all AI-generated output before requesting maintainer review.

- Say in the PR description who verified the change and how.
- Open a few verified PRs, not many generated ones. Batch submissions and automated status comments get PRs closed.

## Working on an Issue

- Search open PRs and issues first. Duplicates are closed; if a PR already covers the change, review or comment there instead.
- Independently reproduce and verify the Issue first, on current `main`.
- Hardening, diagnostics, or options without a demonstrated problem are not merged.
- For spec-shaped or cross-cutting changes, make the case in an Issue before writing code, then open one minimal, standalone PR rather than several linked ones.
- When in doubt, ask clarifying questions on the Issue before writing code.

## Bug fixes

- Add a test that fails before the fix and passes after it.
- Don't write tests for what the type system already guarantees, or tests that only restate hard-coded constants.
- Cover edge cases, not only happy path.

## Commits and PRs

- Verifying (signing) ALL commits is strictly required; maintainers will not check a PR otherwise. See [GitHub: about commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).
- PR description: short and matching the diff; explain what and why; link relevant issues; state the root cause in one paragraph, citing file and line.
- Justify design decisions where there were ambiguities and discuss the tradeoffs of the approach you picked against the alternatives you considered.
- Keep the branch up to date with `main` by rebasing locally; resolving conflicts in the GitHub UI creates an unsigned merge commit.
- Reviewers run examples and e2e tests: document faucets, environment variables, and realistic timeouts.
- Don't commit binaries, planning notes, or unrelated lockfile changes, and leave release workflows alone.
- Respond to review; inactive PRs are closed. To resume, ask in the closed PR rather than opening a new one.

## Per-language

### Per commit: format, lint, build, test

Format, lint, build, and run unit tests before each commit.

```bash
# TypeScript (from typescript/)
pnpm format && pnpm lint && pnpm build && pnpm test

# Go (from go/)
make fmt && make lint && make build && make test

# Python (from python/x402/)
uvx ruff format && uvx ruff check && uv run pytest
```

### Per PR: changelog

Add a changelog fragment for the SDK you changed. Use `patch` for non-breaking changes (including new default assets) and `minor` for breaking changes within an x402 version; `major` is reserved for x402 major versions. Mark breaking changes as breaking in the fragment, including changes to storage interfaces that operators implement.

```bash
# TypeScript (from typescript/)
pnpm changeset

# Go (from go/)
make changelog-new

# Python (from python/x402/)
uv run towncrier create --content "Fixed ..." <PR>.bugfix.md
```

## New mechanism or extension

- New payment mechanism / scheme: see [references/new-mechanism.md](references/new-mechanism.md).
- New extension: see [references/new-extension.md](references/new-extension.md).
