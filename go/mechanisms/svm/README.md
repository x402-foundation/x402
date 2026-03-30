# SVM Mechanisms

This directory contains payment mechanism implementations for **SVM (Solana Virtual Machine)** networks.

## What This Exports

This package provides scheme implementations for Solana-based blockchains that can be used by clients, servers, and facilitators.

## Exact Payment Scheme

The **exact** scheme implementation enables fixed-amount payments using Solana token transfers for USDC SPL tokens.

### Export Paths

The exact scheme is organized by role:

#### For Clients

**Import Path:**
```
github.com/coinbase/x402/go/mechanisms/svm/exact/client
```

**Exports:**
- `NewExactSvmScheme(signer)` - Creates client-side SVM exact payment mechanism
- Used for creating payment payloads with partial transaction signatures

#### For Servers

**Import Path:**
```
github.com/coinbase/x402/go/mechanisms/svm/exact/server
```

**Exports:**
- `NewExactSvmScheme()` - Creates server-side SVM exact payment mechanism
- Used for building payment requirements and parsing prices
- Supports custom money parsers via `RegisterMoneyParser()`

#### For Facilitators

**Import Path:**
```
github.com/coinbase/x402/go/mechanisms/svm/exact/facilitator
```

**Exports:**
- `NewExactSvmScheme(signer)` - Creates facilitator-side SVM exact payment mechanism
- Used for verifying transaction signatures and settling payments on-chain
- Requires facilitator signer with Solana RPC integration

## Supported Networks

All Solana networks using CAIP-2 network identifiers:

- **Solana Mainnet**: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
- **Solana Devnet**: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`
- **Solana Testnet**: `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z`

Use `solana:*` wildcard to support all Solana networks.

## Scheme Implementation

The **exact** scheme implements fixed-amount payments:

- **Method**: Solana token transfers
- **Token**: USDC SPL token
- **Signing**: Partial transaction signing (client + facilitator)
- **Fees**: Rent and transaction fees paid by facilitator
- **Confirmation**: On-chain settlement with transaction signature

## Duplicate Settlement Protection

This package includes a built-in `SettlementCache` that prevents a known race condition on Solana where the same payment transaction could be settled multiple times before on-chain confirmation. The `NewExactSvmScheme` facilitator constructor accepts an optional `*SettlementCache` parameter — when the same cache instance is passed to both V1 and V2 facilitator schemes, cross-version duplicate detection is enabled.

The cache rejects concurrent `/settle` calls that carry the same transaction payload, returning a `duplicate_settlement` error for the second and subsequent attempts. Entries are automatically evicted after 120 seconds (approximately twice the Solana blockhash lifetime).

```go
import svm "github.com/coinbase/x402/go/mechanisms/svm"

cache := svm.NewSettlementCache()

// Share the same cache across V1 and V2 schemes
v2Scheme := facilitator.NewExactSvmScheme(signer, cache)
v1Scheme := v1facilitator.NewExactSvmSchemeV1(signer, cache)
```

For full details on the race condition and mitigation strategy, see the [Exact SVM Scheme Specification](../../specs/schemes/exact/scheme_exact_svm.md#duplicate-settlement-mitigation-recommended).

## Future Schemes

This directory currently contains only the **exact** scheme implementation. As new payment schemes are developed for Solana networks, they will be added here alongside the exact implementation:

```
svm/
├── exact/          - Fixed amount payments (current)
├── upto/           - Variable amount up to a limit (planned)
├── subscription/   - Recurring payments (planned)
└── batch/          - Batched payments (planned)
```

Each new scheme will follow the same three-role structure (client, server, facilitator).

## Contributing New Schemes

We welcome contributions of new payment scheme implementations for Solana networks!

To contribute a new scheme:

1. Create directory structure: `svm/{scheme_name}/client/`, `svm/{scheme_name}/server/`, `svm/{scheme_name}/facilitator/`
2. Implement the required interfaces for each role
3. Add comprehensive tests
4. Document the scheme specification
5. Provide usage examples

See [CONTRIBUTING.md](../../../CONTRIBUTING.md) for more details.

## Related Documentation

- **[Mechanisms Overview](../README.md)** - About mechanisms in general
- **[EVM Mechanisms](../evm/README.md)** - Ethereum implementations
- **[Exact Scheme Specification](../../../specs/schemes/exact/)** - Exact scheme specifications
