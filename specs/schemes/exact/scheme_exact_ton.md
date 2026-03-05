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

The `exact` scheme on TON transfers a specific amount of a [TEP-74] Jetton from the client to the resource server using a W5 wallet `internal_signed` message.

The facilitator sponsors gas by wrapping the client-signed message in an internal TON message. The client controls payment intent (asset, recipient, amount) through Ed25519 signature. The facilitator cannot modify the destination or amount.

## Protocol Flow

1. Client requests a protected resource.
2. Resource server returns a payment-required signal with `PAYMENT-REQUIRED` and `PaymentRequired` data.
3. `accepts[].extra.relayAddress` communicates the gasless relay address for excess funds.
4. Client resolves their Jetton wallet address via `get_wallet_address` on the Jetton master.
5. Client builds a `jetton_transfer` body ([TEP-74] opcode `0xf8a7ea5`).
6. Client wraps in a W5 `internal_signed` message with `seqno` + `timeout`.
7. Client wraps in an external message BOC (with `stateInit` if `seqno == 0`).
8. Client sends a second request with `PAYMENT-SIGNATURE`, containing a base64-encoded `PaymentPayload`.
9. Resource server forwards payload and requirements to facilitator `/verify`.
10. Facilitator deserializes BOC, verifies signature, intent, and amounts.
    - NOTE: `/verify` is optional and intended for pre-flight checks only. `/settle` MUST perform full verification independently and MUST NOT assume prior verification.
11. Resource server fulfills work after successful verification.
12. Resource server calls facilitator `/settle`.
13. Facilitator broadcasts signed BOC via gasless relay or direct submission to validators.
14. Resource server returns the final response including `PAYMENT-RESPONSE`.

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
    "relayAddress": "0:7ae5056c3fd9406f9bbbe7c7089cd4c40801d9075486cbedb7ce12df119eacf1",
    "assetDecimals": 6,
    "assetSymbol": "USDT"
  }
}
```

**Field Definitions:**

- `asset`: [TEP-74] Jetton master contract address (raw format `workchain:hex`).
- `payTo`: Recipient TON address (raw format).
- `amount`: Atomic token amount (6 decimals for USDT, so `10000` = $0.01).
- `extra.relayAddress`: (Optional) Gasless relay address that receives excess TON, reducing fees for the client. When present, the client should set `response_destination` in `jetton_transfer` to this address. When absent, the client handles excess routing itself.
- `extra.assetDecimals`: Token decimal places for display purposes.
- `extra.assetSymbol`: Human-readable token symbol.

## PaymentPayload `payload` Field

The `payload` field contains the signed external message BOC and wallet metadata:

```json
{
  "signedBoc": "BASE64_EXTERNAL_MESSAGE_BOC",
  "walletPublicKey": "HEX_ED25519_PUBLIC_KEY",
  "walletAddress": "0:1da21a6e33ef22840029ae77900f61ba820b94e813a3b7bef4e3ea471007645f",
  "seqno": 0,
  "validUntil": 1772689900
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
      "relayAddress": "0:7ae5056c3fd9406f9bbbe7c7089cd4c40801d9075486cbedb7ce12df119eacf1",
      "assetDecimals": 6,
      "assetSymbol": "USDT"
    }
  },
  "payload": {
    "signedBoc": "te6cckEBAgEAkwABnYgBFpKiX...",
    "walletPublicKey": "14f77792ea084b4defa9bf5e99335682dd556b8ddf1943dca052ca56276136a8",
    "walletAddress": "0:1da21a6e33ef22840029ae77900f61ba820b94e813a3b7bef4e3ea471007645f",
    "seqno": 3,
    "validUntil": 1772689900
  }
}
```

**Field Definitions:**

- `signedBoc`: Base64-encoded external message containing a W5 signed transfer.
- `walletPublicKey`: Ed25519 public key in hex, used by gasless relay for submission.
- `walletAddress`: Sender W5 wallet address in raw format.
- `seqno`: Current wallet sequence number (replay protection).
- `validUntil`: Unix timestamp after which the signed message expires.

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
- `payer`: The address of the client who signed the payment (not the facilitator/relay).

## Facilitator Verification Rules (MUST)

A facilitator verifying `exact` on TON MUST enforce all checks below before settlement.

### 1. Protocol and requirement consistency

- `x402Version` MUST be `2`.
- `payload.accepted.scheme` and `requirements.scheme` MUST both equal `"exact"`.
- `payload.accepted.network` MUST equal `requirements.network`.
- `payload.accepted.asset` MUST equal `requirements.asset`.
- `payload.accepted.payTo` MUST equal `requirements.payTo`.
- `payload.accepted.amount` MUST be `>=` `requirements.amount`.

### 2. Signed message validity

- `payload.signedBoc` MUST decode as a valid TON external message.
- The message body MUST contain a valid W5 (v5r1+) signed transfer with `authType: internal`.
- The Ed25519 signature MUST verify against `payload.walletPublicKey`.
- `payload.validUntil` MUST be in the future but within `maxTimeoutSeconds` of the current time.

### 3. Payment intent integrity

- The W5 message MUST contain outgoing internal messages.
- At least one internal message MUST be a `jetton_transfer` (opcode `0xf8a7ea5`).
- The `jetton_transfer` destination (after Jetton wallet resolution) MUST match `requirements.payTo`.
- The transfer amount MUST be `>=` `requirements.amount`.
- The Jetton master contract MUST match `requirements.asset`.

### 4. Replay and anti-abuse checks

- `payload.seqno` MUST match the wallet's current on-chain seqno.
- Duplicate `signedBoc` submissions MUST be rejected.
- The W5 message MUST NOT contain additional unrelated actions beyond the payment transfer and relay commission.

### 5. Relay sponsorship safety

> [!IMPORTANT]
> These checks prevent the relay/facilitator from being tricked into transferring their own funds or sponsoring unintended actions.

- The facilitator/relay account MUST NOT appear as the source of the Jetton transfer.
- The facilitator MUST NOT be the payer (`walletAddress`) for the delegated transfer.
- The facilitator address MUST NOT appear as destination in any `jetton_transfer` within the W5 message (except for the relay commission transfer to `extra.relayAddress`).
- Gas costs MUST be bounded by facilitator policy to prevent sponsorship drain.

### 6. Pre-settlement simulation

- Facilitator SHOULD simulate message execution before broadcast.
- Settlement MUST fail if: insufficient Jetton balance, expired message, or invalid seqno.
- Simulation MUST confirm the expected balance changes: recipient receives `>= requirements.amount`, payer balance decreases accordingly.

## Settlement Logic

1. Re-run all verification checks (do not trust prior `/verify` result).
2. Submit `signedBoc` via gasless relay or direct broadcast:
   - **Sponsored (gasless):** `POST /v2/gasless/send` with `{ wallet_public_key, boc }` to a relay service. The relay wraps the signed message in an internal message carrying TON for gas.
   - **Non-sponsored (direct):** Broadcast the external message directly to TON validators. The client must have sufficient TON balance for gas fees in this mode.
3. Wait for transaction confirmation (typically < 5 seconds on TON).
4. Return x402 `SettlementResponse` with `success`, `transaction`, `network`, and `payer`.

## Appendix

### W5 Wallet and Gasless Architecture

The W5 wallet contract (v5, deployed since Aug 2024) introduced `internal_signed` messages — the key primitive for gasless transfers on TON:

1. **User signs** a message containing outgoing transfers (e.g., USDT to recipient + small USDT fee to relay).
2. **Signed message is sent off-chain** via HTTPS to a gasless relay service.
3. **Relay wraps it** in an internal message (which carries TON for gas) and submits to the user's W5 wallet contract.
4. **W5 contract verifies** the Ed25519 signature and executes the transfers.
5. **Relay is compensated** via USDT from a commission transfer included in the signed batch.

This is architecturally equivalent to x402's facilitator model:

| x402 Concept | TON Equivalent |
|---|---|
| Facilitator | Gasless relay |
| EIP-3009 `transferWithAuthorization` | W5 `internal_signed` message |
| Gas sponsorship | Relay wraps in internal message carrying TON |

The relay is **optional**. Any entity that can submit an internal message to a W5 contract can act as a relay. Reference implementations include the [TONAPI Gasless API][TONAPI].

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
- [TONAPI Gasless API][TONAPI]
- [TVM CAIP-2 Namespace](https://namespaces.chainagnostic.org/tvm/caip2)
- [Working Demo](https://github.com/ohld/x402-ton-poc)

[TEP-74]: https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md
[TONAPI]: https://docs.tonconsole.com/tonapi/rest-api/gasless
