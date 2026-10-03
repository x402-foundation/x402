# Scheme: `exact` on `Zcash`

## Summary

The `exact` scheme on Zcash executes a transfer where the **client sends ZEC directly** on the Zcash blockchain via a shielded (Orchard) transaction. Unlike EVM and Solana implementations, there is no off-chain signature or facilitator-driven settlement — the client is the sole transaction broadcaster.

The facilitator's role is **verification only**: confirming that the payment was received by performing Orchard trial decryption using the recipient's Unified Full Viewing Key (UFVK).

### Key Properties

| Property | Value |
|:---------|:------|
| Settlement | Client-driven (on-chain before verification) |
| Verification | Trial decryption of Orchard shielded outputs |
| Privacy | Fully encrypted (sender, receiver, amount, memo) |
| Gas/Fees | Client pays network fee (~0.00001 ZEC) |
| Facilitator role | Verify-only (no settlement, no custody) |
| Token | ZEC (native asset) |

---

## Protocol Flow

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with a 402 containing `PaymentRequired`. The `accepts` array includes a Zcash payment option with `network: "zcash:mainnet"`.
3. **Client** sends a shielded ZEC transaction on-chain to the `payTo` address for the required `amount`.
4. **Client** waits for the transaction to appear in the mempool or be confirmed (typically 5–20 seconds).
5. **Client** sends a new request to the resource server with the `PAYMENT-SIGNATURE` header containing the base64-encoded `PaymentPayload` with the Zcash transaction ID.
6. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` to the **Facilitator's** `/verify` endpoint.
7. **Facilitator** retrieves the transaction from the Zcash network and performs Orchard trial decryption using the merchant's UFVK.
8. **Facilitator** returns a `VerifyResponse` to the **Resource Server**.
9. **Resource Server**, upon successful verification, grants the **Client** access and returns a `PAYMENT-RESPONSE` header.

```
Client                    Resource Server              Facilitator (CipherPay)
  │                            │                              │
  │  GET /api/data             │                              │
  │───────────────────────────>│                              │
  │                            │                              │
  │  402 Payment Required      │                              │
  │  PAYMENT-REQUIRED: base64  │                              │
  │<───────────────────────────│                              │
  │                            │                              │
  │  (sends shielded ZEC       │                              │
  │   on-chain to payTo)       │                              │
  │                            │                              │
  │  GET /api/data             │                              │
  │  PAYMENT-SIGNATURE: base64 │                              │
  │───────────────────────────>│                              │
  │                            │  POST /verify                │
  │                            │  { payload, requirements }   │
  │                            │─────────────────────────────>│
  │                            │                              │
  │                            │  { valid: true }             │
  │                            │<─────────────────────────────│
  │                            │                              │
  │  200 OK                    │                              │
  │  PAYMENT-RESPONSE: base64  │                              │
  │<───────────────────────────│                              │
```

### Key Differences from EVM and SVM

| Aspect | EVM (`exact`) | SVM (`exact`) | Zcash (`exact`) |
|--------|---------------|---------------|-----------------|
| Authorization | Off-chain EIP-712 signature | Partially-signed tx | On-chain transaction |
| Settlement | Facilitator submits tx | Facilitator co-signs tx | Client sends directly |
| Verification | Signature recovery + simulation | Tx inspection + simulation | Trial decryption |
| Privacy | Fully public | Fully public | Fully encrypted |
| Gas/Fees | Facilitator sponsors | Facilitator sponsors | Client pays (~0.00001 ZEC) |
| Token | Any ERC-20 | Any SPL | ZEC (native) |

---

## `PaymentRequirements`

```json
{
  "scheme": "exact",
  "network": "zcash:mainnet",
  "asset": "ZEC",
  "amount": "100000",
  "payTo": "u1j3ufzq2cvqa...",
  "maxTimeoutSeconds": 120,
  "extra": {}
}
```

| Field | Description |
|-------|-------------|
| `scheme` | MUST be `"exact"` |
| `network` | MUST be `"zcash:mainnet"` or `"zcash:testnet"` (CAIP-2) |
| `asset` | MUST be `"ZEC"` |
| `amount` | Payment amount in zatoshis (1 ZEC = 10^8 zatoshis) |
| `payTo` | Zcash Unified Address (starts with `u1`) |
| `maxTimeoutSeconds` | Maximum time in seconds to wait for verification |
| `extra` | Empty object `{}` (reserved for future extensions) |

---

## `PAYMENT-SIGNATURE` Header Payload

The `payload` field of the `PaymentPayload` contains:

```json
{
  "txid": "7f3a9b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f"
}
```

The `txid` is the 64-character hexadecimal Zcash transaction ID from the shielded transaction the client submitted.

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/data",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "zcash:mainnet",
    "asset": "ZEC",
    "amount": "100000",
    "payTo": "u1j3ufzq2cvqa...",
    "maxTimeoutSeconds": 120,
    "extra": {}
  },
  "payload": {
    "txid": "7f3a9b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f"
  }
}
```

---

## Verification

A facilitator verifying an `exact`-scheme Zcash payment MUST enforce all of the following:

### 1. Transaction Existence

Retrieve the transaction from the Zcash network by `txid`. The transaction MUST exist in the mempool or in a confirmed block.

### 2. Trial Decryption

Perform Orchard trial decryption on the transaction's shielded outputs using the recipient's UFVK (Unified Full Viewing Key). At least one output MUST decrypt successfully.

### 3. Amount Verification

The sum of successfully decrypted output values sent to the recipient MUST be greater than or equal to the `amount` specified in the `PaymentRequirements`.

### 4. Address Verification

The decrypted output(s) MUST be addressed to the `payTo` Unified Address.

### 5. Duplicate Payment Prevention (RECOMMENDED)

The facilitator SHOULD maintain a cache of recently verified transaction IDs. If a `txid` has already been used to grant access to a resource, the facilitator MUST indicate this in the response (e.g., `previously_verified: true`). Resource servers SHOULD reject previously-used payments.

### 6. Timeout Enforcement

If the facilitator cannot retrieve and verify the transaction within the `maxTimeoutSeconds` window, verification MUST fail.

### Why Trial Decryption?

Zcash shielded transactions encrypt all output data (recipient, amount, memo) on-chain using the recipient's public key. The only way to verify a payment was received is to attempt decryption using the recipient's viewing key. This is a non-interactive, non-custodial, read-only operation — the viewing key cannot spend funds or sign transactions.

---

## Settlement

Unlike EVM and SVM, Zcash settlement is **client-driven**:

1. The client constructs and broadcasts a shielded Zcash transaction **before** sending the `PaymentPayload`.
2. The facilitator does **not** submit, co-sign, or broadcast any transaction.
3. The facilitator exposes only a `/verify` endpoint — there is no `/settle` endpoint for Zcash.

This means:
- The facilitator never holds or moves funds.
- The client pays the network fee directly (~0.00001 ZEC).
- There is no gas sponsorship by the facilitator.
- Transaction finality is determined by the Zcash network.

### `SettlementResponse`

Since settlement is client-driven, the `PAYMENT-RESPONSE` header contains a verification confirmation rather than a settlement receipt:

```json
{
  "success": true,
  "txid": "7f3a9b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f",
  "network": "zcash:mainnet"
}
```

---

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact`-scheme Zcash payment MUST enforce:

1. **Transaction validity**: The `txid` MUST reference a valid Zcash transaction that exists on-chain or in the mempool.

2. **Shielded outputs**: The transaction MUST contain Orchard shielded outputs. Transparent-only transactions MUST be rejected.

3. **Decryption success**: At least one Orchard output MUST successfully decrypt using the recipient's UFVK.

4. **Amount match**: The decrypted value MUST be greater than or equal to `PaymentRequirements.amount`.

5. **Recipient match**: The decrypted recipient MUST match `PaymentRequirements.payTo`.

6. **No facilitator custody**: The facilitator MUST NOT hold private keys, spending keys, or any credential that could move funds. Only UFVKs (read-only) are permitted.

---

## Appendix

### Network Identifiers (CAIP-2)

| Name | CAIP-2 ID |
|------|-----------|
| Zcash mainnet | `zcash:mainnet` |
| Zcash testnet | `zcash:testnet` |

### Amount Units

Amounts in `PaymentRequirements` are specified in **zatoshis** (1 ZEC = 100,000,000 zatoshis), following the x402 convention of using the asset's smallest denomination.

| ZEC | Zatoshis | String |
|-----|----------|--------|
| 0.001 | 100,000 | `"100000"` |
| 0.01 | 1,000,000 | `"1000000"` |
| 0.1 | 10,000,000 | `"10000000"` |
| 1.0 | 100,000,000 | `"100000000"` |

### Privacy Guarantees

Zcash shielded transactions provide privacy properties not available in EVM or SVM x402 payments:

- **Sender privacy**: The payer's address is not visible on-chain.
- **Receiver privacy**: The recipient's address is encrypted in the output.
- **Amount privacy**: The transfer amount is encrypted.
- **Memo privacy**: The transaction memo (if any) is encrypted.
- **Unlinkability**: Multiple payments from the same sender cannot be linked by an external observer.

Only the facilitator (holding the recipient's viewing key) can verify the payment. No on-chain observer can determine which API was paid for, how much was paid, or who paid.

### Security Considerations

1. **Viewing key scope**: The UFVK grants read-only access to incoming transactions. It cannot spend funds or sign transactions.

2. **Replay prevention**: Each Zcash transaction ID is unique and can only be mined once. The facilitator's duplicate detection cache provides application-level replay prevention.

3. **Confirmation depth**: For high-value payments, resource servers MAY require a minimum number of block confirmations before granting access. For micropayments, mempool presence is typically sufficient.

4. **Transaction finality**: Zcash uses Proof-of-Work consensus with a target block time of 75 seconds. Zero-confirmation payments are suitable for low-value API calls but carry a theoretical double-spend risk for large amounts.

### Reference Facilitator

**CipherPay** ([cipherpay.app](https://cipherpay.app)) is the reference Zcash facilitator for x402.

| Property | Value |
|----------|-------|
| Verify endpoint | `POST https://api.cipherpay.app/api/x402/verify` |
| Authentication | `Authorization: Bearer <api_key>` |
| Verification method | Orchard trial decryption using merchant UFVK |
| Custody | Non-custodial (viewing key only) |
| Open source | [github.com/atmospherelabs-dev/cipherpay](https://github.com/atmospherelabs-dev/cipherpay) |

### Server Middleware (npm)

```bash
npm install @cipherpay/x402
```

```typescript
import { zcashPaywall } from '@cipherpay/x402/express';

app.use('/api/premium', zcashPaywall({
  amount: 0.001,
  address: 'u1abc...',
  apiKey: 'cpay_sk_...',
}));
```
