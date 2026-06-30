# @x402/concordium

Concordium blockchain implementation of the x402 payment protocol using the **Exact** payment scheme with **sponsored transactions (V1)**.

## Installation

```bash
npm install @x402/concordium
```

## Overview

This package provides three components for handling x402 payments on Concordium:

- **Client** — Builds and sender-signs a V1 sponsored transaction, returning the partially-signed payload
- **Facilitator** — Verifies the payload against 9 security rules, adds sponsor signature, submits to the network, and waits for finalization
- **Server** — Builds `PaymentRequirements` with price parsing, asset registration, and facilitator-provided `feePayer` enrichment

## Sponsored Transaction Flow

Unlike EVM (where the facilitator executes an off-chain signature via `TransferWithAuthorization`), Concordium uses **V1 sponsored transactions** where the facilitator pays gas on behalf of the sender:

1. Client builds a transfer transaction naming the facilitator as sponsor
2. Client signs as sender (sponsor signature slot left empty)
3. Client sends the partially-signed transaction to the server
4. Facilitator verifies the transaction structure and parameters
5. Facilitator adds its sponsor signature, submits to the network, and waits for ConcordiumBFT finalization (~10s deterministic finality)
6. Server grants access to the resource

The client never broadcasts — the facilitator handles submission after sponsoring.

## Supported Assets

| Type | Symbol | Description | Decimals |
|------|--------|-------------|----------|
| Native | CCD | Native Concordium token | 6 |
| PLT | EURR, USDR, etc. | PLT standard tokens | Token-dependent (fetched from chain) |

## Testnet Faucets

- **CCD (native, testnet):**
  1. Set up the Concordium Wallet for Web on **Testnet**.
  2. Open your testnet account.
  3. Go to **Activity**.
  4. Click **Request CCD**.
  5. The account is credited with test CCD shortly after.
  - Official guide: https://docs.concordium.com/en/mainnet/docs/plt/setup-guide/request-ccd.html
  - Note: Concordium documents that each account can request test CCD only once, and only before it has incoming transactions.
- **PLT (testnet):**
  1. Fund your account with test CCD first.
  2. Prepare the PLT metadata and token parameters.
  3. Submit the official testnet PLT issuance request form.
  4. Concordium issues the token manually to your nominated governance account.
  5. Mint or distribute balances from that account for your tests.
  - Official guide: https://docs.concordium.com/en/mainnet/tutorials/plt/request-plt.html
  - There is no universal public faucet for arbitrary PLT symbols such as `EURR`; you must use an issuer-provided distribution or request your own test PLT.

## Usage

### 1. Client Setup

The client builds and sender-signs a V1 sponsored transaction. It needs a Concordium account address and Ed25519 private key.

```typescript
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { buildBasicAccountSigner, AccountAddress } from "@concordium/web-sdk";

const signer = {
  accountAddress: AccountAddress.fromBase58(process.env.CCD_ADDRESS!),
  signer: buildBasicAccountSigner(process.env.CCD_PRIVATE_KEY!),
};

const scheme = new ExactConcordiumScheme(signer);

// createPaymentPayload is called automatically by x402 client internals:
// 1. Fetches sender nonce from node
// 2. Builds CCD or PLT transfer
// 3. Sets facilitator as sponsor (from requirements.extra.feePayer)
// 4. Signs as sender via Transaction.sign()
// 5. Returns { signedTransaction, sender } payload
```

With custom gRPC endpoint:

```typescript
const scheme = new ExactConcordiumScheme(signer, {
  grpcUrl: "localhost:20000",
  useTls: false,
});
```

### 2. Server Setup

The server builds `PaymentRequirements` from route configuration. The facilitator announces the active `feePayer` in `/supported`, and the server copies it into `requirements.extra.feePayer` during `enhancePaymentRequirements()`.

```typescript
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";

const scheme = new ExactConcordiumScheme();

// Route configuration examples:

// Native CCD payment — use AssetAmount with atomic units
const ccdRoute = {
  scheme: "exact",
  network: "ccd:9dd9ca4d19e9393877d2c44b70f89acb",
  payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
  price: { amount: "10000000", asset: "CCD" },  // 10 CCD in microCCD
  description: "Premium content",
  mimeType: "application/json",
};

// PLT token payment — use AssetAmount with token symbol
const pltRoute = {
  scheme: "exact",
  network: "ccd:9dd9ca4d19e9393877d2c44b70f89acb",
  payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
  price: { amount: "5000000", asset: "EURR" },  // 5 EURR in atomic units
  description: "Premium content - 5 EURR",
  mimeType: "application/json",
};

// USD-style prices — register a money parser to map "$0.01" to a token
scheme.registerMoneyParser(async (amount, network) => ({
  amount: String(Math.round(amount * 1e6)),
  asset: "EURR",
  extra: {},
}));
const usdRoute = {
  scheme: "exact",
  network: "ccd:9dd9ca4d19e9393877d2c44b70f89acb",
  payTo: "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
  price: "$0.01",  // Parsed by registerMoneyParser → 0.01 EURR
  description: "Premium content",
  mimeType: "application/json",
};
```

### 3. Facilitator Setup

The facilitator verifies partially-signed transactions, adds its sponsor signature, submits to the network, and waits for finalization.

```typescript
import { ExactConcordiumScheme } from "@x402/concordium/exact/facilitator";
import {
  CONCORDIUM_MAINNET_CAIP2,
  getConcordiumGrpcUrl,
  parseGrpcUrl,
  toConcordiumFacilitatorSigner,
} from "@x402/concordium";

// Resolve gRPC endpoint from network
const network = CONCORDIUM_MAINNET_CAIP2; // mainnet
const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(network));

// Create facilitator signer (gRPC client created internally)
const signer = toConcordiumFacilitatorSigner(
  process.env.CCD_FACILITATOR_ADDRESS!,
  process.env.CCD_FACILITATOR_PRIVATE_KEY!,
  { host, port, useTls: true },
);

// Create scheme
const scheme = new ExactConcordiumScheme({
  signer,
  requireFinalization: true,      // default: true
  finalizationTimeoutMs: 60_000,  // default: 60000
  maxExpiryOffsetSeconds: 600,    // default: 600
});

// verify() and settle() are called by x402 facilitator internals
```

## Payment Flow

```
┌──────────┐      ┌──────────┐      ┌──────────────┐      ┌────────────┐
│  Client  │      │  Server  │      │ Facilitator  │      │ Concordium │
└────┬─────┘      └────┬─────┘      └──────┬───────┘      └─────┬──────┘
     │                  │                    │                     │
     │  1. GET /resource                     │                     │
     │─────────────────>│                    │                     │
     │                  │                    │                     │
     │  2. 402 + PaymentRequirements         │                     │
     │     (includes extra.feePayer)         │                     │
     │<─────────────────│                    │                     │
     │                  │                    │                     │
     │  3. Fetch nonce from node             │                     │
     │────────────────────────────────────────────────────────────>│
     │                  │                    │                     │
     │  4. Build V1 sponsored tx             │                     │
     │     (sponsor = facilitator address)   │                     │
     │     Sign as sender                    │                     │
     │     Sponsor signature slot = empty    │                     │
     │                  │                    │                     │
     │  5. GET /resource + PAYMENT-SIGNATURE  │                     │
     │     payload: { signedTransaction,     │                     │
     │               sender }                │                     │
     │─────────────────>│                    │                     │
     │                  │                    │                     │
     │                  │  6. verify(payload, requirements)        │
     │                  │───────────────────>│                     │
     │                  │                    │                     │
     │                  │    Enforces 9 rules:                     │
     │                  │    - Version == 1                        │
     │                  │    - Sender identity                     │
     │                  │    - Sponsor identity                    │
     │                  │    - Transfer destination                │
     │                  │    - Amount == required                  │
     │                  │    - Asset type match                    │
     │                  │    - Expiry valid                        │
     │                  │    - Sender signature verified           │
     │                  │    - Payload safety                      │
     │                  │                    │                     │
     │                  │  7. VerifyResponse  │                     │
     │                  │<───────────────────│                     │
     │                  │                    │                     │
     │                  │  8. settle(payload, requirements)        │
     │                  │───────────────────>│                     │
     │                  │                    │                     │
     │                  │    Re-verify       │                     │
     │                  │    Add sponsor sig │                     │
     │                  │    Finalize tx     │                     │
     │                  │                    │  9. sendTransaction  │
     │                  │                    │────────────────────>│
     │                  │                    │                     │
     │                  │                    │  10. waitForFinalization
     │                  │                    │────────────────────>│
     │                  │                    │                     │
     │                  │                    │  11. Defense-in-depth│
     │                  │                    │      sender/recipient│
     │                  │                    │                     │
     │                  │  12. SettleResponse│                     │
     │                  │<───────────────────│                     │
     │                  │                    │                     │
     │  13. 200 OK + Resource                │                     │
     │<─────────────────│                    │                     │
```

## Facilitator Verification Rules

The facilitator enforces all 9 rules before sponsoring:

1. **Transaction version** — Must be V1 sponsored format, deserializable from JSON
2. **Sender identity** — `header.sender` matches `payload.sender`, valid base58
3. **Sponsor identity** — `header.sponsor.account` matches facilitator's own address
4. **Transfer destination** — Recipient matches `PaymentRequirements.payTo`
5. **Amount (exact match)** — Transfer amount must equal `PaymentRequirements.amount` exactly
6. **Asset type** — SimpleTransfer for CCD, TokenUpdate with matching tokenId for PLT
7. **Expiry** — In the future and ≤ 10 minutes from now
8. **Sender signature** — Cryptographically verified against on-chain account credentials
9. **Payload safety** — Exactly one operation, sponsor not sender/recipient

## Payload Format

The `PaymentPayload.payload` field for the exact scheme (x402Version: 2):

```json
{
  "signedTransaction": {
    "version": 1,
    "header": {
      "sender": "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN",
      "nonce": 42,
      "expiry": 1700000300,
      "executionEnergyAmount": 300,
      "numSignatures": 1,
      "sponsor": {
        "account": "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
        "numSignatures": 1
      }
    },
    "payload": {
      "type": "transfer",
      "toAddress": "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
      "amount": "1000000"
    },
    "signatures": {
      "sender": { "0": { "0": "a1b2c3..." } }
    }
  },
  "sender": "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN"
}
```

The `signatures.sender` is populated by the client. The facilitator adds `signatures.sponsor` during settlement.

## Supported Networks

| Network | CAIP-2 Identifier | gRPC Endpoint |
|---------|-------------------|---------------|
| Mainnet | `ccd:9dd9ca4d19e9393877d2c44b70f89acb` | `grpc.mainnet.concordium.software:20000` |
| Testnet | `ccd:4221332d34e1694168c2a0c0b3fd0f27` | `grpc.testnet.concordium.com:20000` |

Wildcard `ccd:*` matches all Concordium networks for client and facilitator registration.

## Constants

```typescript
import {
  CONCORDIUM_MAINNET_CAIP2,
  CONCORDIUM_TESTNET_CAIP2,
  getConcordiumGrpcUrl,
  parseGrpcUrl,
  getExplorerTxUrl,
  getExplorerAccountUrl,
} from "@x402/concordium";

// Resolve gRPC endpoint
const grpcUrl = getConcordiumGrpcUrl(CONCORDIUM_MAINNET_CAIP2);
// "grpc.mainnet.concordium.software:20000"

const [host, port] = parseGrpcUrl(grpcUrl);
// ["grpc.mainnet.concordium.software", 20000]

// Explorer links
const txUrl = getExplorerTxUrl(CONCORDIUM_TESTNET_CAIP2, "a1b2c3...");
// "https://ccdexplorer.io/testnet/transaction/a1b2c3..."

const accountUrl = getExplorerAccountUrl(CONCORDIUM_MAINNET_CAIP2, "4Fmi...");
// "https://ccdexplorer.io/mainnet/account/4Fmi..."
```

## Amount Format

All amounts in `PaymentRequirements` and payloads are in the smallest unit (atomic):

| Asset Type | Unit | Decimals | Example: 10 CCD / 5 EURR |
|------------|------|----------|---------------------------|
| Native CCD | microCCD | 6 | `"10000000"` |
| PLT Token | Smallest subunit | depends on token | `"5000000"` |

Prices are specified as `AssetAmount` objects with atomic units:

```typescript
// AssetAmount pass-through — amounts are used as-is in atomic units
// price: { amount: "10000000", asset: "CCD" }   → 10 CCD
// price: { amount: "5000000", asset: "EURR" }   → 5 EURR
// price: { amount: "1000", asset: "USDR" }      → 1000 USDR atomic units
```

Raw numbers and USD strings (`"10"`, `"$0.01"`) are **not** automatically converted to CCD. To accept money-style prices, register a money parser via `scheme.registerMoneyParser()`. Without a parser, money prices throw `"Cannot resolve price"`. There is no silent CCD fallback.


## API Reference

### ClientConcordiumSigner

```typescript
interface ClientConcordiumSigner {
  accountAddress: AccountAddress.Type;
  signer: AccountSigner;
}
```

### GrpcConfig

```typescript
interface GrpcConfig {
  host: string;
  port: number;
  useTls?: boolean;
}
```

### FacilitatorConcordiumSigner

```typescript
interface FacilitatorConcordiumSigner {
  getAddress(): string;
  getAccountInfo(address: string): Promise<AccountInfo>;
  getTokenBalance(address: string, tokenId: string): Promise<bigint | undefined>;
  addSponsorSignature(tx: SignableV1Transaction): Promise<Transaction.JSON>;
  submitTransaction(signedTxJSON: Transaction.JSON): Promise<string>;
  waitForFinalization(txHash: string, timeoutMs?: number): Promise<TransactionInfo>;
}
```

### ExactConcordiumSchemeConfig (Facilitator)

```typescript
interface ExactConcordiumSchemeConfig {
  signer: FacilitatorConcordiumSigner | FacilitatorConcordiumSigner[];
  requireFinalization?: boolean;        // default: true
  finalizationTimeoutMs?: number;       // default: 60000
  maxExpiryOffsetSeconds?: number;      // default: 600
}
```

### Types

```typescript
// Transaction status from on-chain queries
interface TransactionInfo {
  txHash: string;
  status: "pending" | "committed" | "finalized" | "failed";
  sender: string;
  recipient?: string;
  amount?: string;
  asset?: string;  // "" for CCD, token symbol for PLT
}

// V2 payment payload (sent in PAYMENT-SIGNATURE header)
interface ExactConcordiumPayloadV2 {
  signedTransaction: SignableV1Transaction;
  sender: string;
}
```

## Error Codes

### Verification errors (from `verify()`)

| Code | Rule | Description |
|------|------|-------------|
| `missing_payload` | — | Payload is null or not an object |
| `invalid_transaction_format` | 1 | Cannot deserialize transaction |
| `invalid_transaction_version` | 1 | Version is not 1 |
| `missing_sender` / `invalid_sender_address` | 2 | Sender missing or invalid base58 |
| `sender_header_mismatch` | 2 | `header.sender` ≠ `payload.sender` |
| `missing_sponsor_in_header` / `sponsor_mismatch` | 3 | Sponsor missing or doesn't match facilitator |
| `transaction_expired` / `expiry_too_far_in_future` | 7 | Expiry out of valid window |
| `sponsor_as_sender` / `sponsor_as_recipient` | 9 | Sponsor appears in transfer |
| `unexpected_transaction_type` | 9 | Not a transfer or tokenUpdate |
| `asset_type_mismatch` / `token_id_mismatch` | 6 | Wrong tx type for expected asset |
| `missing_recipient` / `recipient_mismatch` | 4 | Recipient doesn't match payTo |
| `amount_mismatch` | 5 | Amount does not equal required |
| `missing_sender_signature` / `invalid_sender_signature` | 8 | Signature absent or cryptographically invalid |
| `signature_verification_failed` | 8 | Could not verify against on-chain credentials |

### Settlement errors (from `settle()`)

| Code | Description |
|------|-------------|
| `sponsor_signing_failed` | Failed to add sponsor signature |
| `submission_failed` | gRPC send failed |
| `finalization_failed` / `finalization_timeout` | On-chain finalization issue |
| `on_chain_sender_mismatch` | Defense-in-depth: sender differs |
| `on_chain_recipient_mismatch` | Defense-in-depth: recipient differs |

## File Structure

```
@x402/concordium/
├── index.ts                    # Package entry point
├── constants.ts                # CAIP-2 identifiers, gRPC URLs, explorer, limits
├── types.ts                    # SignableV1Transaction, ExactConcordiumPayloadV2, TransactionInfo
├── signer.ts                   # ClientConcordiumSigner, FacilitatorConcordiumSigner, factory
└── exact/
    ├── client/
    │   ├── scheme.ts           # Builds + sender-signs V1 sponsored tx
    │   └── index.ts
    ├── server/
    │   ├── scheme.ts           # Price parsing, asset registration
    │   └── index.ts
    └── facilitator/
        ├── scheme.ts           # 9-rule verify + sponsor-sign-submit settle
        └── index.ts
```

## Related Packages

- `@x402/core` — Core protocol types, client, facilitator, and server
- `@x402/fetch` — HTTP wrapper with automatic payment handling
- `@concordium/web-sdk` — Concordium SDK (dependency)
