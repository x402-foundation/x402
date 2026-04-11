# EVM Mechanisms

This directory contains payment mechanism implementations for **EVM (Ethereum Virtual Machine)** networks.

## What This Exports

This package provides scheme implementations for EVM-based blockchains (Ethereum, Base, Optimism, Arbitrum, Polygon, etc.) that can be used by clients, servers, and facilitators.

## Exact Payment Scheme

The **exact** scheme implementation enables fixed-amount payments using EIP-3009 `transferWithAuthorization` or Permit2 for USDC and compatible tokens.

### Export Paths

The exact scheme is organized by role:

#### For Clients

**Import Path:**
```
github.com/x402-foundation/x402/go/mechanisms/evm/exact/client
```

**Exports:**
- `NewExactEvmScheme(signer, config)` - Creates client-side EVM exact payment mechanism
- Used for creating payment payloads that clients sign
- Pass `nil` config for signer-only mode
- Use config to provide explicit RPC URLs for extension enrichment (`RPCURL` or `RPCByChainID`)

#### For Servers

**Import Path:**
```
github.com/x402-foundation/x402/go/mechanisms/evm/exact/server
```

**Exports:**
- `NewExactEvmScheme()` - Creates server-side EVM exact payment mechanism
- Used for building payment requirements and parsing prices
- Supports custom money parsers via `RegisterMoneyParser()`

#### For Facilitators

**Import Path:**
```
github.com/x402-foundation/x402/go/mechanisms/evm/exact/facilitator
```

**Exports:**
- `NewExactEvmScheme(signer)` - Creates facilitator-side EVM exact payment mechanism
- Used for verifying signatures and settling payments on-chain
- Requires facilitator signer with blockchain RPC integration

## Supported Networks

All EVM networks are supported by default. The only consideration is how prices are transformed from money syntax (e.g. `"$0.10"`) to a stablecoin token.

**If prices are defined as `TokenAsset`:** Any EVM chain works out of the box—no additional configuration needed.

**If prices are defined as Money (a USD string like `"$0.10"`):** The server must either:
1. Register a custom money parser in their `ExactEvmScheme` via `RegisterMoneyParser()`, OR
2. Use a chain that has a default asset configuration

Networks with default assets configured:

- **Base Mainnet**: `eip155:8453` (USDC)
- **Base Sepolia**: `eip155:84532` (USDC)
- **MegaETH Mainnet**: `eip155:4326` (MegaUSD)
- **Monad Mainnet**: `eip155:143` (USDC)

To add default asset support for additional chains, see [DEFAULT_ASSETS.md](../../../DEFAULT_ASSETS.md).

## Scheme Implementation

The **exact** scheme implements fixed-amount payments:

- **Standard**: EIP-3009 `transferWithAuthorization` or Permit2 (per-asset configuration)
- **Token**: USDC and other stablecoins (EIP-3009 or any ERC-20 via Permit2)
- **Gas**: Paid by facilitator
- **Confirmation**: On-chain settlement with transaction hash

## Future Schemes

This directory currently contains only the **exact** scheme implementation. As new payment schemes are developed for EVM networks, they will be added here alongside the exact implementation:

```
evm/
├── exact/          - Fixed amount payments (current)
├── upto/           - Variable amount up to a limit (planned)
├── subscription/   - Recurring payments (planned)
└── batch/          - Batched payments (planned)
```

Each new scheme will follow the same three-role structure (client, server, facilitator).

## Contributing New Schemes

We welcome contributions of new payment scheme implementations for EVM networks!

To contribute a new scheme:

1. Create directory structure: `evm/{scheme_name}/client/`, `evm/{scheme_name}/server/`, `evm/{scheme_name}/facilitator/`
2. Implement the required interfaces for each role
3. Add comprehensive tests
4. Document the scheme specification
5. Provide usage examples

See [CONTRIBUTING.md](../../../CONTRIBUTING.md) for more details.

## Related Documentation

- **[Mechanisms Overview](../README.md)** - About mechanisms in general
- **[SVM Mechanisms](../svm/README.md)** - Solana implementations
- **[Exact Scheme Specification](../../../specs/schemes/exact/scheme_exact_evm.md)** - EVM exact scheme spec
