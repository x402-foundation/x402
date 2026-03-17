# Scheme: `exact` on `TON`

## Versions supported

- ❌ `v1`
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/tvm/caip2) identifiers from the TVM namespace:

- `tvm:-239` — TON mainnet
- `tvm:-3` — TON testnet

> [!NOTE]
> **Scope:** This spec covers [TEP-74]-compliant Jetton transfers using **W5+ wallets** (v5r1 and later) only. Earlier wallet versions (v3, v4) do not support `internal_signed` messages required for gasless transactions.

## Summary

The `exact` scheme on TON transfers a specific amount of a [TEP-74] Jetton from the client to the resource server using a W5 wallet signed message.

The facilitator IS the relay. It sponsors gas (~0.013 TON per transaction) by wrapping the client-signed message in an internal TON message from its own funded wallet. The client makes zero blockchain calls — it calls the facilitator's `/prepare` endpoint to get signing data, signs locally, and sends the result. The facilitator cannot modify the destination or amount; the client controls payment intent through Ed25519 signature.

There is no relay commission. The facilitator absorbs gas costs as the cost of operating the payment network, analogous to how EVM facilitators pay gas for `transferWithAuthorization`.

## Protocol Flow

1. **Client** requests a protected resource from the **Resource Server**.
2. **Resource Server** responds with HTTP 402 and `PaymentRequired` data. The `accepts` array includes a TON payment option with `facilitatorUrl`.
3. **Client** calls the **Facilitator's** `/prepare` endpoint with `{ from, to, tokenMaster, amount }`. This resolves the client's Jetton wallet, fetches the current seqno, and returns signing data (seqno, validUntil, walletId, messages array).
4. **Client** constructs a W5 `internal_signed` message containing the Jetton transfer from the `/prepare` response.
5. **Client** signs the message with their Ed25519 private key.
6. **Client** wraps the signed body in an external message BOC (with `stateInit` if `seqno == 0`) and base64-encodes it.
7. **Client** sends a second request to the **Resource Server** with the `PaymentPayload` in the `X-PAYMENT` header.
8. **Resource Server** forwards the payload and requirements to the **Facilitator's** `/verify` endpoint.
9. **Facilitator** deserializes the BOC, verifies the Ed25519 signature, payment intent (amount, destination, asset), and replay protection (seqno, validUntil, BoC hash).
10. **Facilitator** returns a `VerifyResponse`. Verification is **REQUIRED** — it prevents the resource server from doing unnecessary work for invalid payloads.
11. **Resource Server**, upon successful verification, fulfills the client's request.
12. **Resource Server** calls the **Facilitator's** `/settle` endpoint. The facilitator MUST perform full verification independently and MUST NOT assume prior `/verify` results.
13. **Facilitator** settles the payment: wraps the client's signed body in an internal message from its own wallet, attaching TON for gas (estimated via emulation). The facilitator's W5 wallet sends this internal message to the user's W5 wallet, which verifies the signature and executes the Jetton transfer.
14. **Resource Server** returns the final response to the **Client** with `X-PAYMENT-RESPONSE` header containing the settlement result.

## `PaymentRequirements` for `exact`

In addition to standard x402 fields, TON `exact` uses `extra` fields:

```json
{
  "scheme": "exact",
  "network": "tvm:-239",
  "amount": "10000",
  "asset": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
  "payTo": "0:92433a576cbe56c4dcc86d94b497a2cf18a9baa9c8283fea28ea43eb3c25cfed",
  "maxTimeoutSeconds": 300,
  "extra": {
    "facilitatorUrl": "https://facilitator.example.com"
  }
}
```

**Field Definitions:**

- `asset`: [TEP-74] Jetton master contract address (raw format `workchain:hex`).
- `payTo`: Recipient TON address (raw format).
- `amount`: Atomic token amount (6 decimals for USDT, so `10000` = $0.01).
- `extra.facilitatorUrl`: URL of the facilitator server. The client calls `{facilitatorUrl}/prepare` to get signing data. The resource server calls `{facilitatorUrl}/verify` and `{facilitatorUrl}/settle`.

## PaymentPayload `payload` Field

The `payload` field contains the signed message and metadata needed for verification and settlement:

```json
{
  "from": "0:1da21a6e33ef22840029ae77900f61ba820b94e813a3b7bef4e3ea471007645f",
  "to": "0:92433a576cbe56c4dcc86d94b497a2cf18a9baa9c8283fea28ea43eb3c25cfed",
  "tokenMaster": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
  "amount": "10000",
  "validUntil": 1772689900,
  "nonce": "a1b2c3d4e5f6",
  "settlementBoc": "te6cckEBAgEAkwABnYgBFpKiX...",
  "walletPublicKey": "14f77792ea084b4defa9bf5e99335682dd556b8ddf1943dca052ca56276136a8"
}
```

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/wallet-analytics",
    "description": "TON wallet analytics",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "tvm:-239",
    "amount": "10000",
    "asset": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
    "payTo": "0:92433a576cbe56c4dcc86d94b497a2cf18a9baa9c8283fea28ea43eb3c25cfed",
    "maxTimeoutSeconds": 300,
    "extra": {
      "facilitatorUrl": "https://facilitator.example.com"
    }
  },
  "payload": {
    "from": "0:1da21a6e33ef22840029ae77900f61ba820b94e813a3b7bef4e3ea471007645f",
    "to": "0:92433a576cbe56c4dcc86d94b497a2cf18a9baa9c8283fea28ea43eb3c25cfed",
    "tokenMaster": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
    "amount": "10000",
    "validUntil": 1772689900,
    "nonce": "a1b2c3d4e5f6",
    "settlementBoc": "te6cckEBAgEAkwABnYgBFpKiX...",
    "walletPublicKey": "14f77792ea084b4defa9bf5e99335682dd556b8ddf1943dca052ca56276136a8"
  }
}
```

**Field Definitions:**

- `from`: Sender W5 wallet address in raw format.
- `to`: Recipient wallet address in raw format. Must match `requirements.payTo`.
- `tokenMaster`: Jetton master contract address in raw format. Must match `requirements.asset`.
- `amount`: Payment amount in atomic token units. Must match `requirements.amount`.
- `validUntil`: Unix timestamp after which the signed message expires.
- `nonce`: Random string for replay protection.
- `settlementBoc`: Base64-encoded signed W5 external message BOC containing the Jetton transfer with `internal_signed` body and Ed25519 signature.
- `walletPublicKey`: Ed25519 public key in hex, used for signature verification.

## `SettlementResponse`

```json
{
  "success": true,
  "transaction": "ba96f62d4ea651a21da4282809f2541ea42481ca35018129f29b406ef3fe36c0",
  "network": "tvm:-239",
  "payer": "0:1da21a6e33ef22840029ae77900f61ba820b94e813a3b7bef4e3ea471007645f"
}
```

- `transaction`: Transaction hash (64-character hex string).
- `payer`: The address of the client who signed the payment (not the facilitator).

## Facilitator Verification Rules (MUST)

A facilitator verifying `exact` on TON MUST enforce all checks below before settlement.

### 1. Protocol and requirement consistency

- `x402Version` MUST be `2`.
- `payload.accepted.scheme` and `requirements.scheme` MUST both equal `"exact"`.
- `payload.accepted.network` MUST equal `requirements.network` and MUST be a supported TVM network.
- `payload.accepted.asset` MUST equal `requirements.asset`.
- `payload.accepted.payTo` MUST equal `requirements.payTo`.
- `payload.accepted.amount` MUST equal `requirements.amount` exactly.

### 2. Signature validity

- `payload.settlementBoc` MUST decode as a valid TON external message.
- The message body MUST contain a valid W5 (v5r1+) signed transfer with opcode `0x73696e74` (`internal_signed`).
- The Ed25519 signature MUST verify against `payload.walletPublicKey`. The signature is located at the TAIL of the W5 message body (after `walletId`, `validUntil`, `seqno`, and actions).
- `payload.validUntil` MUST be in the future but within `maxTimeoutSeconds` of the current time.

### 3. Payment intent

- The W5 message MUST contain exactly **1** `jetton_transfer` (opcode `0xf8a7ea5`) internal message. No additional actions are permitted.
- The `jetton_transfer` destination (after Jetton wallet resolution) MUST match `requirements.payTo`.
- The transfer amount MUST be greater than or equal to `requirements.amount`.
- The Jetton master contract (`payload.tokenMaster`) MUST match `requirements.asset`.

### 4. Replay protection

- `payload.validUntil` MUST NOT be expired and MUST NOT be more than 600 seconds in the future.
- The wallet's on-chain seqno SHOULD be checked: the seqno in the BoC MUST NOT be less than the current on-chain seqno. This check is advisory — the wallet contract is the ultimate authority on seqno validation.
- Duplicate `settlementBoc` submissions MUST be rejected via BoC hash dedup (see [Duplicate Settlement Mitigation](#duplicate-settlement-mitigation-recommended)).

### 5. Pre-settlement simulation (optional)

- Facilitator SHOULD simulate message execution via emulation before broadcast.
- Settlement SHOULD fail if simulation indicates: insufficient Jetton balance, expired message, or invalid seqno.

## Settlement Logic

1. Re-run all verification checks (do not trust prior `/verify` result).
2. Extract the signed body from the external message.
3. Fetch the facilitator's own wallet seqno.
4. Estimate gas via emulation: build a trial relay message, emulate the trace, and sum all fees across the trace.
5. Build the relay message: wrap the user's signed body in an internal message from the facilitator's wallet to the user's wallet, attaching the estimated TON for gas.
6. Sign and broadcast the facilitator's external message.
7. Wait for transaction confirmation (typically < 5 seconds on TON).
8. Return x402 `SettlementResponse` with `success`, `transaction`, `network`, and `payer`.

## Duplicate Settlement Mitigation (RECOMMENDED)

### Vulnerability

A race condition exists in the settlement flow: if the same payment BoC is submitted to the facilitator's `/settle` endpoint multiple times before the first submission is confirmed on-chain, each call may attempt broadcast. Although TON's seqno-based replay protection ensures the transfer only executes once on-chain, a malicious client can exploit the timing window to obtain access to multiple resources while only paying once.

### Recommended Mitigation

Facilitators SHOULD maintain a short-term, in-memory cache of BoC hashes that have been verified and/or settled. Before proceeding with settlement, the facilitator checks whether the BoC has already been seen:

1. After verification succeeds, compute a hash of the `settlementBoc`.
2. If the hash is already present in the cache, reject the settlement with a `"duplicate_settlement"` error.
3. If the hash is not present, insert it into the cache and proceed with signing and submission.
4. Evict entries older than 600 seconds (the maximum `validUntil` window). After this window, the signed message will have expired and cannot land on-chain regardless.

This approach requires no external storage or long-lived state — only an in-process set with time-based eviction. It preserves the facilitator's otherwise stateless design while closing the duplicate settlement attack vector.

## `/prepare` Endpoint

TON requires a facilitator-side `/prepare` step that does not exist in EVM or SVM flows. This is because TON Jetton transfers require resolving the sender's Jetton wallet address via an on-chain getter, and fetching the current wallet seqno — operations that require a TON RPC connection that clients may not have.

### Request

```
POST {facilitatorUrl}/prepare
Content-Type: application/json

{
  "from": "0:1da21a6e33ef22840029ae77900f61ba820b94e813a3b7bef4e3ea471007645f",
  "to": "0:92433a576cbe56c4dcc86d94b497a2cf18a9baa9c8283fea28ea43eb3c25cfed",
  "tokenMaster": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
  "amount": "10000"
}
```

- `from`: Client's W5 wallet address (any format — facilitator normalizes).
- `to`: Recipient's wallet address.
- `tokenMaster`: Jetton master contract address.
- `amount`: Payment amount in atomic token units.

### Response

```json
{
  "seqno": 3,
  "validUntil": 1772690200,
  "walletId": 2147483409,
  "messages": [
    {
      "address": "0:abc123...def456",
      "amount": "100000000",
      "payload": "te6cckEBAQEA..."
    }
  ]
}
```

- `seqno`: Client wallet's current sequence number.
- `validUntil`: Unix timestamp for message expiry (typically current time + 300 seconds).
- `walletId`: W5 wallet ID for the target network (2147483409 for mainnet).
- `messages`: Array of internal messages the client should sign. Each contains:
  - `address`: The client's Jetton wallet address (resolved by facilitator).
  - `amount`: Forward TON amount for the Jetton transfer (in nanoTON).
  - `payload`: Base64-encoded Jetton transfer body with destination, amount, and response_destination.

The client uses this data to construct and sign a W5 `internal_signed` message without making any blockchain calls.

## Reference Implementations

- **Facilitator**: [ohld/x402-ton-facilitator](https://github.com/ohld/x402-ton-facilitator)
- **POC**: [ohld/x402-ton-poc](https://github.com/ohld/x402-ton-poc)
- **SDK**: [coinbase/x402#1583](https://github.com/coinbase/x402/pull/1583)

## Appendix

### W5 Wallet and Self-Relay Architecture

The W5 wallet contract (v5, deployed since Aug 2024) introduced `internal_signed` messages — the key primitive for gasless transfers on TON:

1. **Client calls `/prepare`** on the facilitator to get signing data (seqno, Jetton wallet, transfer payload).
2. **Client signs** the message offline with their Ed25519 key. Zero blockchain calls on the client side.
3. **Signed message is sent** to the resource server as an x402 payment header.
4. **Facilitator wraps it** in an internal message from its own funded wallet (carrying TON for gas) and submits to the user's W5 wallet contract.
5. **W5 contract verifies** the Ed25519 signature and executes the Jetton transfer.

The facilitator IS the relay — no third-party relay service is needed. Gas cost (~0.013 TON ≈ $0.04 per transaction) is absorbed by the facilitator.

This is architecturally equivalent to x402's facilitator model on other chains:

| x402 Concept | TON Equivalent | EVM Equivalent |
|---|---|---|
| Facilitator sponsors gas | Facilitator sends internal message carrying TON | Facilitator calls `transferWithAuthorization` |
| Client signs offline | W5 `internal_signed` message | EIP-3009 authorization signature |
| Zero client blockchain calls | Client calls `/prepare` (HTTP only) | Client signs EIP-712 typed data |
| Settlement | Facilitator wraps + broadcasts | Facilitator submits tx |

### TON Address Formats

- **Raw**: `workchain:hex` (e.g., `0:b113a994...`) — used in this protocol.
- **Friendly non-bounceable**: `UQ...` — used in user-facing UIs.
- **Friendly bounceable**: `EQ...` — used for smart contracts.

Implementations MUST use raw format in protocol messages and MAY display friendly format in UIs.

### TEP-74 Jetton Standard

TON uses the [TEP-74 Jetton standard][TEP-74] for fungible tokens:

- Transfer opcode: `0xf8a7ea5` (`jetton_transfer`).
- Each holder has a separate Jetton wallet contract.
- The Jetton master contract resolves wallet addresses via `get_wallet_address` getter.

### Default Assets

| Network | Asset | Symbol | Decimals | Address |
|---|---|---|---|---|
| `tvm:-239` | USDT | USD₮ | 6 | `0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe` |

### References

- [x402 v2 core specification](../../x402-specification-v2.md)
- [TEP-74 Jetton Standard][TEP-74]
- [W5 Wallet Contract](https://github.com/ton-blockchain/wallet-contract-v5)
- [TVM CAIP-2 Namespace](https://namespaces.chainagnostic.org/tvm/caip2)
- [Facilitator](https://github.com/ohld/x402-ton-facilitator)
- [POC](https://github.com/ohld/x402-ton-poc)

[TEP-74]: https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md
