# x402 EVM Contracts

Smart contracts for the x402 payment protocol on EVM chains.

## Overview

The x402 Permit2 Proxy contracts enable trustless, gasless payments using [Permit2](https://github.com/Uniswap/permit2). There are two variants:

### `x402ExactPermit2Proxy`
Transfers the **exact** permitted amount (similar to EIP-3009's `transferWithAuthorization`). The facilitator cannot choose a different amount—it's always the full permitted amount.

### `x402UptoPermit2Proxy`
Allows the facilitator to transfer **up to** the permitted amount. Useful for scenarios where the actual amount is determined at settlement time.

Both contracts:
- Use the **witness pattern** to cryptographically bind payment destinations
- Prevent facilitators from redirecting funds
- Support both standard Permit2 and EIP-2612 flows
- Deploy to the **same address on all EVM chains** via CREATE2

## Deployed Addresses

### Base Sepolia (Testnet)

| Contract | Address | Verified |
|----------|---------|----------|
| x402ExactPermit2Proxy | [`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`](https://sepolia.basescan.org/address/0x402085c248EeA27D92E8b30b2C58ed07f9E20001) | ✓ |
| x402UptoPermit2Proxy | [`0x402039b3d6E6BEC5A02c2C9fd937ac17A6940002`](https://sepolia.basescan.org/address/0x402039b3d6E6BEC5A02c2C9fd937ac17A6940002) | ✓ |

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)

## Installation

```bash
# Install dependencies
forge install

# Build contracts
forge build
```

## Testing

```bash
# Run all tests
forge test

# Run with verbosity
forge test -vvv

# Run Exact proxy tests
forge test --match-contract X402ExactPermit2ProxyTest

# Run Upto proxy tests
forge test --match-contract X402UptoPermit2ProxyTest

# Run with gas reporting
forge test --gas-report

# Run fuzz tests with more runs
forge test --fuzz-runs 1000

# Run invariant tests
forge test --match-contract Invariants
```

### Fork Testing

Fork tests run against real Permit2 on Base Sepolia:

```bash
# Set up environment
export BASE_SEPOLIA_RPC_URL="https://sepolia.base.org"

# Run fork tests for Exact variant
forge test --match-contract X402ExactPermit2ProxyForkTest --fork-url $BASE_SEPOLIA_RPC_URL

# Run fork tests for Upto variant
forge test --match-contract X402UptoPermit2ProxyForkTest --fork-url $BASE_SEPOLIA_RPC_URL
```

## Deployment

### Compute Expected Addresses

```bash
forge script script/ComputeAddress.s.sol
```

### Deploy to Testnet

```bash
# Set environment variables
export PRIVATE_KEY="your_private_key"
export BASE_SEPOLIA_RPC_URL="https://sepolia.base.org"
export BASESCAN_API_KEY="your_api_key"

# Deploy both contracts with verification
forge script script/Deploy.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast \
  --verify
```

### Deploy to Mainnet

```bash
export BASE_RPC_URL="https://mainnet.base.org"

forge script script/Deploy.s.sol \
  --rpc-url $BASE_RPC_URL \
  --broadcast \
  --verify
```

## Vanity Address Mining

The deployment uses vanity addresses starting with `0x4020`. To mine new salts:

```bash
cd vanity-miner
cargo run --release
```

The Rust miner uses parallel processing for efficient address generation. Update the init code hashes in `vanity-miner/src/main.rs` if the contract bytecode changes.

## Contract Architecture

```
src/
├── x402ExactPermit2Proxy.sol  # Exact amount transfers (EIP-3009-like)
├── x402UptoPermit2Proxy.sol   # Flexible amount transfers (up to permitted)
└── interfaces/
    └── ISignatureTransfer.sol # Permit2 SignatureTransfer interface

test/
├── x402ExactPermit2Proxy.t.sol      # Exact variant unit tests
├── x402ExactPermit2Proxy.fork.t.sol # Exact variant fork tests
├── x402UptoPermit2Proxy.t.sol       # Upto variant unit tests
├── x402UptoPermit2Proxy.fork.t.sol  # Upto variant fork tests
├── invariants/
│   ├── X402ExactInvariants.t.sol    # Exact variant invariant tests
│   └── X402UptoInvariants.t.sol     # Upto variant invariant tests
└── mocks/
    ├── MockERC20.sol
    ├── MockERC20Permit.sol
    ├── MockPermit2.sol
    ├── MaliciousReentrantExact.sol
    └── MaliciousReentrantUpto.sol

script/
├── Deploy.s.sol              # CREATE2 deployment for both contracts
└── ComputeAddress.s.sol      # Address computation for both contracts

vanity-miner/                   # Rust-based vanity address miner
└── src/main.rs
```

## Key Functions

### `x402ExactPermit2Proxy.settle()`

Standard settlement path - always transfers the exact permitted amount.

```solidity
function settle(
    ISignatureTransfer.PermitTransferFrom calldata permit,
    address owner,
    Witness calldata witness,
    bytes calldata signature
) external;
```

### `x402UptoPermit2Proxy.settle()`

Standard settlement path - transfers the specified amount (up to permitted).

```solidity
function settle(
    ISignatureTransfer.PermitTransferFrom calldata permit,
    uint256 amount,  // Facilitator specifies amount to transfer
    address owner,
    Witness calldata witness,
    bytes calldata signature
) external;
```

### `settleWithPermit()`

Both contracts support settlement with EIP-2612 permit for fully gasless flow.
The function signatures follow the same pattern as `settle()` for each variant.

## Security

- **Immutable:** No upgrade mechanism, one-time initialization
- **No custody:** Contracts never hold tokens
- **Destination locked:** Witness pattern enforces payTo address
- **Reentrancy protected:** Uses OpenZeppelin's ReentrancyGuard
- **Deterministic:** Same address on all chains via CREATE2 (Permit2 set via initialize)

## Coverage

```bash
# Full coverage report (includes test/script files)
forge coverage

# Coverage for src/ contracts only (excludes mocks, tests, scripts)
forge coverage --no-match-coverage "(test|script)/.*" --offline
```

## Gas Snapshots

```bash
# Create snapshot
forge snapshot

# Compare against baseline
forge snapshot --diff
```

## License

Apache-2.0
