# Scheme: `exact` on `TON`

## Versions supported

- ❌ `v1`
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/tvm/caip2) identifiers from the TVM namespace:

- `tvm:-239` — TON mainnet
- `tvm:-3` — TON testnet

> [!NOTE]
> **Scope:** This spec covers [TEP-74](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md)-compliant Jetton transfers using **W5 wallets** (v5r1) with gasless relay (`areFeesSponsored: true`). Non-gasless flows (`external_signed`, native TON transfers) are planned for a follow-up spec extension.
>
> For clients, only W5 wallets in account states `active` and `uninit`/`nonexist` are supported. `frozen` accounts are not supported. In practice this is not expected to constrain implementations because `frozen` W5 accounts are not expected to appear in the next 5 years.

## Summary

The `exact` scheme on TON transfers a specific amount of a [TEP-74](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md) Jetton from the client to the resource server using a W5 (v5r1) wallet signed message.

The facilitator IS the relay. It sponsors gas (~0.013 TON per transaction) by wrapping the client-signed message in an internal TON message from its own funded wallet. The client resolves signing data (seqno, Jetton wallet address) via a TON RPC endpoint, signs locally, and sends the result. The facilitator cannot modify the destination or amount; the client controls payment intent through Ed25519 signature. The facilitator also attaches enough TON to the relay message to cover payer-wallet execution of the relayed message and to fund the client-signed inner transfer.

There is no relay commission. The facilitator absorbs gas costs as the cost of operating the payment network, analogous to how EVM facilitators pay gas for `transferWithAuthorization`.

## Protocol Flow

1. **Client** requests a protected resource from the **Resource Server**.
2. **Resource Server** responds with HTTP 402 and `PaymentRequired` data. The `accepts` array includes a TON payment option.
3. **Client** queries a TON RPC endpoint to resolve its Jetton wallet address (`get_wallet_address` on the Jetton master contract) and fetches its current wallet seqno.
4. **Client** constructs a `jetton_transfer` body ([TEP-74](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md)) and wraps it in a W5 `internal_signed` message with [sending mode 1 (`PAY_FEES_SEPARATELY`) or mode 3 (`PAY_FEES_SEPARATELY | IGNORE_ERRORS`)](https://docs.ton.org/foundations/messages/modes). The outbound internal message sent by the client's W5 wallet to the source Jetton wallet MUST be bounceable.
5. **Client** signs the message with their Ed25519 private key.
6. **Client** wraps the signed body in an internal message BoC (dest = client wallet, value = 0, with `stateInit` if the wallet account is not yet deployed, i.e. [`nonexist` or `uninit`](https://docs.ton.org/foundations/status)) and base64-encodes it.
7. **Client** sends a second request to the **Resource Server** with the `PaymentPayload`.
8. **Resource Server** forwards the payload and requirements to the **Facilitator's** `/verify` endpoint.
9. **Facilitator** deserializes the internal message BoC, derives the sender address and public key, verifies the Ed25519 signature, validates payment intent (amount, destination, asset), and checks replay protection (seqno, validUntil, BoC hash).
10. **Facilitator** returns a `VerifyResponse`. Verification is **REQUIRED** — it protects the resource server from doing unnecessary work for invalid payloads.
11. **Resource Server** calls the **Facilitator's** `/settle` endpoint. The facilitator MUST perform full verification independently and MUST NOT assume prior `/verify` results.
12. **Facilitator** settles the payment: it extracts the signed body from the internal message BoC, wraps it in a new internal message from its own wallet, attaching TON for gas (estimated via emulation), then signs and broadcasts it. The user's W5 wallet verifies the signature and executes the Jetton transfer.
13. **Resource Server** returns the final response to the **Client**.

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
    "forwardPayload": "te6cckEBAgEAkwABnYgBFpKiX...",
    "forwardTonAmount": "50000000",
    "responseDestination": "0:92433a576cbe56c4dcc86d94b497a2cf18a9baa9c8283fea28ea43eb3c25cfed",
    "areFeesSponsored": true
  }
}
```

**Field Definitions:**

- `asset`: [TEP-74](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md) Jetton master contract address (raw format `workchain:hex`).
- `payTo`: Recipient TON address (raw format).
- `amount`: Atomic token amount (6 decimals for USDT, so `10000` = $0.01). Decimals can be queried via `get_jetton_data` on the Jetton master contract.
- `extra.responseDestination` (optional): TON address used as `response_destination` in the `jetton_transfer` body. If omitted, the effective value is `addr_none` (i.e. 2 zero bits).
- `extra.forwardPayload` (optional): Base64-encoded cell used as the jetton transfer forward payload (see [TEP-74](https://github.com/ton-blockchain/TEPs/blob/63fc78718dd9930f3e106954ebec743c3ad07993/text/0074-jettons-standard.md?plain=1#L68)). If omitted, the effective value is a zero-bit cell.
- `extra.forwardTonAmount` (optional): the amount of nanotons to be attached to the jetton transfer (see [TEP-74](https://github.com/ton-blockchain/TEPs/blob/63fc78718dd9930f3e106954ebec743c3ad07993/text/0074-jettons-standard.md?plain=1#L68)). If omitted, the effective value is `"0"`.
- `extra.areFeesSponsored`: Whether the facilitator sponsors gas fees. Currently always `true`; a non-sponsored flow will be added in a follow-up spec.

These `extra` fields exist for TON-specific payment semantics: `forwardPayload` lets the payment carry application-level metadata (for example an invoice ID, analogous to a memo in other networks), `forwardTonAmount` enables the recipient to route the payment into custom contracts that require TON to execute logic on receipt, and `responseDestination` specifies where unused TON is returned as Jetton-transfer `excesses` as the exact network fee cannot be known in advance.

## PaymentPayload `payload` Field

The payload contains only the signed settlement BoC and the asset identifier. All other fields (sender address, amount, destination, public key, `responseDestination`, `forwardPayload`, and `forwardTonAmount`) are derived from the BoC by the facilitator:

```json
{
  "settlementBoc": "te6cckEBAgEAkwABnYgBFpKiX...",
  "asset": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe"
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
      "forwardPayload": "te6cckEBAgEAkwABnYgBFpKiX...",
      "forwardTonAmount": "50000000",
      "responseDestination": "0:92433a576cbe56c4dcc86d94b497a2cf18a9baa9c8283fea28ea43eb3c25cfed",
      "areFeesSponsored": true
    }
  },
  "payload": {
    "settlementBoc": "te6cckEBAgEAkwABnYgBFpKiX...",
    "asset": "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe"
  }
}
```

**Field Definitions:**

- `settlementBoc`: Base64-encoded TON internal message BoC. The internal message carries the signed W5 body as the `body` field, the client's wallet as `dest`, and optionally a `stateInit` for first-time wallet deployment. The `settlementBoc` wrapper itself does not need to be bounceable. The outbound internal message sent by the client's W5 wallet to the source Jetton wallet MUST be bounceable.
- `asset`: Jetton master contract address in raw format. Kept as an explicit field for future multi-asset protocol extensions.

The facilitator derives the following from the BoC:

- **Sender address**: the `dest` field of the internal message (the client's wallet).
- **Public key**: from the `stateInit` data cell (if present) or via the on-chain `get_public_key` getter.
- **walletId, amount, destination, responseDestination, validUntil, seqno, forwardTonAmount, and forwardPayload**: from the W5 signed body and its actions. If `responseDestination`, `forwardTonAmount`, or `forwardPayload` are omitted from `accepted.extra`, the facilitator compares against the effective defaults (`addr_none`, `"0"`, and zero-bit payload, respectively).

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
- The effective values of `responseDestination`, `forwardPayload`, and `forwardTonAmount` in `payload.accepted.extra` MUST match the corresponding effective values in `requirements.extra`.

### 2. Message and signature verification

- `payload.settlementBoc` MUST decode as a valid TON internal message.
- The `dest` field of the internal message is the client's wallet address (the sender/payer).
- The message body MUST contain a valid W5 (v5r1) signed transfer with opcode `0x73696e74` (`internal_signed`).
- The client's wallet account state MUST be either [`active`, `nonexist`, or `uninit`](https://docs.ton.org/foundations/status). `frozen` accounts are out of scope and MUST be rejected.
- The Ed25519 public key MUST be derived from the BoC's `stateInit` data cell (when `stateInit` is present, i.e. the wallet account is [`nonexist` or `uninit`](https://docs.ton.org/foundations/status)) or via the on-chain `get_public_key` getter on the client's wallet contract (when the account is `active`). The public key is NOT passed as a separate payload field.
- The Ed25519 signature MUST verify against the derived public key. The signature is located at the TAIL of the W5 message body (after `walletId`, `validUntil`, `seqno`, and actions).
- The facilitator MUST verify the client's wallet contract code matches a known W5 wallet contract. For [`nonexist` or `uninit`](https://docs.ton.org/foundations/status) accounts, the code MUST be taken from the `stateInit` included in `payload.settlementBoc`. For `active` accounts, the code MUST be fetched from the blockchain for the client's wallet address. The canonical code hash for W5R1 is `20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f`. Implementations SHOULD maintain an allowlist of accepted wallet code hashes. Currently the allowlist contains one entry (W5R1). Wallet versions ship very rarely on TON (years apart), so this list is near-static.

### 3. Payment intent

- The W5 message MUST contain exactly **1** `jetton_transfer` (opcode `0xf8a7ea5`) internal message with [sending mode 1 (`PAY_FEES_SEPARATELY`) or mode 3 (`PAY_FEES_SEPARATELY | IGNORE_ERRORS`)](https://docs.ton.org/foundations/messages/modes). No additional actions are permitted.
- The transfer amount MUST be equal to `requirements.amount`.
- The Jetton master address (`payload.asset`) MUST equal `requirements.asset`. Note: [TEP-74](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md) `jetton_transfer` does not carry the master contract address in its body, so the on-chain asset binding is verified in the next check.
- The source Jetton wallet (the destination of the W5 internal message in the BoC) MUST match the Jetton wallet address returned by `get_wallet_address(sender)` on the Jetton master contract (`requirements.asset`). This binds the BoC to the correct asset on-chain and prevents a malicious BoC from using a substitute Jetton wallet.
- The `destination`, `response_destination`, `forward_payload`, and `forward_ton_amount` parameters inside the `jetton_transfer` body MUST match the effective parameters in `requirements`: `requirements.payTo`, `requirements.extra.responseDestination ?? addr_none`, `requirements.extra.forwardPayload ?? zero-bit payload`, and `requirements.extra.forwardTonAmount ?? "0"`.
- The TON value carried by the user's signed internal message MUST be sufficient to cover execution starting from the payer wallet's outgoing message to the source Jetton wallet, including the effective `forward_ton_amount` (`requirements.extra.forwardTonAmount ?? "0"`) and downstream Jetton-wallet execution costs. Fees for delivering and executing the outer relay message on the payer wallet itself are sponsored separately by the facilitator and therefore do NOT need to be covered by the user's signed internal message. Facilitators SHOULD satisfy this check via emulation.
- The client MUST have sufficient balance of the payment asset.

### 4. Replay protection

- The `validUntil` timestamp in the W5 body MUST NOT be expired and MUST NOT be more than `maxTimeoutSeconds` in the future.
- The wallet's on-chain seqno MUST be checked: the seqno in the BoC MUST be strictly equal to the current on-chain seqno.
- Duplicate `settlementBoc` submissions MUST be rejected via BoC hash dedup (see [Duplicate Settlement Mitigation](#duplicate-settlement-mitigation-recommended)).

> **Note:** Seqno, balance, and expiry checks MAY be satisfied implicitly via transaction simulation (section 5). The spec declares them as explicit requirements so that implementations that do not simulate still enforce these checks.

### 5. Transaction simulation (recommended)

- Facilitator SHOULD simulate message execution via emulation during `/verify`. Simulation traces the full [TEP-74 Jetton transfer chain](https://docs.ton.org/standard/tokens/jettons/how-it-works#token-transfer) (transfer -> internal_transfer) and confirms the transfer reaches the recipient's Jetton wallet. This protects the resource server from doing unnecessary work for invalid payloads.
- Verification SHOULD fail if simulation indicates: insufficient Jetton balance, expired message, invalid seqno, or incomplete transfer chain.
- Simulation CAN replace the checks in section 3, but the checks from sections 1, 2, and 4 remain mandatory.

## Settlement Logic

1. Re-run all verification checks (do not trust prior `/verify` result).
2. Extract the signed body and optional `stateInit` from the internal message BoC.
3. Estimate gas via emulation: build a trial relay message, emulate the trace, and sum all fees across the trace.
4. Build the relay message: wrap the user's signed body in a bounceable internal message from the facilitator's wallet to the user's wallet, attaching sufficient TON to cover both (a) the outer relay delivery and payer-wallet execution fees and (b) the value expected by the client's signed internal message. If the client's BoC contains a `stateInit` segment (indicating the wallet is [`nonexist` or `uninit`](https://docs.ton.org/foundations/status)), include it in the relay message to enable wallet deployment.
5. Sign and broadcast the facilitator's external message.
6. Wait for transaction confirmation.
7. Return x402 `SettlementResponse` with `success`, `transaction`, `network`, and `payer`.

## Duplicate Settlement Mitigation (RECOMMENDED)

### Vulnerability

A race condition exists in the settlement flow: if the same payment BoC is submitted to the facilitator's `/settle` endpoint multiple times before the first submission is confirmed on-chain, each call may attempt broadcast. Although TON's seqno-based replay protection ensures the transfer only executes once on-chain, a malicious client can exploit the timing window to obtain access to multiple resources while only paying once.

### Recommended Mitigation

Facilitators SHOULD maintain a short-term, in-memory cache of BoC hashes that have been verified and/or settled. Before proceeding with settlement, the facilitator checks whether the BoC has already been seen:

1. After verification succeeds, compute a hash of the `settlementBoc`.
2. If the hash is already present in the cache, reject the settlement with a `"duplicate_settlement"` error.
3. If the hash is not present, insert it into the cache and proceed with signing and submission.
4. Evict entries older than `maxTimeoutSeconds` (default 300s). After this window, the signed message's `validUntil` will have passed and it cannot land on-chain regardless. This is analogous to SVM's fixed 120-second eviction window (tied to blockhash lifetime).

This approach requires no external storage or long-lived state — only an in-process set with time-based eviction. It preserves the facilitator's otherwise stateless design while closing the duplicate settlement attack vector.

## Reference Implementations

- **POC**: [ArkadiyStena/ton-x402-demo](https://github.com/ArkadiyStena/ton-x402-demo)
- **SDK**: [x402-foundation/x402#1944](https://github.com/x402-foundation/x402/pull/1944)

## Appendix

### W5 Wallet and Self-Relay Architecture

The W5 wallet contract (v5, deployed since Aug 2024) introduced `internal_signed` messages — the key primitive for gasless transfers on TON:

1. **Client resolves signing data** via a TON RPC endpoint: wallet seqno and Jetton wallet address.
2. **Client constructs and signs** the message offline with their Ed25519 key. Standard RPC calls only (same as SVM/Stellar/Aptos).
3. **Signed message is wrapped** in an internal message BoC and sent to the resource server as an x402 payment payload.
4. **Facilitator extracts** the signed body and wraps it in a new internal message from its own funded wallet (carrying TON for gas) and submits to the user's W5 wallet contract.
5. **W5 contract verifies** the Ed25519 signature and executes the Jetton transfer.

The facilitator IS the relay — no third-party relay service is needed. Gas cost (~0.013 TON per transaction) is absorbed by the facilitator.

This is architecturally equivalent to x402's facilitator model on other chains:


| x402 Concept             | TON Equivalent                                  | EVM Equivalent                                |
| ------------------------ | ----------------------------------------------- | --------------------------------------------- |
| Facilitator sponsors gas | Facilitator sends internal message carrying TON | Facilitator calls `transferWithAuthorization` |
| Client signs offline     | W5 `internal_signed` message                    | EIP-3009 authorization signature              |
| Client RPC calls         | seqno + `get_wallet_address` (2 calls)          | nonce lookup (1 call, permit2 extension only) |
| Settlement               | Facilitator wraps + broadcasts                  | Facilitator submits tx                        |


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

TON uses the [TEP-74 Jetton standard](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md) for fungible tokens:

- Transfer opcode: `0xf8a7ea5` (`jetton_transfer`).
- Each holder has a separate Jetton wallet contract.
- The Jetton master contract resolves wallet addresses via `get_wallet_address` getter.

### Default Assets


| Network    | Asset | Symbol | Decimals | Address                                                              |
| ---------- | ----- | ------ | -------- | -------------------------------------------------------------------- |
| `tvm:-239` | USDT  | USD₮   | 6        | `0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe` |


### References

- [x402 v2 core specification](../../x402-specification-v2.md)
- [TEP-74 Jetton Standard](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md)
- [W5 Wallet Contract](https://github.com/ton-blockchain/wallet-contract-v5)
- [W5 Gasless Transactions](https://docs.ton.org/standard/wallets/v5#gasless-transactions)
- [TVM CAIP-2 Namespace](https://namespaces.chainagnostic.org/tvm/caip2)
- [Facilitator](https://github.com/ohld/x402-ton-facilitator)
- [POC](https://github.com/ohld/x402-ton-poc)
