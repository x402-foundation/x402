# x402 Rust

Rust implementation of the x402 protocol - a standard for HTTP 402 Payment Required responses with micropayments.

## What is x402?

x402 is a protocol that enables HTTP resources to require payments. When a client requests a paid resource, the server responds with `402 Payment Required` along with payment details. The client creates a payment, retries the request, and receives the resource after successful payment verification and settlement. While commonly used with cryptocurrency payments, the protocol supports any payment method defined in the payment requirements.

## What This Package Exports

This package provides modules to support the x402 protocol in Rust applications.

### Core Components

The package exports core types that can be used by clients and servers:

- **`x402::client::X402Client`** - Trait for creating payment payloads for clients making paid requests
- **`x402::server::SchemeNetworkServer`** - Trait for servers accepting payments and building requirements
- **`x402::facilitator::Facilitator`** - Facilitator client for payment verification and settlement

These core components are **framework-agnostic** and can be used in any async context.

### Framework Integration

Framework-specific middleware for easy server integration:

- **`x402::frameworks::axum`** - Axum framework middleware

### Client Helper Modules

Helper modules to simplify client implementation:

- **`x402::client::evm::exact`** - EVM exact payment client implementation
- **`x402::client::svm::exact`** - SVM (Solana) exact payment client implementation (behind `svm` feature)
- **`x402::client::http`** - HTTP client wrapper with automatic payment handling

### Mechanism Implementations (Schemes)

Payment scheme implementations:

- **`x402::schemes::evm`** - Ethereum/Base exact payment using EIP-3009
  - Supports exact payment transfers for EVM-compatible chains
- **`x402::schemes::svm`** - Solana exact payment using SPL Token / Token-2022 (behind `svm` feature)
  - Partially-signed transfer transactions with a facilitator fee payer

## Architecture

The package is designed with modularity in mind:

### Layered Design

The library is organized into distinct layers, each with a specific responsibility:

1. **Application Layer** - Your application code that uses x402 for client requests, server endpoints, or facilitator services

2. **Framework Layer (Optional)** - Framework-specific integrations like Axum middleware that provide convenient APIs for common web frameworks

3. **Core Layer (Framework-Agnostic)** - Core traits and types that work in any async context:
   - `X402Client` trait for creating payment payloads
   - `SchemeNetworkServer` trait for building payment requirements
   - `Facilitator` client for verification and settlement

4. **Schemes Layer (Pluggable)** - Payment mechanism implementations that can be registered and swapped:
   - EVM exact payment using EIP-3009
   - Additional schemes can be added as needed

### Key Design Principles

1. **Framework-Agnostic Core** - The core client/server traits work independently of any web framework
2. **Async-First** - Built on tokio for high-performance async operations
3. **Pluggable Mechanisms** - Payment schemes are modular and can be registered independently

This architecture enables:
- Using core traits in any async context
- Building custom middleware for any framework
- Registering different schemes for different networks
- Type-safe payment handling throughout

## Usage

### Building Payment-Enabled Clients

For applications that make requests to payment-protected resources.

```rust
use x402::client::evm::exact::EvmExactClient;
use x402::client::http::X402HttpClient;
use alloy::signers::local::PrivateKeySigner;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create signer from private key
    let signer = PrivateKeySigner::from_bytes(&private_key_bytes)?;

    // Create EVM client for exact payments
    let evm_client = EvmExactClient::new(signer);

    // Create HTTP client wrapper
    let http_client = X402HttpClient::new(evm_client);

    // Make request - payment handling is automatic
    let response = http_client
        .get("https://api.example.com/protected")
        .send()
        .await?;

    println!("Response: {}", response.text().await?);
    Ok(())
}
```

**See also:** [`examples/buyers/`](../../examples/rust/buyers/)

### Building Payment-Accepting Servers

For services that protect resources with payment requirements using Axum.

```rust
use axum::{Router, routing::get, Json, middleware};
use x402::frameworks::axum_integration::{X402ConfigBuilder, x402_middleware};
use x402::server::{ResourceConfig, SchemeServer};
use x402::types::Network;
use x402::facilitator::HttpFacilitator;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    // Configure facilitator
    let facilitator = Arc::new(HttpFacilitator::new(
        "https://x402.org/facilitator"
    ));

    // Create server for exact payment scheme
    let scheme_server = Arc::new(SchemeServer::new(
        2, // x402 protocol version
        Some("exact"),
        None,
        Network::default(), // Base Sepolia
        None,
    ));

    // Configure resource payment requirements
    let resource_config = ResourceConfig::new(
        "exact",
        "0xYourAddress",
        "0.01".into(), // Price
        Network::default(),
        Some(300),
    );

    // Create x402 config
    let mut config_builder = X402ConfigBuilder::new(
        "http://localhost:3000",
        facilitator,
    );

    config_builder
        .register_scheme(Network::default(), scheme_server)
        .register_resource(resource_config, "/protected", None, None);

    let config = config_builder.build();

    // Build router with protected endpoint
    let app = Router::new()
        .route("/protected", get(protected_handler))
        .layer(middleware::from_fn_with_state(config, x402_middleware));

    // Start server
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn protected_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "message": "Payment verified! Here's your protected content."
    }))
}
```

**See also:** [`examples/sellers/axum/`](../../examples/rust/sellers/axum/)

## Package Structure

```
x402/
├── src/
│   ├── lib.rs              - Main library entry point
│   ├── types.rs            - Core type definitions
│   ├── errors.rs           - Error types
│   ├── auth.rs             - Authentication utilities
│   │
│   ├── client/             - Client implementations
│   │   ├── client.rs       - X402Client trait
│   │   ├── http.rs         - HTTP client wrapper
│   │   ├── evm/            - EVM client implementations
│   │   │   └── exact.rs    - Exact payment client (EVM)
│   │   └── svm/            - SVM client implementations (feature = "svm")
│   │       └── exact.rs    - Exact payment client (SVM)
│   │
│   ├── server.rs           - Server traits and implementations
│   │
│   ├── facilitator/        - Facilitator client
│   │   ├── facilitator.rs  - Facilitator trait
│   │   └── http.rs         - HTTP facilitator client
│   │
│   ├── frameworks/         - Framework integrations
│   │   └── axum_integration.rs
│   │
│   └── schemes/            - Payment scheme implementations
│       ├── evm.rs          - EVM schemes
│       └── svm.rs          - SVM schemes (feature = "svm")
│
├── examples/               - Usage examples
│   ├── buyers/             - Client examples
│   └── sellers/            - Server examples
│       └── axum/           - Axum server examples
│
└── tests/                  - Integration tests
    ├── integration_tests.rs
    ├── coinbase_facilitator_test.rs
    └── x402_facilitator_test.rs
```

## Feature Flags

The crate uses feature flags to enable optional functionality:

```toml
[dependencies]
x402 = { version = "0.1.0", features = ["axum", "evm"] }
```

### Available Features

- **`default`** - Enables `axum` and `evm` features
- **`axum`** - Axum framework middleware integration
- **`evm`** - EVM (Ethereum Virtual Machine) payment support using Alloy
- **`svm`** - SVM (Solana) payment support using `solana-sdk`, `spl-token`, and `spl-associated-token-account`

### Feature Combinations

```toml
# Default (axum + evm)
x402 = "0.1.0"

# Only EVM support (no framework)
x402 = { version = "0.1.0", default-features = false, features = ["evm"] }

# Only SVM support (no framework)
x402 = { version = "0.1.0", default-features = false, features = ["svm"] }

# Multi-chain: EVM + SVM with Axum middleware
x402 = { version = "0.1.0", features = ["axum", "evm", "svm"] }

# Only Axum support (framework-agnostic usage)
x402 = { version = "0.1.0", default-features = false, features = ["axum"] }

# Minimal (no optional features)
x402 = { version = "0.1.0", default-features = false }
```

## Supported Networks

Network support is determined by the facilitator you use. This library provides the protocol implementation that can work with any network supported by your facilitator.

### EVM (Ethereum Virtual Machine)

The included EVM scheme implementation supports all EVM-compatible chains using CAIP-2 identifiers:
- Ethereum Mainnet (`eip155:1`)
- Base Mainnet (`eip155:8453`)
- Base Sepolia (`eip155:84532`)
- Optimism, Arbitrum, Polygon, and more

### SVM (Solana)

The included SVM scheme implementation (feature `svm`) supports Solana clusters using CAIP-2 identifiers:
- Solana Mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`)
- Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)
- Solana Testnet (`solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z`)

Legacy aliases (`solana`, `solana-devnet`, `solana-testnet`) are normalized to the CAIP-2 form.

### Exact Payment

Transfer an exact amount to access a resource:
- **EVM**: Uses EIP-3009 `transferWithAuthorization` (USDC compatible tokens)
- **SVM**: Uses a partially-signed SPL Token (or Token-2022) transfer transaction with the facilitator as fee payer. The payer signs `SetComputeUnitLimit` + `SetComputeUnitPrice` + `TransferChecked` (3 instructions) and leaves the fee-payer signature slot empty for the facilitator to fill in at settlement.

## Features

- ✅ Protocol v2 with v1 backward compatibility
- ✅ Multi-chain support (EVM and SVM/Solana)
- ✅ Modular architecture - use core traits directly or with helpers
- ✅ Framework agnostic core
- ✅ Async/await with tokio runtime
- ✅ Zero-copy serialization with serde
- ✅ Production ready with comprehensive testing

## Planned Features

Future enhancements planned for this crate:

- 🔄 **SVM Support** - Solana Virtual Machine payment schemes
- 🔄 **actix-web Integration** - Middleware for actix-web framework
- 🔄 **gRPC Support** - Protocol buffer definitions and tonic integration
- 🔄 **Extensions** - Protocol extension implementations (e.g., Bazaar discovery)

## Requirements

- **Rust Edition**: 2024
- **Async Runtime**: tokio
- **Minimum Dependencies**: serde, reqwest, base64

## Testing

```bash
# Run all tests
cargo test

# Run with coverage
cargo test --all-features

# Run integration tests only
cargo test --test integration_tests

# Run specific facilitator tests
cargo test --test coinbase_facilitator_test
cargo test --test x402_facilitator_test
```

## Examples

The [`examples/`](examples/) directory contains complete working examples:

- **[`examples/buyers/client.rs`](../../examples/rust/buyers/client.rs)** - Client making payment-enabled requests
- **[`examples/sellers/axum/`](../../examples/rust/sellers/axum/)** - Axum server with payment protection

Run examples with:

```bash
# Run buyer client example
cargo run --example client --features evm

# Run Axum server example
cargo run --example axum_server --features axum,evm
```

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines.

## License

Apache 2.0 - See [LICENSE](../../LICENSE) for details.
