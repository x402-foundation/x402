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

## Canonical Addresses

| Contract | Address |
|----------|---------|
| x402ExactPermit2Proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` |
| x402UptoPermit2Proxy | `0x4020a4f3b7b90CCA423b9FabCC0CE57c6c240002` |

### Current Deployments

| Chain | Exact | Upto |
|-------|-------|------|
| Base Mainnet | [Deployed](https://basescan.org/address/0x402085c248EeA27D92E8b30b2C58ed07f9E20001) | — |
| Base Sepolia | [Deployed](https://sepolia.basescan.org/address/0x402085c248EeA27D92E8b30b2C58ed07f9E20001) | [Legacy\*](https://sepolia.basescan.org/address/0x402039b3d6E6BEC5A02c2C9fd937ac17A6940002) |

> \*The Base Sepolia Upto deployment at `0x4020...0002` predates the deterministic build fix
> and uses a different bytecode (with CBOR metadata). The canonical Upto address for all
> new deployments is `0x4020a4f3...0002`.

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)

## Installation

```bash
forge install
forge build
```

## Deploying to a New EVM Chain

Anyone can deploy both contracts to their canonical addresses on any EVM chain.
No special build environment, private key, or permission is required—only gas on the target chain.

### How it works

Both contracts are deployed via [Arachnid's deterministic CREATE2 deployer](https://github.com/Arachnid/deterministic-deployment-proxy)
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`), which exists at the same address on
virtually every EVM chain. The CREATE2 address depends only on the deployer, a salt,
and `keccak256(initCode)`—not on who sends the transaction.

| Contract | Bytecode source | Why |
|----------|----------------|-----|
| **Exact** | Pre-built initCode in `script/data/exact-proxy-initcode.hex` | The original build included Solidity CBOR metadata (an IPFS hash that varies per build environment). The committed hex file is the exact initCode from the original deployment, ensuring the same address everywhere. |
| **Upto** | Compiled from source (`forge build`) | Built with `cbor_metadata = false` so the bytecode is identical on every machine at the same git commit. |

### Step-by-step

1. **Clone and build**
   ```bash
   cd contracts/evm
   forge install
   forge build
   ```

2. **Verify expected addresses** (optional, no RPC needed)
   ```bash
   forge script script/ComputeAddress.s.sol
   ```
   You should see:
   - Exact → `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`
   - Upto  → `0x4020a4f3b7b90CCA423b9FabCC0CE57c6c240002`

3. **Check prerequisites on the target chain**
   - [Permit2](https://github.com/Uniswap/permit2) must be deployed at `0x000000000022D473030F116dDEE9F6B43aC78BA3`
   - The CREATE2 deployer must exist at `0x4e59b44847b379578588920cA78FbF26c0B4956C`
   - Your wallet needs enough native gas to pay for deployment (~300k gas per contract)

4. **Deploy**
   ```bash
   export PRIVATE_KEY="your_private_key"

   forge script script/Deploy.s.sol \
     --rpc-url <RPC_URL> \
     --broadcast \
     --verify
   ```

   The script automatically:
   - Loads the pre-built initCode for Exact and compiler-derived initCode for Upto
   - Skips any contract already deployed at the expected address
   - Verifies `PERMIT2()` returns the correct address after deployment

5. **Verify on Etherscan** (if `--verify` didn't work automatically)
   ```bash
   forge verify-contract <DEPLOYED_ADDRESS> x402UptoPermit2Proxy \
     --rpc-url <RPC_URL> \
     --constructor-args $(cast abi-encode "constructor(address)" 0x000000000022D473030F116dDEE9F6B43aC78BA3)
   ```

   For the Exact proxy, verification may require matching the original compiler metadata.
   The verified source on Base Sepolia / Base Mainnet can be used as a reference.

### Overriding Permit2 address

If the target chain has Permit2 at a non-canonical address:

```bash
export PERMIT2_ADDRESS="0x..."
forge script script/Deploy.s.sol --rpc-url <RPC_URL> --broadcast
```

> **Warning:** Overriding the Permit2 address changes the initCode for the Upto contract
> and will produce a different deployment address. The Exact contract's pre-built initCode
> already encodes the canonical Permit2 address and cannot be overridden.

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
export BASE_SEPOLIA_RPC_URL="https://sepolia.base.org"

forge test --match-contract X402ExactPermit2ProxyForkTest --fork-url $BASE_SEPOLIA_RPC_URL
forge test --match-contract X402UptoPermit2ProxyForkTest --fork-url $BASE_SEPOLIA_RPC_URL
```

## Vanity Address Mining

Both contracts use vanity addresses with prefix `0x4020` and suffix `0001` (Exact) or `0002` (Upto).

The vanity miner is only needed if the contract source code changes (which changes the
initCodeHash and invalidates existing salts). To re-mine:

```bash
cd vanity-miner

# Mine both contracts
cargo run --release

# Mine only one
cargo run --release -- exact
cargo run --release -- upto
```

After mining, update the salt constants in `script/Deploy.s.sol` and `script/ComputeAddress.s.sol`,
and the init code hashes in `vanity-miner/src/main.rs`.

## Deterministic Build Configuration

The `foundry.toml` includes two settings that ensure bytecode reproducibility:

```toml
cbor_metadata = false
bytecode_hash = "none"
```

Without these, the Solidity compiler appends a CBOR-encoded IPFS hash of the contract
metadata to the bytecode. This hash varies across build environments (even with identical
source code and compiler version), breaking CREATE2 address determinism.

The `x402ExactPermit2Proxy` was deployed before this fix was in place, which is why it
uses a committed initCode hex file instead of compiler-derived bytecode.

## Contract Architecture

```
src/
├── x402BasePermit2Proxy.sol   # Shared settlement logic and Permit2 interaction
├── x402ExactPermit2Proxy.sol  # Exact amount transfers (EIP-3009-like)
├── x402UptoPermit2Proxy.sol   # Flexible amount transfers (up to permitted)
└── interfaces/
    └── ISignatureTransfer.sol # Permit2 SignatureTransfer interface

script/
├── Deploy.s.sol               # CREATE2 deployment for both contracts
├── ComputeAddress.s.sol       # Address computation (no RPC needed)
└── data/
    └── exact-proxy-initcode.hex  # Pre-built initCode for Exact proxy

vanity-miner/                  # Rust-based vanity address miner
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

- **Immutable:** No upgrade mechanism, no owner, no admin functions
- **No custody:** Contracts never hold tokens
- **Destination locked:** Witness pattern enforces payTo address
- **Reentrancy protected:** Uses OpenZeppelin's ReentrancyGuard
- **Deterministic:** Same address on all chains via CREATE2

## Coverage

```bash
# Full coverage report (includes test/script files)
forge coverage

# Coverage for src/ contracts only (excludes mocks, tests, scripts)
forge coverage --no-match-coverage "(test|script)/.*" --offline
```

## Gas Snapshots

```bash
forge snapshot
forge snapshot --diff
```

## License

Apache-2.0
