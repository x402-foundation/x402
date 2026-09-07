# Rust SDK Contributing Guide

Guide for developing and contributing to the x402 Rust SDK.

## Development Setup

### Prerequisites

- Rust Edition 2024 (rustc >= 1.83)
- Cargo

### Installation

```bash
cd rust/x402
cargo build
```

## Development Workflow

### Common Commands

| Command | Description |
|---------|-------------|
| `cargo build` | Build the SDK |
| `cargo test` | Run tests |
| `cargo test --all-features` | Run tests with all features |
| `cargo clippy` | Lint code |
| `cargo fmt` | Format code |

### Quick Verification

```bash
cargo fmt --check && cargo clippy && cargo test
```

## Testing

```bash
# All tests
cargo test

# Integration tests
cargo test --test integration_tests
# Optional (useful for testing real world scenarios)
cargo test --test coinbase_facilitator_test
cargo test --test x402_facilitator_test
```

## Code Quality

### Linting

```bash
cargo clippy
cargo clippy --fix
```

### Formatting

```bash
cargo fmt
cargo fmt --check
```

## Examples

Run examples with:

```bash
cargo run --example client --features evm
cargo run --example axum_server --features axum,evm
```

## Getting Help

- Open an issue on GitHub
- Check the [examples](x402/examples/) for usage patterns
- Reference the [README](x402/README.md) for API documentation
