<!--
Thanks for contributing to x402!
Please fill out the information below to help reviewers understand your changes.

Note: We require commit signing.
See here for instructions: https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification
-->

## Description

<!--
Please provide a clear and concise description of what the changes are, and why they are needed.
Include a link to the issue this PR addresses, if applicable (e.g. "Closes #123").
-->

## Tests

<!--
Please describe the tests you've performed to verify your changes.
Include relevant code samples, unit test cases, or screenshots if applicable.

For TypeScript: Run `pnpm test` from the `/typescript` directory
For Python: Run `uv run pytest` from the `python/x402/` directory
For Go: Run `go test ./...` from the `/go` directory
-->

## Checklist

- [ ] I have formatted and linted my code
- [ ] All new and existing tests pass
- [ ] My commits are signed (required for merge) -- you may need to rebase if you initially pushed unsigned commits
- [ ] I added a changelog fragment for user-facing changes (docs-only changes can skip)

<!--
Changelog fragments (required for user-facing changes):

- TypeScript: add a Changesets file under `typescript/.changeset/*.md`
  - Create: `pnpm -C typescript changeset`
  - Select only publishable `@x402/*` packages
- Go: add a Changie fragment under `go/.changes/unreleased/*`
  - Create: `make -C go changelog-new`
- Python (python/x402 v2): add a Towncrier fragment under `python/x402/changelog.d/<PR>.<type>.md`
  - Create: `cd python/x402 && uv run towncrier create --content "Fixed ..." 123.bugfix.md`
-->

<!--
For TypeScript: Run `pnpm format && pnpm lint` from `/typescript` and/or `/examples/typescript`
For Python: Run `uvx ruff format && uvx ruff check` from the `python/x402/` directory
For Go: Run `go fmt ./...` and `go vet ./...` from the `/go` directory
--> 