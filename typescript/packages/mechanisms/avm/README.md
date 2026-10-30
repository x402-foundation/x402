# @x402/avm [![npm version](https://img.shields.io/npm/v/%40x402%2Favm.svg)](https://www.npmjs.com/package/@x402/avm)

AVM (Algorand Virtual Machine) implementation of the x402 payment protocol using the **Exact** payment scheme with ASA (Algorand Standard Asset) transfers.

## Installation

```bash
npm install @x402/avm
```

## Overview

This package provides three main components for handling x402 payments on Algorand:

- **Client** - For applications that need to make payments (have wallets/signers)
- **Facilitator** - For payment processors that verify and execute on-chain transactions
- **Service** - For resource servers that accept payments and build payment requirements

## Package Exports

### Main Package (`@x402/avm`)

**V2 Protocol Support** - Modern x402 protocol with CAIP-2 network identifiers

**Client:**
- `ExactAvmClient` - V2 client implementation using ASA transfers
- `ClientAvmSigner` - TypeScript interface for client signers (implement with `@algorandfoundation/algokit-utils`)

**Facilitator:**
- `ExactAvmFacilitator` - V2 facilitator for payment verification and settlement
- `FacilitatorAvmSigner` - TypeScript interface for facilitator signers (implement with `@algorandfoundation/algokit-utils`)

**Service:**
- `ExactAvmServer` - V2 service for building payment requirements

## Usage

```typescript
import { x402Client } from "@x402/core/client";
import { ExactAvmClient } from "@x402/avm";

const client = new x402Client()
  .register("algorand:*", new ExactAvmClient(signer));
```

## Supported Networks

Networks are identified via CAIP-2 per the [Algorand namespace profile](https://namespaces.chainagnostic.org/algorand/caip2):
- `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k` - Mainnet
- `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe` - Testnet
- `algorand:*` - Wildcard (matches all Algorand networks)

### Identifier compatibility and migration

Use the canonical identifiers in new payment requirements, payloads, settlement responses, and facilitator advertisements. The legacy aliases below are historical wire values; the full genesis hash remains unchanged in transaction `gh` fields and Algod responses.

| Network | Canonical `network` | Legacy full-hash alias |
| --- | --- | --- |
| Mainnet | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k` | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| Testnet | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe` | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` |

The [maintainer's migration note](https://github.com/x402-foundation/x402/pull/3894#issuecomment-6349824187) identifies the release boundary. Compatibility below is checked as of **2026-10-26**; released packages and unreleased `main` changes are listed separately.

| Component / version | Canonical identifiers | Legacy full-hash identifiers |
| --- | --- | --- |
| `@x402/avm` 2.10.0–2.19.0 | Not emitted by exported network constants | Emitted by exported network constants |
| `@x402/avm` 2.20.0–2.28.0 | Emitted by exported network constants | Recognized by the AVM normalizer introduced in [#2931](https://github.com/x402-foundation/x402/pull/2931) |
| `@x402/core` 2.28.0 | Accepted by the V2 schema | Accepted by the V2 schema |
| [`main` at `4241d56c`](https://github.com/x402-foundation/x402/tree/4241d56cae2fb7ed06cd18e3a9ff2a3457b1ce54), after [#3893](https://github.com/x402-foundation/x402/pull/3893) | Emitted by AVM; accepted by core | Temporarily accepted by core and AVM |
| [#3894](https://github.com/x402-foundation/x402/pull/3894), open proposal on 2026-10-26 | Retained | Proposes rejection in core, AVM, and paywall routing; no release version assigned |

On `main`, [#3285](https://github.com/x402-foundation/x402/pull/3285) enforced CAIP-2 syntax before #3893 restored the temporary Algorand exception. AVM normalization alone cannot bypass core schema validation or a facilitator's exact-string network matching.

| Facilitator endpoint | Observation date (UTC) | Advertised V2 `exact` networks |
| --- | --- | --- |
| [GoPlausible `/supported`](https://facilitator.goplausible.xyz/supported) | 2026-10-26 | Canonical Mainnet and Testnet first, followed by both legacy aliases |

The operator's [2026-10-25 update](https://github.com/x402-foundation/x402/pull/3894#issuecomment-6395714303) reports verify/settle support for both forms during migration, with canonical identifiers stored and reported. Recheck `/supported` before deployment; discovery advertisements and successful verification/settlement are separate checks.

To migrate an integration:

1. Upgrade clients, resource servers, and facilitators to compatible SDK releases with `@x402/avm` >= 2.20.0. Use `ALGORAND_MAINNET_CAIP2` and `ALGORAND_TESTNET_CAIP2` instead of hardcoded network strings.
2. Update producers of `PaymentRequired.accepts[].network`, `PaymentPayload.accepted.network`, settlement `network`, and facilitator `/supported` kinds to use the canonical values. Keep the complete genesis hash in transaction `gh` fields.
3. Advertise canonical facilitator kinds and move resource-server offers to canonical identifiers before deploying clients that reject legacy aliases. Coordinate removal of legacy endpoint support with merchants and follow #3894 for the proposed SDK removal.
4. For a legacy challenge, request a fresh canonical challenge from the updated producer before creating and signing a payment. Do not silently rewrite received challenges or existing signed payloads to pass validation.

See the [Algorand scheme specification](../../../../specs/schemes/exact/scheme_exact_algo.md#network-identifiers-caip-2) for the canonical wire format.

## Signer Implementation

Use the built-in helper functions to create signers from a Base64-encoded private key. These use `generateAddressWithSigners` from `@algorandfoundation/algokit-utils` internally for canonical Ed25519 signing.

### Client Signer

```typescript
import { toClientAvmSigner } from "@x402/avm";

const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY!);
// signer.address — the Algorand address
// signer.signTransactions(txns, indexesToSign) — signs transactions
```

### Facilitator Signer

```typescript
import { toFacilitatorAvmSigner } from "@x402/avm";

// Default (uses AlgorandClient.testNet() / .mainNet() from algokit-utils):
const signer = toFacilitatorAvmSigner(process.env.AVM_PRIVATE_KEY!);

// With custom Algod URLs:
const signer = toFacilitatorAvmSigner(process.env.AVM_PRIVATE_KEY!, {
  testnetUrl: "https://my-testnet-node.example.com",
  mainnetUrl: "https://my-mainnet-node.example.com",
});
```

See [facilitator example](../../examples/typescript/facilitator/) for a full implementation.

## Environment Variables

### Client Applications

Applications that make payments using an Algorand wallet.

| Variable | Required | Description |
|----------|----------|-------------|
| `AVM_PRIVATE_KEY` | Yes | Base64-encoded 64-byte Algorand private key (32-byte seed + 32-byte public key). Used to sign payment transactions. |

### Server (Resource Provider)

Servers that accept payments and build payment requirements.

| Variable | Required | Description |
|----------|----------|-------------|
| `AVM_ADDRESS` | Yes | Algorand wallet address to receive payments (58-character base32 address). |

### Facilitator

Payment processors that verify and settle transactions on-chain.

| Variable | Required | Description |
|----------|----------|-------------|
| `AVM_PRIVATE_KEY` | Yes | Base64-encoded 64-byte Algorand private key. Used to submit settlement transactions and pay fees. |

### Key Format

The `AVM_PRIVATE_KEY` is a Base64-encoded string containing a 64-byte Algorand private key:
- First 32 bytes: Ed25519 seed (signing key)
- Last 32 bytes: Ed25519 public key

To derive the Algorand address from the private key:

```typescript
import { toClientAvmSigner } from "@x402/avm";
const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY!);
console.log(signer.address); // Algorand address
```

### Network Connectivity

The SDK uses `AlgorandClient` from `@algorandfoundation/algokit-utils` for all network connectivity. By default it connects to [AlgoNode](https://algonode.io/) public endpoints (free, no authentication required). Custom endpoints can be configured via `FacilitatorAvmSignerConfig` or by passing an `AlgorandClient` instance via `ClientAvmConfig.algorandClient`.

## Prerequisites: Account Funding & Asset Opt-In

Algorand requires accounts to meet a **Minimum Balance Requirement (MBR)** and explicitly **opt in** to assets before receiving them. This applies to all roles: client, server (payTo), and facilitator.

### 1. Fund Accounts with ALGO

Every Algorand account needs a minimum ALGO balance:
- **Base MBR**: 0.1 ALGO per account
- **Per asset opt-in**: +0.1 ALGO per ASA opted into
- **Facilitator**: needs additional ALGO to cover transaction fees for gasless payments

| Testnet Faucet | URL |
|----------------|-----|
| **ALGO** | https://lora.algokit.io/testnet/fund |
| **USDC** (Circle) | https://faucet.circle.com/ |

### 2. Opt In to USDC ASA

Both the **client** (payer) and **server/payTo** (receiver) accounts must opt in to USDC before any payment can be made. An opt-in is a 0-amount asset transfer to yourself.

| Network | USDC ASA ID |
|---------|-------------|
| Testnet | `10458941` |
| Mainnet | `31566704` |

### 3. Quick Setup (Testnet)

```bash
# 1. Generate a key (or use an existing one)
#    AVM_PRIVATE_KEY is a Base64-encoded 64-byte key (seed + pubkey)

# 2. Fund accounts with ALGO
#    Visit https://lora.algokit.io/testnet/fund

# 3. Fund accounts with testnet USDC
#    Visit https://faucet.circle.com/ (select Algorand Testnet)

# 4. Set environment variables
export AVM_PRIVATE_KEY="<base64-encoded-64-byte-key>"
```

> **Note:** The facilitator account must also be funded with ALGO to cover transaction fees. For gasless payments, the facilitator pays fees on behalf of the client, so ensure the facilitator has sufficient ALGO balance.

## Asset Support

Supports Algorand Standard Assets (ASA):
- USDC (primary)
- Any ASA with proper opt-in

## Transaction Structure

The exact payment scheme uses atomic transaction groups with:
- Payment transaction (ASA transfer or ALGO payment)
- Optional fee payer transaction (gasless transactions)
- Transaction simulation for validation

### Transaction Fees

Algorand transaction fees are dynamic, calculated as:

```
fee = max(current_fee_per_byte × transaction_size, min_fee)
```

Under normal (non-congested) network conditions, `current_fee_per_byte` is 0, so `fee = min_fee = 1000 µAlgo (0.001 ALGO)`. During network congestion, fees can rise above the minimum.

The client fetches `suggestedParams` from the Algorand node to determine the current fee rate. For gasless payments with a fee payer, the exact fee is calculated from the actual encoded byte sizes of all transactions in the group, ensuring correct coverage under both normal and congested conditions via Algorand's native fee pooling.

The facilitator enforces a maximum reasonable fee of **5000 µAlgo per transaction** in the group (5x the normal minimum). For example, a 2-transaction group has a max fee cap of 10,000 µAlgo. This prevents fee extraction attacks while accommodating reasonable congestion surcharges.

## Error Codes

The facilitator returns machine-readable error codes in `invalidReason` (verify) and `errorReason` (settle), using the `invalid_exact_avm_*` prefix convention. Human-readable details are in `invalidMessage` / `errorMessage`.

**Verify errors:** `invalid_exact_avm_invalid_version`, `invalid_exact_avm_scheme`, `invalid_exact_avm_network_mismatch`, `invalid_exact_avm_payload`, `invalid_exact_avm_group_size_exceeded`, `invalid_exact_avm_payment_index`, `invalid_exact_avm_invalid_transaction`, `invalid_exact_avm_invalid_group_id`, `invalid_exact_avm_not_asset_transfer`, `invalid_exact_avm_amount_mismatch`, `invalid_exact_avm_receiver_mismatch`, `invalid_exact_avm_asset_mismatch`, `invalid_exact_avm_invalid_fee_payer`, `invalid_exact_avm_fee_too_high`, `invalid_exact_avm_payment_not_signed`, `invalid_exact_avm_invalid_signature`, `invalid_exact_avm_simulation_failed`, `invalid_exact_avm_facilitator_transferring`, `invalid_exact_avm_unsigned_non_facilitator`

**Settle errors:** `invalid_exact_avm_settlement_failed`, `invalid_exact_avm_confirmation_failed`

See the [AVM exact scheme spec](../../../specs/schemes/exact/scheme_exact_algo.md) for detailed descriptions.

## Development

```bash
# Build
pnpm build

# Test
pnpm test

# Integration tests
pnpm test:integration

# Lint & Format
pnpm lint
pnpm format
```

## Related Packages

- `@x402/core` - Core protocol types and client
- `@x402/fetch` - HTTP wrapper with automatic payment handling
- `@x402/evm` - EVM/Ethereum implementation
- `@x402/svm` - Solana/SVM implementation
- `@algorandfoundation/algokit-utils` - Algorand utility library (dependency)
