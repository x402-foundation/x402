# Go SDK Contributing Guide

Guide for developing and contributing to the x402 Go SDK.

## Contents

- [Repository Structure](#repository-structure)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Adding Features](#adding-features)
- [Testing](#testing)
- [Code Quality](#code-quality)

## Repository Structure

The Go SDK is a single Go module with modular subpackages.

```
go/
├── client.go              # x402.X402Client
├── server.go              # x402.X402ResourceServer
├── facilitator.go         # x402.X402Facilitator
├── types.go               # Core types
├── interfaces.go          # Interface definitions
├── *_hooks.go             # Lifecycle hooks
│
├── http/                  # HTTP transport layer
│   ├── client.go          # HTTP client wrapper
│   ├── server.go          # HTTP server integration
│   ├── facilitator_client.go
│   └── gin/               # Gin middleware
│
├── mechanisms/            # Payment schemes
│   ├── evm/exact/
│   │   ├── client/        # EVM client mechanism
│   │   ├── server/        # EVM server mechanism
│   │   └── facilitator/   # EVM facilitator mechanism
│   └── svm/exact/
│       ├── client/        # SVM client mechanism
│       ├── server/        # SVM server mechanism
│       └── facilitator/   # SVM facilitator mechanism
│
├── signers/               # Signer helpers
│   ├── evm/
│   └── svm/
│
├── extensions/            # Protocol extensions
│   └── bazaar/
│
├── types/                 # Type definitions
│   ├── v1.go
│   └── v2.go
│
├── test/
│   ├── unit/
│   ├── integration/
│   └── mocks/
│
├── go.mod
├── go.sum
└── Makefile
```

## Development Setup

### Prerequisites

- Go 1.24+
- golangci-lint (installed via `make deps-dev`)
- goimports (for formatting)

### Installation

```bash
cd go

# Install dependencies
make deps

# Install dev dependencies (linter, mockgen)
make deps-dev
```

## Development Workflow

### Makefile Commands

From the `go/` directory:

| Command | Description |
|---------|-------------|
| `make build` | Build the SDK |
| `make test` | Run unit tests |
| `make test-cover` | Run tests with coverage report |
| `make test-integration` | Run integration tests |
| `make lint` | Run golangci-lint |
| `make fmt` | Format code (go fmt + goimports) |
| `make verify` | Run fmt, lint, and test |
| `make generate` | Generate mocks |
| `make help` | Show all available commands |

### Quick Verification

Before submitting changes:

```bash
make verify
```

This runs formatting, linting, and tests in sequence.

## Adding Features

### Adding HTTP Framework Middleware

To add middleware for a new HTTP framework (e.g., Echo, Chi):

1. Create a new directory under `http/`:

```
http/your_framework/
├── middleware.go
└── middleware_test.go
```

2. Implement the middleware using `HTTPResourceServer`:

```go
package yourframework

import (
    x402 "github.com/x402-foundation/x402/go"
    x402http "github.com/x402-foundation/x402/go/http"
)

// Middleware creates x402 payment middleware for YourFramework.
func Middleware(httpServer *x402http.HTTPResourceServer) YourFrameworkMiddleware {
    return func(c YourContext) {
        // 1. Extract route key from request
        routeKey := x402http.RouteKey(c.Request().Method, c.Request().URL.Path)
        
        // 2. Check if route requires payment
        if !httpServer.HasRouteConfig(routeKey) {
            c.Next()
            return
        }
        
        // 3. Get payment header
        paymentHeader := c.Request().Header.Get("PAYMENT-SIGNATURE")
        
        // 4. Process payment via httpServer.HandleRequest()
        // 5. Return 402 or proceed based on result
    }
}
```

3. Reference `http/gin/middleware.go` for the complete pattern.

### Adding a New Chain Mechanism

See [New Chains](../CONTRIBUTING.md#new-chains) in the root contributing guide for protocol-level requirements and interface definitions.

To add support for a new blockchain in Go:

1. Create the mechanism directory structure:

```
mechanisms/your_chain/exact/
├── client/
│   ├── scheme.go
│   └── register.go
├── server/
│   ├── scheme.go
│   └── register.go
└── facilitator/
    ├── scheme.go
    └── register.go
```

2. Implement `ClientScheme`, `ServerScheme`, and `FacilitatorScheme` interfaces from the root package.

3. Add registration helpers in each package.

4. Add signer helpers in `signers/your_chain/`.

5. Reference `mechanisms/evm/` or `mechanisms/svm/` for the complete pattern.

### Adding Extensions

Extensions go in `extensions/`. Each extension should:

1. Have its own subdirectory
2. Implement a clean registration pattern
3. Include documentation in a README.md

## Testing

### Unit Tests

```bash
# All tests
make test

# With coverage
make test-cover

# Specific package
go test -v ./mechanisms/evm/exact/client/...
```

### Integration Tests

Integration tests require network access and may use testnets:

```bash
# Set up environment (optional)
cp .env.example .env
# Edit .env with your test credentials

# Run integration tests
make test-integration
```

### Test Organization

```
test/
├── unit/           # Unit tests for core functionality
├── integration/    # Integration tests (network required)
└── mocks/          # Generated mocks
```

### Mocks

Generate mocks with:

```bash
make generate
```

Mocks are generated using `mockgen` and placed in `test/mocks/`.

## Code Quality

### Linting

The project uses [golangci-lint](https://golangci-lint.run/):

```bash
make lint
```

### Formatting

```bash
make fmt
```

This runs both `go fmt` and `goimports`.

### Code Style

- Follow standard Go conventions
- Use meaningful variable and function names
- Add godoc comments on exported types and functions
- Handle errors explicitly
- Use `context.Context` for cancellation
- Keep interfaces small and focused

### Error Handling

Use typed errors from `errors.go`:

```go
import x402 "github.com/x402-foundation/x402/go"

if err != nil {
    return nil, x402.NewVerificationError("invalid signature", err)
}
```

## Changelog

User-facing changes to the Go SDK should include a changelog fragment.

### When a fragment is required

Add a fragment when the change affects SDK users, including:

- New/changed/removed exported APIs (types, functions, interfaces)
- Bug fixes
- Behavior changes
- New features or configuration options

Pure refactors, tests, or build/CI-only changes typically do not require a fragment.

### Create a fragment

From the `go/` directory:

```bash
make changelog-new
```

Fragments are created under:

- `.changes/unreleased/`

Commit the generated fragment with your PR.

### Maintainer flow (batch + merge)

Maintainers should batch unreleased fragments into a version and merge them into `CHANGELOG.md`:

```bash
make changelog-batch VERSION=v0.1.0
make changelog-merge
```

## Examples

Examples live in `examples/go/`. When adding a new example:

1. Create a directory under the appropriate category (`clients/`, `servers/`, `facilitator/`)
2. Add a `main.go` with the example
3. Add a `README.md` with setup and run instructions
4. Add a `go.mod` that references the local SDK for development

When adding a Go example, include a `go.mod` that references the local SDK:

```go
module github.com/x402-foundation/x402/examples/go/your-example

go 1.24

require github.com/x402-foundation/x402/go v0.0.0

replace github.com/x402-foundation/x402/go => ../../../go
```

## Documentation

Each major component has its own documentation:

- `CLIENT.md` - Client usage and patterns
- `SERVER.md` - Server usage and patterns
- `FACILITATOR.md` - Facilitator usage and patterns
- `signers/README.md` - Signer utilities
- `mechanisms/*/README.md` - Mechanism-specific docs

When adding features, update the relevant documentation.

## Publishing

The Go SDK is published as a Go module. Version tags follow semver:

```
v0.1.0
v0.1.1
v0.2.0
```

Releases are handled by maintainers.

## Getting Help

- Open an issue on GitHub
- Check the [examples](../examples/go/) for usage patterns
- Reference the role-specific docs (CLIENT.md, SERVER.md, FACILITATOR.md)

