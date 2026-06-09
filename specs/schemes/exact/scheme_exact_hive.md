# Scheme: `exact` on `Hive`

## Versions Supported

- ✅ `v1`
- ✅ `v2`

## Supported Networks

- `hive:mainnet` — Hive mainnet

> Hive has an official [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) namespace registered at [ChainAgnostic/namespaces](https://github.com/ChainAgnostic/namespaces/tree/main/hive).

## Summary

The `exact` scheme on Hive executes a native HBD (Hive Backed Dollars) transfer between accounts. Unlike EVM-based schemes, Hive transactions have **zero fees** — the Facilitator simply broadcasts a pre-signed transaction without any gas cost.

HBD is an algorithmic stablecoin pegged to \$1 USD, making it ideal for micropayments. Hive transactions achieve finality in **~3 seconds** with 3-second block intervals.

The Client constructs and signs a standard Hive `transfer` operation using their account's **active key**, embeds a random nonce in the memo field for replay protection, and sends the signed (but unbroadcast) transaction to the Facilitator. The Facilitator verifies the signature against the sender's on-chain active key authority, then broadcasts the transaction to settle payment.

| Property | Value |
|:---|:---|
| **Network** | `hive:mainnet` |
| **Asset** | HBD (Hive Backed Dollars, \$1 peg) |
| **Fee Model** | Zero fees (no gas, no sponsoring needed) |
| **Finality** | ~3 seconds (irreversible) |
| **Signature Scheme** | secp256k1 (Hive active key authority) |
| **Chain ID** | `beeab0de00...00` (32 bytes) |
| **Approval Required** | None (HBD is a first-class asset) |

## Protocol Flow

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with `402 Payment Required` and an `x-payment` header containing base64-encoded `PaymentRequired` with Hive payment requirements.
3. **Client** generates a random 16-byte nonce for replay protection.
4. **Client** fetches the current block reference (`head_block_number`, `head_block_id`) from a Hive API node.
5. **Client** constructs a `transfer` operation: `{from, to, amount, memo: "x402:{nonce}"}`.
6. **Client** signs the transaction with their **active private key** using `cryptoUtils.signTransaction(tx, activeKey, chainId)` where `chainId` = `beeab0de00...00` (Hive mainnet, 32 bytes). The transaction is **not broadcast**.
7. **Client** base64-encodes the `PaymentPayload` (containing the signed transaction and nonce) and sends a new request to the Resource Server with the `x-payment` header.
8. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` to the **Facilitator's** `/settle` endpoint.
   > **Note:** `/verify` is optional and intended for pre-flight checks only. `/settle` MUST perform full verification independently.
9. **Facilitator** verifies the transaction structure, signature, amount, recipient, expiration, and nonce.
10. **Facilitator** broadcasts the signed transaction to the Hive network via `client.broadcast.send()`.
11. **Facilitator** marks the nonce as spent (only after successful broadcast) and responds with a `SettleResponse`.
12. **Resource Server** grants the **Client** access to the resource upon successful settlement.

---

## `PaymentRequirements` for `exact`

**v1 example:**

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "hive:mainnet",
  "maxAmountRequired": "0.050 HBD",
  "resource": "https://api.example.com/premium-data",
  "description": "Access to premium market data",
  "mimeType": "application/json",
  "payTo": "api-provider",
  "validBefore": "2026-02-25T12:05:00Z"
}
```

**v2 example:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "hive:mainnet",
      "asset": "HBD",
      "amount": "0.050 HBD",
      "payTo": "api-provider",
      "maxTimeoutSeconds": 300,
      "extra": {}
    }
  ]
}
```

> In v2, `resource`, `description`, and `mimeType` are lifted to the `PaymentRequired` envelope. The payment amount field is `amount` (v2) instead of `maxAmountRequired` (v1).

**Field Definitions:**

| Field | Type | Description |
|:---|:---|:---|
| `x402Version` | `number` | Protocol version. `1` or `2`. |
| `scheme` | `string` | Must be `"exact"`. |
| `network` | `string` | Must be `"hive:mainnet"`. |
| `maxAmountRequired` | `string` | **(v1 only)** HBD amount in Hive asset format: `"X.XXX HBD"` (3 decimal places). |
| `amount` | `string` | **(v2 only)** HBD amount in Hive asset format: `"X.XXX HBD"` (3 decimal places). Same semantics as v1's `maxAmountRequired`. |
| `resource` | `string` | **(v1 only)** URL of the protected resource. In v2, moved to `PaymentRequired.resource.url`. |
| `description` | `string?` | **(v1 only)** Human-readable description of the resource. In v2, moved to `PaymentRequired.resource.description`. |
| `mimeType` | `string?` | **(v1 only)** MIME type of the resource content. In v2, moved to `PaymentRequired.resource.mimeType`. |
| `asset` | `string` | **(v2 only)** Asset identifier. Must be `"HBD"`. |
| `payTo` | `string` | Hive account name that will receive payment. |
| `maxTimeoutSeconds` | `number` | **(v2 only)** Maximum time allowed for payment completion. |
| `validBefore` | `string` | **(v1 only)** ISO 8601 timestamp after which the payment requirements expire. In v2, implementations may pass the effective expiry separately to the facilitator. |
| `extra` | `object?` | Optional extension data in v1. Required in v2, though it may be an empty object. |

> **Note on `payTo`:** Hive account names are 3–16 character lowercase strings (letters, digits, dots, hyphens), e.g., `"ecency"`, `"api-provider"`. They are human-readable — no hex addresses.

## `PaymentPayload` `payload` Field

The `payload` field of the `PaymentPayload` contains:

- `signedTransaction`: A fully signed Hive transaction containing exactly one `transfer` operation.
- `nonce`: A 16-byte random hex string (32 characters) that matches the transfer memo.

The transfer operation's `memo` field MUST follow the format `x402:{nonce}`.

**Full `PaymentPayload` object:**

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "hive:mainnet",
  "payload": {
    "signedTransaction": {
      "ref_block_num": 54321,
      "ref_block_prefix": 2876543210,
      "expiration": "2026-02-25T12:01:00",
      "operations": [
        [
          "transfer",
          {
            "from": "alice",
            "to": "api-provider",
            "amount": "0.050 HBD",
            "memo": "x402:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
          }
        ]
      ],
      "extensions": [],
      "signatures": [
        "2030a1b2c3d4...65-byte-hex-encoded-signature..."
      ]
    },
    "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
  }
}
```

### Payload Construction

The Client constructs the payment as follows:

1. **Generate nonce**: 16 random bytes → hex string (32 characters).
2. **Fetch block reference**: Query `database.getDynamicGlobalProperties()` from a Hive API node to obtain:
   - `ref_block_num`: `head_block_number & 0xFFFF`
   - `ref_block_prefix`: `readUInt32LE(4)` from `head_block_id` bytes
3. **Set expiration**: Current UTC time + 60 seconds, formatted as `"YYYY-MM-DDTHH:MM:SS"` (no timezone suffix — Hive uses UTC implicitly). Maximum allowed: 3600 seconds.
4. **Construct transfer operation**:
   - `from`: Client's Hive account name
   - `to`: `paymentRequirements.payTo`
   - `amount`: the payment amount from `paymentRequirements` (`maxAmountRequired` in v1, `amount` in v2), e.g., `"0.050 HBD"`
   - `memo`: `"x402:{nonce}"`
5. **Sign transaction**: `cryptoUtils.signTransaction(tx, activePrivateKey, chainId)` where `chainId` is `beeab0de00000000000000000000000000000000000000000000000000000000` (Hive mainnet chain ID, 32 bytes).
6. **Encode**: Base64-encode the JSON `PaymentPayload` and set as the `x-payment` request header.

> **Important:** The transaction is signed but **NOT** broadcast by the Client. Only the Facilitator broadcasts.

---

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact` scheme on Hive MUST enforce all of the following checks:

### 1. Transaction Structure

- The signed transaction MUST contain exactly **one operation**.
- The operation type MUST be `"transfer"`.

### 2. Recipient and Asset

- `transfer.to` MUST equal `paymentRequirements.payTo`.
- `transfer.amount` MUST end with `" HBD"`. Only HBD payments are accepted.
- If `paymentRequirements.asset` is present, it MUST equal `"HBD"`.
- The numeric portion of `transfer.amount` MUST be ≥ the numeric portion of the payment amount field (`paymentRequirements.maxAmountRequired` in v1, `paymentRequirements.amount` in v2).

### 3. Temporal Validity

- `signedTransaction.expiration` MUST be in the future (transaction not yet expired).
- For v1, `paymentRequirements.validBefore` MUST be in the future (payment window still open).
- For v2, implementations MUST enforce an equivalent expiry window using the request context supplied alongside the payment requirements.

### 4. Signature Verification

- The transaction MUST have at least one signature in `signedTransaction.signatures`.
- Compute the transaction digest: `cryptoUtils.transactionDigest(signedTx, chainId)` where `chainId` = `beeab0de00...00` (Hive mainnet, 32 bytes).
- Recover the public key: `Signature.fromString(signatures[0]).recover(digest)`.
- Fetch the sender's account from the Hive blockchain: `database.getAccounts([transfer.from])`.
- The recovered public key MUST match at least one entry in the account's `active.key_auths` array.

### 5. Replay Protection

- The `payload.nonce` MUST NOT have been previously spent.
- The `transfer.memo` MUST follow the format `x402:{nonce}` and the nonce MUST match `payload.nonce`.

### 6. Facilitator Safety

- The Facilitator MUST NOT modify any field of the signed transaction before broadcasting. Modifying any field invalidates the signature.
- The Facilitator incurs **zero cost** from broadcasting (Hive has no transaction fees), so there is no gas-sponsoring attack vector.
- The Facilitator MUST verify the signature recovers to the `transfer.from` account's active key — not to any other account.

### Verification Response

```json
{
  "isValid": true,
  "payer": "alice"
}
```

On failure:

```json
{
  "isValid": false,
  "invalidReason": "Recipient mismatch: expected api-provider, got other-account"
}
```

---

## Settlement Logic

Settlement is performed by broadcasting the pre-signed transaction to the Hive network.

### Phase 1: Re-verification

1. **Check nonce**: Confirm the nonce has not been spent since initial verification.
2. **Re-verify**: Run the full verification logic above. `/settle` MUST NOT assume prior `/verify` was called.

### Phase 2: Broadcast

1. **Submit transaction**: Call `client.broadcast.send(signedTransaction)` to submit to the Hive network.
2. **Failover**: Implementations SHOULD use multiple Hive API nodes with round-robin selection and automatic failover.
3. **Await confirmation**: The broadcast call returns a `TransactionConfirmation` with `id` (transaction hash) and `block_num`.

### Phase 3: Finalize

1. **Mark nonce spent**: Only **after** a successful broadcast confirmation, mark the nonce as spent in the nonce store. This ordering ensures that if broadcast fails, the nonce remains available for retry.
2. **Return `SettleResponse`**:

```json
{
  "success": true,
  "txId": "abc123def456789...",
  "blockNum": 12345678,
  "payer": "alice"
}
```

On failure:

```json
{
  "success": false,
  "errorReason": "Verification failed: Insufficient payment"
}
```

### Settlement Guarantees

- **Zero cost**: Hive transactions have no fees. The Facilitator incurs no cost from broadcasting.
- **Atomic**: The signed transaction either executes completely or not at all.
- **Non-modifiable**: The Facilitator cannot alter the transaction (amount, recipient, or any field) because doing so would invalidate the cryptographic signature.
- **Replay-safe**: Each nonce can only be settled once, preventing double-spending.
- **Fast finality**: Transactions are included in the next block (~3 seconds) and become irreversible shortly after.

---

## Implementer Notes

- **Hive API Nodes**: Implementations should use multiple public Hive API nodes with failover. Well-known nodes include: `api.hive.blog`, `api.deathwing.me`, `techcoderx.com`, `rpc.ausbit.dev`, `hive-api.arcange.eu`.

- **Key Authority Model**: Hive accounts use a hierarchical key system with `owner` > `active` > `posting` authorities. The `active` key authority is required for financial operations (transfers). An account may have multiple active keys (multi-sig / multi-authority), and the signature must match at least one of them.

- **Asset Format**: HBD amounts use exactly 3 decimal places followed by a space and the symbol: `"0.050 HBD"`. This is Hive's canonical asset string format enforced at the protocol level.

- **Transaction Expiration**: Hive enforces a maximum transaction expiration of 3600 seconds (1 hour) from the head block time. The x402 implementation defaults to 60 seconds for tighter security.

- **Nonce Storage**: Implementations must persist spent nonces to survive server restarts. SQLite with WAL mode is suitable for single-node deployments; Redis with TTL (recommended: 86400 seconds) is appropriate for distributed setups.

- **No Approval Step**: Unlike EVM tokens that require ERC-20 approval or Permit2 flows, HBD is a first-class blockchain asset. Any Hive account holding HBD can immediately sign a transfer — no prior setup, approval transaction, or gas is needed. This makes the x402 flow simpler on Hive than on EVM chains.

- **Account Names**: Hive uses human-readable account names (3–16 lowercase characters) instead of hex addresses. This improves UX for payment configuration (`payTo: "ecency"` vs `payTo: "0x209693Bc6..."`) and makes debugging easier.

---

## Reference Implementation

A complete TypeScript implementation is available at [`@hiveio/x402`](https://github.com/ecency/hive-x402) on npm:

```
npm install @hiveio/x402
```

The package provides three subpath exports:

| Import | Purpose |
|:---|:---|
| `@hiveio/x402/client` | Client SDK — sign payments, auto-pay 402 responses |
| `@hiveio/x402/middleware` | Express/Next.js middleware — protect endpoints with paywall |
| `@hiveio/x402/facilitator` | Facilitator server — verify and settle payments |

```ts
// Client: sign a payment
import { signPayment } from "@hiveio/x402/client";

const header = await signPayment({
  account: "alice",
  activeKey: "5K...",
  requirements: paymentRequirements,
});

// Middleware: protect an Express endpoint
import { paywall } from "@hiveio/x402/middleware";

app.get("/premium", paywall({
  payTo: "api-provider",
  amount: "0.050 HBD",
  facilitatorUrl: "https://x402.ecency.com",
}), handler);

// Facilitator: run the verification/settlement server
import { createFacilitator } from "@hiveio/x402/facilitator";

const app = createFacilitator();
app.listen(4020);
```

### Public Facilitator

A public Facilitator is hosted at **`https://x402.ecency.com`** with the following endpoints:

| Method | Path | Description |
|:---|:---|:---|
| `POST` | `/verify` | Verify a signed payment without broadcasting |
| `POST` | `/settle` | Verify and broadcast a signed payment |
| `GET` | `/health` | Health check — returns `{"status": "ok"}` |
| `GET` | `/supported-networks` | Returns `["hive:mainnet"]` |
