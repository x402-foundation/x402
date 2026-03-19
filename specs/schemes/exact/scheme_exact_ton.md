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

The facilitator IS the relay. It sponsors gas (~0.013 TON per transaction) by wrapping the client-signed message in an internal TON message from its own funded wallet. The client resolves signing data (seqno, Jetton wallet address) via a TON RPC endpoint, signs locally, and sends the result. The facilitator cannot modify the destination or amount; the client controls payment intent through Ed25519 signature.

There is no relay commission. The facilitator absorbs gas costs as the cost of operating the payment network, analogous to how EVM facilitators pay gas for `transferWithAuthorization`.

## Protocol Flow

1. **Client** requests a protected resource from the **Resource Server**.
2. **Resource Server** responds with HTTP 402 and `PaymentRequired` data. The `accepts` array includes a TON payment option with `facilitatorUrl`.
3. **Client** queries a TON RPC endpoint to resolve its Jetton wallet address (`get_wallet_address` on the Jetton master contract) and fetches its current wallet seqno.
4. **Client** constructs a `jetton_transfer` body ([TEP-74]) and wraps it in a W5 `internal_signed` message.
5. **Client** signs the message with their Ed25519 private key.
6. **Client** wraps the signed body in an external message BOC (with `stateInit` if `seqno == 0`) and base64-encodes it.
7. **Client** sends a second request to the **Resource Server** with the `PaymentPayload`.
8. **Resource Server** forwards the payload and requirements to the **Facilitator's** `/verify` endpoint.
9. **Facilitator** deserializes the BOC, verifies the Ed25519 signature, simulates the transaction, and validates payment intent (amount, destination, asset) and replay protection (seqno, validUntil, BoC hash).
10. **Facilitator** returns a `VerifyResponse`. Verification is **REQUIRED** — it prevents the resource server from doing unnecessary work for invalid payloads.
11. **Resource Server**, upon successful verification, fulfills the client's request.
12. **Resource Server** calls the **Facilitator's** `/settle` endpoint. The facilitator MUST perform full verification independently and MUST NOT assume prior `/verify` results.
13. **Facilitator** settles the payment: wraps the client's signed body in an internal message from its own wallet, attaching TON for gas (estimated via emulation). The facilitator's W5 wallet sends this internal message to the user's W5 wallet, which verifies the signature and executes the Jetton transfer.
14. **Resource Server** returns the final response to the **Client**.

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
    "facilitatorUrl": "https://facilitator.example.com",
    "areFeesSponsored": true
  }
}
```

**Field Definitions:**

- `asset`: [TEP-74] Jetton master contract address (raw format `workchain:hex`).
- `payTo`: Recipient TON address (raw format).
- `amount`: Atomic token amount (6 decimals for USDT, so `10000` = $0.01).
- `extra.facilitatorUrl`: URL of the facilitator server. The resource server calls `{facilitatorUrl}/verify` and `{facilitatorUrl}/settle`.
- `extra.areFeesSponsored`: Whether the facilitator sponsors gas fees. Currently always `true`; a non-sponsored flow will be added later.

## PaymentPayload `payload` Field

The `payload` field contains the signed message and metadata needed for verification and settlement:

```json
{
  "from": "0:1da21a6e33ef22840029ae77900f61ba820b94e813a3b7bef4e3ea471007645f",
  "to": "0:92433a576cbe56c4dcc86d94b497a2cf18a9baa9c8283fea28ea43eb3c25cfed",
  "tokenMaster": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
  "amount": "10000",
  "validUntil": 1772689900,
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
      "facilitatorUrl": "https://facilitator.example.com",
      "areFeesSponsored": true
    }
  },
  "payload": {
    "from": "0:1da21a6e33ef22840029ae77900f61ba820b94e813a3b7bef4e3ea471007645f",
    "to": "0:92433a576cbe56c4dcc86d94b497a2cf18a9baa9c8283fea28ea43eb3c25cfed",
    "tokenMaster": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
    "amount": "10000",
    "validUntil": 1772689900,
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

A facilitator verifying `exact` on TON MUST enforce all of the following checks before sponsoring and relaying the transaction:

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

### 3. Facilitator safety

- The facilitator's own address MUST NOT appear as the sender (`payload.from`) or as the source of any Jetton transfer. This prevents a malicious payload from tricking the facilitator into spending its own funds.

### 4. Payment intent

- The W5 message MUST contain exactly **1** `jetton_transfer` (opcode `0xf8a7ea5`) internal message. No additional actions are permitted.
- The destination address of the `jetton_transfer` internal message in the BoC MUST match the Jetton wallet address returned by `get_wallet_address(requirements.payTo)` on the Jetton master contract (`requirements.asset`). This ensures the transfer targets the legitimate Jetton wallet, not a substitute contract.
- The transfer amount MUST be equal to `requirements.amount`.
- The Jetton master contract (`payload.tokenMaster`) MUST match `requirements.asset`.

### 5. Replay protection

- `payload.validUntil` MUST NOT be expired and MUST NOT be more than `maxTimeoutSeconds` in the future.
- The wallet's on-chain seqno MUST be checked: the seqno in the BoC MUST NOT be less than the current on-chain seqno.
- The client MUST have sufficient balance of the payment asset.
- Duplicate `settlementBoc` submissions MUST be rejected via BoC hash dedup (see [Duplicate Settlement Mitigation](#duplicate-settlement-mitigation-recommended)).

> **Note:** Seqno and balance checks MAY be satisfied implicitly via transaction simulation (section 6). The spec declares them as explicit requirements so that implementations that do not simulate still enforce these checks.

### 6. Transaction simulation (recommended)

- Facilitator SHOULD simulate message execution via emulation during `/verify`.
- Verification SHOULD fail if simulation indicates: insufficient Jetton balance, expired message, or invalid seqno.
- When simulation is performed, it implicitly covers seqno and balance checks from section 5.

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
4. Evict entries older than `maxTimeoutSeconds` from the corresponding `PaymentRequirements`. After this window, the signed message will have expired and cannot land on-chain regardless.

This approach requires no external storage or long-lived state — only an in-process set with time-based eviction. It preserves the facilitator's otherwise stateless design while closing the duplicate settlement attack vector.

## Reference Implementations

- **Facilitator**: [ohld/x402-ton-facilitator](https://github.com/ohld/x402-ton-facilitator)
- **POC**: [ohld/x402-ton-poc](https://github.com/ohld/x402-ton-poc)
- **SDK**: [coinbase/x402#1583](https://github.com/coinbase/x402/pull/1583)

## Appendix

### W5 Wallet and Self-Relay Architecture

The W5 wallet contract (v5, deployed since Aug 2024) introduced `internal_signed` messages — the key primitive for gasless transfers on TON:

1. **Client resolves signing data** via a TON RPC endpoint: wallet seqno and Jetton wallet address.
2. **Client constructs and signs** the message offline with their Ed25519 key. Standard RPC calls only (same as SVM/Stellar/Aptos).
3. **Signed message is sent** to the resource server as an x402 payment payload.
4. **Facilitator wraps it** in an internal message from its own funded wallet (carrying TON for gas) and submits to the user's W5 wallet contract.
5. **W5 contract verifies** the Ed25519 signature and executes the Jetton transfer.

The facilitator IS the relay — no third-party relay service is needed. Gas cost (~0.013 TON per transaction) is absorbed by the facilitator.

This is architecturally equivalent to x402's facilitator model on other chains:

| x402 Concept | TON Equivalent | EVM Equivalent |
|---|---|---|
| Facilitator sponsors gas | Facilitator sends internal message carrying TON | Facilitator calls `transferWithAuthorization` |
| Client signs offline | W5 `internal_signed` message | EIP-3009 authorization signature |
| Client RPC calls | seqno + `get_wallet_address` (2 calls) | nonce lookup (1 call, permit2 extension only) |
| Settlement | Facilitator wraps + broadcasts | Facilitator submits tx |

### Client RPC Requirements

The client requires access to a TON RPC endpoint to prepare the payment. Two read-only calls are needed:

1. **Wallet seqno**: call the `seqno` getter on the client's W5 wallet contract.
2. **Jetton wallet address**: call `get_wallet_address` on the Jetton master contract with the sender's address to resolve the sender's Jetton wallet.

This is the same pattern as other x402 networks: SVM clients fetch the recent blockhash, Stellar clients simulate the transaction, and Aptos clients query sequence numbers — all via standard RPC calls.

Implementations SHOULD allow configuring a custom RPC endpoint and optional API key for higher rate limits.

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
