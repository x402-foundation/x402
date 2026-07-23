# Scheme: `exact` on `Lightning Network`

## Summary

The `exact` scheme on Lightning Network uses BOLT11 invoices to transfer a specific amount of bitcoin from the payer to the resource server. Unlike blockchain-based schemes, Lightning payments are settled off-chain with instant finality, and the invoice itself serves as both the payment request and proof of payment.

**Version Support:** This specification supports x402 v2 protocol only.

## Protocol Sequencing

The protocol flow for `exact` on Lightning Network is client-driven and simplified compared to blockchain schemes, as no facilitator is required:

1. Client makes a request to a `resource server` and receives a `402 Payment Required` response.
2. Resource server generates a BOLT11 invoice using a Lightning wallet API or Lightning node.
3. Resource server returns payment requirements including the invoice in the `extra.invoice` field.
4. Client pays the invoice using their Lightning wallet (out-of-band payment, outside the x402 protocol).
5. Client resends the request to the `resource server` including the paid invoice in the `PAYMENT-SIGNATURE` header.
6. Resource server verifies the payment by checking the invoice status with their Lightning wallet API or Lightning node.
7. Resource server returns the response to the client with the `PAYMENT-RESPONSE` header.

**Key Difference from Blockchain Schemes:** Lightning payments are settled instantly during step 4, before the client sends the payment signature. The resource server only needs to verify that the payment was received, not execute a settlement transaction.

## Network Format

X402 v2 uses CAIP-2 format for network identifiers. The `network` field specifies the base blockchain:

- **Bitcoin Mainnet:** `bip122:000000000019d6689c085ae165831e93`
- **Bitcoin Testnet:** `bip122:000000000933ea01ad0ee984209779ba`

Note: Lightning Network payments are indicated via the `extra.paymentMethod` field (see below), not through the network identifier. This allows the same Bitcoin network to support both on-chain and Lightning payments.

## `PaymentRequirements` for `exact`

In addition to the standard x402 `PaymentRequirements` fields, the `exact` scheme on Lightning Network requires the following:

```json
{
  "scheme": "exact",
  "network": "bip122:000000000019d6689c085ae165831e93",
  "amount": "100000",
  "asset": "BTC",
  "payTo": "anonymous",
  "maxTimeoutSeconds": 3600,
  "extra": {
    "paymentMethod": "lightning",
    "invoice": "lnbc1u1p3..."
  }
}
```

### Field Descriptions

- `scheme`: Always `"exact"` for this scheme
- `network`: CAIP-2 network identifier - `bip122:000000000019d6689c085ae165831e93` (Bitcoin mainnet) or `bip122:000000000933ea01ad0ee984209779ba` (Bitcoin testnet)
- `amount`: The exact amount to transfer in **millisatoshis** (1 satoshi = 1000 millisatoshis)
- `asset`: Always `"BTC"` for Bitcoin Lightning Network
- `payTo`: Always `"anonymous"`. Required for schema consistency with other x402 schemes. In Lightning, the payment destination is encoded in the invoice itself, and the actual recipient is anonymous.
- `maxTimeoutSeconds`: Maximum time in seconds before the payment expires. This should match or be shorter than the invoice expiry
- `extra.paymentMethod`: The payment method to use. For Lightning Network, this is `"lightning"`. This distinguishes Lightning payments from on-chain Bitcoin transfers on the same network. Valid values include: `"lightning"`, `"on-chain"` (future).
- `extra.invoice`: The BOLT11 invoice string that the client must pay

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` must contain the following field:

- `invoice`: The BOLT11 invoice string that was paid by the client (same as provided in `PaymentRequirements.extra.invoice`)

Example `payload`:

```json
{
  "invoice": "lnbc1u1p3..."
}
```

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/weather",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "bip122:000000000019d6689c085ae165831e93",
    "amount": "100000",
    "asset": "BTC",
    "payTo": "anonymous",
    "maxTimeoutSeconds": 3600,
    "extra": {
      "paymentMethod": "lightning",
      "invoice": "lnbc1u1p3..."
    }
  },
  "payload": {
    "invoice": "lnbc1u1p3..."
  }
}
```

## Verification

Steps to verify a payment for the `exact` scheme on Lightning Network:

1. **Extract requirements**: Use `payload.accepted` to get the payment requirements being fulfilled.
2. Verify `x402Version` is `2`.
3. Verify the network matches the agreed upon chain.
4. Verify `payload.invoice` matches `payload.accepted.extra.invoice` exactly (prevents invoice substitution attacks).
5. Verify the invoice in `payload.invoice` was issued by this resource server (i.e., exists in the server's invoice database).
6. Decode the BOLT11 invoice to extract payment details (payment hash, amount, timestamp, expiry).
7. Verify the invoice has not expired (check current time against invoice timestamp + expiry).
8. Verify the invoice amount matches `requirements.amount` exactly.
9. Verify the invoice has not already been used.
10. Query the Lightning wallet API or Lightning node to verify the invoice has been paid. If the payment is still in-flight (HTLC locked but not yet settled), the server SHOULD respond with `402` and a `Retry-After` header indicating when the client should retry.

## Settlement

Settlement for Lightning Network payments is fundamentally different from blockchain schemes:

1. **Payment is already settled**: Lightning payments are settled instantly off-chain when the client pays the invoice (before submitting the `PAYMENT-SIGNATURE` header).
2. **Server verification only**: The resource server only needs to verify that the payment was received by querying their Lightning wallet API or node.
3. **No facilitator required**: Unlike blockchain schemes where a facilitator broadcasts transactions, Lightning payments go directly from payer to payee through the Lightning Network.
4. **Near-instant finality**: Lightning payments achieve near-instant finality under normal conditions. While payments may briefly remain in-flight, once received they are final with no risk of reorgs.

The verification response includes the payment hash as the transaction identifier, which can be used to look up payment details in the Lightning node.

## SettlementResponse
The `PAYMENT-RESPONSE` header is base64 encoded and returned to the client from the resource server.

Once decoded, the `PAYMENT-RESPONSE` is a JSON string following the standard `SettlementResponse` schema:

```json
{
  "success": true,
  "transaction": "a1b2c3d4e5f...",
  "network": "bip122:000000000019d6689c085ae165831e93",
  "payer": "anonymous",
  "extra": {
    "invoice": "lnbc1u1p3...",
    "settledAt": 1739116800
  }
}
```

### Field Descriptions

- `success`: Boolean indicating whether the payment settlement was successful
- `transaction`: The SHA-256 payment hash (hex-encoded) derived from the BOLT11 invoice. This serves as the transaction identifier and is widely used by Lightning tooling for payment lookups.
- `network`: The CAIP-2 network identifier
- `payer`: The payer identifier. Since Lightning provides limited privacy features, this may be `"anonymous"` or a Lightning node public key if available
- `extra.invoice`: The BOLT11 invoice string
- `extra.settledAt`: Unix timestamp when the payment was confirmed

## Appendix

### Replay Attack Prevention

To prevent replay attacks where a client reuses a paid invoice:

1. **Store used invoices**: Maintain a database of payment hashes that have been used
2. **Set TTL**: Use time-to-live (TTL) based on invoice expiry + buffer time
3. **One-time use**: Reject any invoice that has already been accepted
4. **Invoice expiry**: Always check that invoices haven't expired before accepting

### No Facilitator Required

Unlike blockchain schemes (EVM, SVM, Sui, etc.) where a facilitator typically:
- Sponsors gas fees
- Broadcasts transactions
- Manages nonces and sequence numbers

Lightning Network payments are direct peer-to-peer, eliminating the need for:
- Gas fee sponsorship (Lightning fees are paid from payment amount)
- Transaction broadcasting (handled by Lightning Network routing)
- Replay protection infrastructure (invoices are inherently one-time use)

This architectural simplification makes Lightning integration more straightforward for resource servers.

## Recommendation

- Use the spec defined above for the first version of the protocol
- Implement replay protection using a key-value store or database
