# Contributing

x402 welcomes contributions of schemes, middleware, new chain support, and more. We aim to make x402 as secure and trusted as possible. Merging contributions is at the discretion of the x402 Foundation team, based on the risk of the contribution and the quality of implementation.

## Contents

- [Repository Structure](#repository-structure)
- [Language-Specific Guides](#language-specific-guides)
- [Contributing Workflow](#contributing-workflow)
- [Changelog Tooling](#changelog-tooling)
- [Commit Signing](#commit-signing)
- [Getting Help](#getting-help)

## Repository Structure

The x402 repository contains implementations in multiple languages plus protocol specifications.

```
x402/
├── typescript/          # TypeScript SDK (pnpm monorepo)
├── python/              # Python SDK
├── go/                  # Go SDK
├── java/                # Java SDK
├── specs/               # Protocol specifications
└── examples/            # Example implementations
    ├── typescript/
    ├── python/
    └── go/
```

## Language-Specific Guides

For setup instructions, development workflow, and contribution patterns for each SDK:

- [TypeScript Development Guide](typescript/CONTRIBUTING.md)
- [Python Development Guide](python/CONTRIBUTING.md)
- [Go Development Guide](go/CONTRIBUTING.md)
- [Specifications Guide](specs/CONTRIBUTING.md)

## Contributing Workflow

### 1. Find or Create an Issue

Check existing issues before starting work. For larger features, open a discussion first.

### 2. Fork and Clone

Fork the repository and clone your fork locally.

### 3. Create a Branch

```bash
git checkout -b feature/your-feature-name
```

### 4. Make Changes

- Follow the language-specific development guide
- Write tests for new functionality
- Update documentation as needed

### 5. Test

Run tests for the packages you modified:

```bash
# TypeScript
cd typescript && pnpm test

# Python
cd python/x402 && uv run pytest

# Go
cd go && make test
```

### 6. Submit PR

- Fill out the PR template completely
- Link related issues
- Ensure CI passes

## Changelog Tooling

For **user-facing changes** (behavior changes, bug fixes, new features, breaking changes), add a changelog fragment for the SDK(s) you modified. Docs-only changes and internal refactors that do not affect users can skip fragments.

- **TypeScript**: Changesets fragments in `typescript/.changeset/*.md`
  - Create: `pnpm -C typescript changeset`
- **Go**: Changie fragments in `go/.changes/unreleased/*`
  - Create: `make -C go changelog-new`
- **Python (python/x402 v2)**: Towncrier fragments in `python/x402/changelog.d/<PR>.<type>.md`
  - Create (example): `cd python/x402 && uv run towncrier create --content "Fixed ..." 123.bugfix.md`

## Commit Signing

All commits must be [signed](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits). Configure commit signing before submitting:

```bash
git config --global commit.gpgsign true
```

## Paywall Changes

The paywall is a browser UI component that exists across TypeScript, Go, and Python. If you modify paywall source files in TypeScript:

```bash
cd typescript && pnpm --filter @x402/paywall build:paywall
```

This generates template files in:
- `typescript/packages/http/paywall/src/evm/gen/template.ts`
- `typescript/packages/http/paywall/src/svm/gen/template.ts`
- `go/http/evm_paywall_template.go`
- `go/http/svm_paywall_template.go`
- `python/x402/src/x402/evm_paywall_template.py`
- `python/x402/src/x402/svm_paywall_template.py`

Commit the generated files with your PR.

## New Schemes

Schemes dictate how funds are moved from client to server. New schemes require thorough review by the x402 Foundation team.

Recommended approach:

1. Propose a scheme by opening a PR with a spec in `specs/schemes/`
2. Discuss the architecture and purpose in that PR
3. Once the spec is merged, proceed to implementation

See [specs/CONTRIBUTING.md](specs/CONTRIBUTING.md) for spec writing guidelines.

## New Chains

x402 aims to be chain-agnostic. New chain implementations are welcome.

Because different chains have different best practices, a scheme may have a different mechanism on a new chain than it does on EVM. If the scheme mechanism varies from the reference implementation, the x402 Foundation will re-audit the scheme for that chain before accepting.

### Adding a Default Asset for an EVM Chain

If your chain is EVM-compatible and you want to add a default stablecoin for
dollar-string pricing (`"$0.10"`), you don't need the full 3-PR workflow below. See
[DEFAULT_ASSETS.md](DEFAULT_ASSETS.md) for instructions.

### Adding a New Chain Family

### PR 1: Specification Only

Open a PR with specs for one payment scheme implementation.

- Add `specs/schemes/<scheme>/scheme_<scheme>_<chain>.md`
- Follow existing spec format, see [`scheme_exact_evm.md`](specs/schemes/exact/scheme_exact_evm.md)
- Must include: payload structure, verification logic and settlement logic, see [specs/CONTRIBUTING.md](specs/CONTRIBUTING.md) for further spec writing guidelines

### PR 2: Reference Implementation

After spec approval, implement in a **single SDK** (TypeScript, Python OR Go).

**Package structure:**
- Create `<sdk>/packages/mechanisms/<chain>/` (TS) or `<sdk>/mechanisms/<chain>/` (Py/Go)
- Do not modify core packages

**Required interfaces per SDK:**

| SDK | Interfaces |
|-----|------------|
| TypeScript (`@x402/core`) | `SchemeNetworkClient`, `SchemeNetworkServer`, `SchemeNetworkFacilitator` |
| Go (`github.com/x402-foundation/x402/go`) | `ClientScheme`, `ServerScheme`, `FacilitatorScheme` |
| Python (`x402`) | `SchemeNetworkClient`, `SchemeNetworkServer`, `SchemeNetworkFacilitator` |

**Required tests:**

| Type | Purpose | Reference |
|------|---------|-----------|
| Unit | Isolated component tests | [`typescript/packages/mechanisms/evm/test/unit/`](typescript/packages/mechanisms/evm/test/unit/) |
| Integration | Client/server/facilitator flow | [`typescript/packages/mechanisms/evm/test/integrations/`](typescript/packages/mechanisms/evm/test/integrations/) |
| E2E | Full stack across SDKs | [`e2e/`](e2e/) |

**Examples:**
- Keep existing user-facing examples minimal
- Add your chain (in alphabetic order by network prefix) to `examples/<sdk>/*/advanced/all_networks` for server, client and facilitator

**Further steps:**
- Add package publishing workflow in [`.github/workflows/`](.github/workflows/) following existing patterns
- Add READMEs for new packages, see [`typescript/packages/mechanisms/evm/README.md`](typescript/packages/mechanisms/evm/README.md)
- Gitdocs in [`docs/`](docs/) will be automatically updated by Mintlify

### PR 3: Additional SDK Implementations

After the reference implementation is merged, you may follow up with other SDK implementations.

## Middleware and HTTP Integrations

HTTP middleware packages should:

- Follow best practices for the target framework
- Include tests
- Follow x402 client/server patterns from existing middleware

## Examples

Examples for each SDK live in `examples/`:

```
examples/
├── typescript/    # TypeScript examples
├── python/        # Python examples
└── go/            # Go examples
```

When adding a new example, follow the patterns in the language-specific guide.

## Getting Help

- Search existing issues
- Open a new issue with questions
- Check the language-specific guides for common patterns
