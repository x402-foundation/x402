# TypeScript SDK Contributing Guide

Guide for developing and contributing to the x402 TypeScript SDK.

## Contents

- [Repository Structure](#repository-structure)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Adding Features](#adding-features)
- [Testing](#testing)
- [Code Quality](#code-quality)

## Repository Structure

The TypeScript SDK is a pnpm workspace managed with Turborepo.

```
typescript/
├── packages/
│   ├── core/              # @x402/core - Protocol implementation
│   ├── mechanisms/
│   │   ├── evm/           # @x402/evm - Ethereum/EVM chains
│   │   └── svm/           # @x402/svm - Solana
│   ├── http/
│   │   ├── axios/         # @x402/axios - Axios interceptor
│   │   ├── express/       # @x402/express - Express middleware
│   │   ├── fetch/         # @x402/fetch - Fetch wrapper
│   │   ├── hono/          # @x402/hono - Hono middleware
│   │   ├── next/          # @x402/next - Next.js integration
│   │   └── paywall/       # @x402/paywall - Browser paywall UI
│   ├── extensions/        # @x402/extensions - Bazaar, Sign-in-with-x
│   └── legacy/            # Legacy v1 packages (deprecated)
├── site/                  # x402.org marketing site
├── turbo.json
└── pnpm-workspace.yaml
```

### Package Dependencies

```
@x402/core
    ↑
@x402/evm, @x402/svm
    ↑
@x402/express, @x402/hono, @x402/next, @x402/axios, @x402/fetch
```

The core package provides transport-agnostic primitives. Mechanism packages (`evm`, `svm`) implement chain-specific logic. HTTP packages provide framework integrations.

## Development Setup

### Prerequisites

- Node.js >= 18.0.0
- pnpm >= 10.7.0

### Installation

```bash
cd typescript
pnpm install
```

### Build

```bash
# Build all packages
pnpm build

# Build a specific package
pnpm --filter @x402/core build
```

## Development Workflow

### Watch Mode

For active development, use watch mode in the package you're working on:

```bash
cd packages/core
pnpm test:watch
```

### Common Commands

From the `typescript/` directory:

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages |
| `pnpm test` | Run unit tests |
| `pnpm test:integration` | Run integration tests |
| `pnpm lint` | Lint and fix |
| `pnpm lint:check` | Check linting (CI) |
| `pnpm format` | Format code |
| `pnpm format:check` | Check formatting (CI) |

### Working on a Single Package

```bash
cd packages/mechanisms/evm
pnpm build
pnpm test
pnpm test:watch  # Watch mode
```

## Adding Features

### Adding HTTP Middleware

To add a new HTTP framework integration:

1. Create a new package in `packages/http/`:

```bash
mkdir -p packages/http/your-framework
cd packages/http/your-framework
```

2. Create `package.json`:

```json
{
  "name": "@x402/your-framework",
  "version": "0.1.0",
  "main": "./dist/cjs/index.js",
  "module": "./dist/esm/index.js",
  "types": "./dist/cjs/index.d.ts",
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . --ext .ts --fix",
    "lint:check": "eslint . --ext .ts",
    "format": "prettier -c .prettierrc --write \"**/*.{ts,js,cjs,json,md}\"",
    "format:check": "prettier -c .prettierrc --check \"**/*.{ts,js,cjs,json,md}\""
  },
  "dependencies": {
    "@x402/core": "workspace:*"
  }
}
```

3. Copy `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, and `eslint.config.js` from an existing HTTP package.

4. Implement the adapter pattern. See `packages/http/express/src/adapter.ts` for reference.

### Adding a New Chain Mechanism

See [New Chains](../CONTRIBUTING.md#new-chains) in the root contributing guide for protocol-level requirements and interface definitions.

To add support for a new blockchain in TypeScript:

1. Create a new package in `packages/mechanisms/`:

```bash
mkdir -p packages/mechanisms/your-chain
```

2. Implement the required interfaces from `@x402/core`:
   - `SchemeNetworkClient` - Signs payment payloads
   - `SchemeNetworkServer` - Validates payment requirements
   - `SchemeNetworkFacilitator` - Verifies and settles payments

3. Export registration helpers:

```typescript
// src/exact/client/register.ts
export function registerExactYourChainScheme(
  client: x402Client,
  config: { signer: YourChainSigner; networks?: Network | Network[] }
) {
  const networks = config.networks ?? 'yourchain:*';
  const scheme = new ExactYourChainScheme(config.signer);
  // ... register with client
}
```

4. Follow the existing `@x402/evm` or `@x402/svm` package structure.

### Adding Extensions

Extensions go in `packages/extensions/`. Each extension should:

1. Have its own subdirectory in `src/`
2. Export from the package's main `index.ts`
3. Include a README documenting usage

## Testing

### Unit Tests

```bash
# All packages
pnpm test

# Single package
pnpm --filter @x402/evm test

# Watch mode
cd packages/mechanisms/evm
pnpm test:watch
```

### Integration Tests

Integration tests require network access and may use testnets:

```bash
pnpm test:integration
```

Or for a specific package:

```bash
pnpm --filter @x402/evm test:integration
```

### Test File Organization

```
packages/core/
├── src/
└── test/
    ├── unit/           # Unit tests
    ├── integrations/   # Integration tests
    └── mocks/          # Shared test utilities
```

## Code Quality

### Linting

ESLint with TypeScript rules:

```bash
# Fix issues
pnpm lint

# Check only (for CI)
pnpm lint:check
```

### Formatting

Prettier handles formatting:

```bash
# Format files
pnpm format

# Check formatting (for CI)
pnpm format:check
```

### TypeScript

- Strict mode enabled
- Export types alongside implementations
- Use Zod for runtime validation of external data

## Paywall Changes

The paywall package (`packages/http/paywall/`) contains browser-rendered UI components. See [Paywall Changes](../CONTRIBUTING.md#paywall-changes) in the root contributing guide for build instructions and generated file locations.

## Examples

Examples live in `examples/typescript/`. When adding a new example:

1. Create a directory under the appropriate category
2. Add a `package.json` with the example's dependencies
3. Add a `README.md` with setup and run instructions
4. The example will be included in the workspace automatically via `pnpm-workspace.yaml`

## Changelog

A changeset is required for any change that should be published — this includes code changes, public API or type changes, and documentation updates that affect published packages. To create a changeset, run:

```bash
pnpm changeset
```

Follow the interactive prompts to:
1. Select the packages that should be published.
2. Provide a short, past‑tense summary of the change (for example, "Fixed bug where X failed" or "Added support for Y").
3. Pick the appropriate release type:
   - Patch: Bug fixes, no API changes
   - Minor: New features, backward compatible
   - Major: Breaking changes

When unsure, prefer a patch for fixes and a minor for non‑breaking features; maintainers may adjust bumps during review and release.

## Publishing

Package publishing is handled by maintainers. Version bumps follow semver:

- Patch: Bug fixes, no API changes
- Minor: New features, backward compatible
- Major: Breaking changes

## Getting Help

- Open an issue on GitHub
- Join the discussion in existing issues
- Check the [examples](../examples/typescript/) for usage patterns

