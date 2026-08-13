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
- No edits to legacy/v1 code; it is effectively frozen (security patches only). This includes the paths `typescript/packages/legacy/`, `go/legacy`, `python/legacy` and the `java/` SDK.

## Code style

- Write clean, readable code (e.g. prefer guard clauses over nested conditionals, use descriptive names and small, single-purpose functions).
- Strong typing, avoid any weak types (`any`, `unknown`, and their equivalents in other languages). Research the codebase to find the correct type, reuse existing type definitions rather than redeclaring them and confirm no type errors remain.
- No overly defensive code or silent fallbacks.
- Apply DRY only where it reduces complexity; keep single-use logic inline rather than extracting a helper for it.

## Comments

- Write comments that help a new reader understand the codebase.
- Never narrate in-progress work or describe code being replaced.
- Write onchain - never "on-chain" or "on chain".
- Don't change/remove existing comments, unless strictly needed due to code changes.

## AI-assisted contributions

Follow the repository AI-assisted contribution policy in [CONTRIBUTING.md](../../CONTRIBUTING.md#ai-assisted-contributions). Review all AI-generated output before requesting maintainer review.

## Working on an Issue

- Independently reproduce and verify the Issue first.
- When in doubt, ask clarifying questions on the Issue before writing code.

## Bug fixes

- Add a test that fails before the fix and passes after it.
- Don't write tests for what the type system already guarantees.
- Cover edge cases, not only happy path.

## Commits and PRs

- Verifying (signing) ALL commits is strictly required; maintainers will not check a PR otherwise. See [GitHub: about commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).
- PR description: short and matching the diff; explain what and why; link relevant issues; state the root cause in one paragraph, citing file and line.
- Justify design decisions where there were ambiguities and discuss the tradeoffs of the approach you picked against the alternatives you considered.

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

Add a changelog fragment for the SDK you changed.

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
