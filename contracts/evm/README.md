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
| x402UptoPermit2Proxy | `0x402015c795ecb48A360bDC6e35a2EaEb313a0002` |

**Batch settlement (CREATE2 vanity `0x4020…`)**

| Contract | Address |
|----------|---------|
| x402BatchSettlement | `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` |
| ERC3009DepositCollector | `0x4020806089470a89826cB9fB1f4059150b550004` |
| Permit2DepositCollector | `0x4020425FAf3B746C082C2f942b4E5159887B0005` |

**Implementer notes:** [x402-batch-settlement-implementers.md](docs/x402-batch-settlement-implementers.md) — on-chain vs off-chain entitlement, timed withdrawal vs `claim`, deposits, EIP-712, and deployment constraints.

> Re-mine collectors (`cargo run --release -- batch-stack`) whenever `ERC3009DepositCollector` / `Permit2DepositCollector` bytecode changes; salts live in `script/DeployBatchSettlement.s.sol`.

### Current Deployments

| Chain | Exact | Upto |
|-------|-------|------|
| Base Mainnet | [Deployed](https://basescan.org/address/0x402085c248EeA27D92E8b30b2C58ed07f9E20001) | — |
| Base Sepolia | [Deployed](https://sepolia.basescan.org/address/0x402085c248EeA27D92E8b30b2C58ed07f9E20001) | [Legacy\*](https://sepolia.basescan.org/address/0x402039b3d6E6BEC5A02c2C9fd937ac17A6940002) |

**Batch settlement deployments**

| Chain | x402BatchSettlement | ERC3009DepositCollector | Permit2DepositCollector |
|-------|---------------------|------------------------|------------------------|
| Base Mainnet | [Deployed](https://basescan.org/address/0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003) | [Deployed](https://basescan.org/address/0x4020806089470a89826cB9fB1f4059150b550004) | [Deployed](https://basescan.org/address/0x4020425FAf3B746C082C2f942b4E5159887B0005) |
| Arbitrum Mainnet | [Deployed](https://arbiscan.io/address/0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003) | [Deployed](https://arbiscan.io/address/0x4020806089470a89826cB9fB1f4059150b550004) | [Deployed](https://arbiscan.io/address/0x4020425FAf3B746C082C2f942b4E5159887B0005) |
| World Chain | [Deployed](https://worldscan.org/address/0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003) | [Deployed](https://worldscan.org/address/0x4020806089470a89826cB9fB1f4059150b550004) | [Deployed](https://worldscan.org/address/0x4020425FAf3B746C082C2f942b4E5159887B0005) |
| World Chain Sepolia | [Deployed](https://sepolia.worldscan.org/address/0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003) | [Deployed](https://sepolia.worldscan.org/address/0x4020806089470a89826cB9fB1f4059150b550004) | [Deployed](https://sepolia.worldscan.org/address/0x4020425FAf3B746C082C2f942b4E5159887B0005) |
| Polygon Mainnet | [Deployed](https://polygonscan.com/address/0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003) · [Sourcify](https://sourcify.dev/#/lookup/0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003) | [Deployed](https://polygonscan.com/address/0x4020806089470a89826cB9fB1f4059150b550004) · [Sourcify](https://sourcify.dev/#/lookup/0x4020806089470a89826cB9fB1f4059150b550004) | [Deployed](https://polygonscan.com/address/0x4020425FAf3B746C082C2f942b4E5159887B0005) · [Sourcify](https://sourcify.dev/#/lookup/0x4020425FAf3B746C082C2f942b4E5159887B0005) |

> \*Older testnet deployments may use prior vanity salts; the canonical **Upto** address for
> CREATE2 deployments from this tree is `0x402015c7…313a0002` (see `forge script script/ComputeAddress.s.sol`).

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
   - Upto  → `0x402015c795ecb48A360bDC6e35a2EaEb313a0002`

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

Permit2 proxies use prefix `0x4020` and suffix `…0001` (Exact) or `…0002` (Upto).

**Batch settlement stack** (`x402BatchSettlement`, `ERC3009DepositCollector`, `Permit2DepositCollector`) uses the same prefix with suffixes `…0003`, `…0004`, and `…0005` respectively. The two deposit collectors take the batch settlement contract address in their constructors, so their CREATE2 `initCode` (and thus the mined salt) **depends on the batch contract address**. Mine **batch first**, then collectors: use `batch-stack` (see below).

After any contract change, refresh embedded creation bytecode used by the miner:

```bash
cd contracts/evm
forge build
mkdir -p vanity-miner/bytecode
forge inspect ERC3009DepositCollector bytecode | sed 's/^0x//' | tr -d '\n' > vanity-miner/bytecode/erc3009_creation.hex
forge inspect Permit2DepositCollector bytecode | sed 's/^0x//' | tr -d '\n' > vanity-miner/bytecode/permit2_creation.hex
```

Update `BATCH_INIT_CODE_HASH` in `vanity-miner/src/main.rs` to `cast keccak $(forge inspect x402BatchSettlement bytecode)` (with `0x` prefix in the constant).

```bash
cd vanity-miner

# Permit2 proxies only (Exact + Upto)
cargo run --release -- proxies

# Single proxy
cargo run --release -- exact
cargo run --release -- upto

# Batch settlement only (...0003); update BATCH_INIT_CODE_HASH first if batch bytecode changed
cargo run --release -- batch

# Full pipeline: batch (...0003) then ERC3009 (...0004) then Permit2DepositCollector (...0005)
cargo run --release -- batch-stack

# If you already have a batch address, mine one collector (set BATCH_ADDRESS=0x...)
cargo run --release -- erc3009
cargo run --release -- permit2-collector
```

After mining, update salt constants in `script/Deploy.s.sol` / `script/ComputeAddress.s.sol` (proxies) or `script/DeployBatchSettlement.s.sol` (batch stack), and init code hashes in `vanity-miner/src/main.rs` as needed.

### Preview CREATE2 addresses (no RPC)

Proxies (default salts):

```bash
forge script script/ComputeAddress.s.sol
```

Batch stack (pass the three salts and Permit2 address used in the collector constructor):

```bash
forge script script/ComputeAddress.s.sol --sig "computeBatchStack(bytes32,bytes32,bytes32,address)" \
  <BATCH_SALT> <ERC3009_SALT> <PERMIT2_COLLECTOR_SALT> 0x000000000022D473030F116dDEE9F6B43aC78BA3
```

### Deploy batch stack

Prerequisites: [Permit2](https://github.com/Uniswap/permit2) at `0x000000000022D473030F116dDEE9F6B43aC78BA3`, Arachnid [CREATE2 deployer](https://github.com/Arachnid/deterministic-deployment-proxy) at `0x4e59b44847b379578588920cA78FbF26c0B4956C`, Cancun-compatible chain (transient storage), and native gas on the target chain.

**Base Sepolia:**
```bash
export PRIVATE_KEY="..."
forge script script/DeployBatchSettlement.s.sol \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --verify
```

**Polygon Mainnet:**
```bash
export PRIVATE_KEY="..."
export POLYGON_RPC_URL="https://polygon-rpc.com"   # or your own node
export POLYGONSCAN_API_KEY="..."

forge script script/DeployBatchSettlement.s.sol \
  --rpc-url polygon \
  --broadcast \
  --verify
```

If `--verify` fails, verify manually (constructor args match deployment `initCode`):

```bash
forge verify-contract <ADDR> ERC3009DepositCollector --chain base-sepolia \
  --constructor-args $(cast abi-encode "constructor(address)" <SETTLEMENT>)
forge verify-contract <ADDR> Permit2DepositCollector --chain base-sepolia \
  --constructor-args $(cast abi-encode "constructor(address,address)" <SETTLEMENT> 0x000000000022D473030F116dDEE9F6B43aC78BA3)
```

`x402BatchSettlement` has no constructor arguments beyond the EIP-712 parent (empty user ctor).

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
├── Deploy.s.sol                  # CREATE2 deployment for Permit2 proxy pair
├── DeployBatchSettlement.s.sol   # CREATE2: batch settlement + deposit collectors
├── ComputeAddress.s.sol          # Address computation (no RPC needed)
└── data/
    └── exact-proxy-initcode.hex  # Pre-built initCode for Exact proxy

vanity-miner/                  # Rust-based vanity address miner
├── src/main.rs
└── bytecode/                  # ERC3009 / Permit2 collector creation hex (refresh from forge)
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
- **Reentrancy protected:** Uses OpenZeppelin's `ReentrancyGuardTransient`
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
