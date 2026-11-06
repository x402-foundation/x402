# Scheme: `auth-capture` on `SVM`

## Summary

This is the Solana Virtual Machine (SVM) binding of [`auth-capture`](./scheme_auth_capture.md). It specifies the program, wire fields, signed messages, and facilitator logic that realize the scheme on Solana networks.

A signed SVM transfer commits to an exact amount and exact instruction data, so it cannot be captured for less, voided, or refunded once signed. The binding therefore holds each payment in a channel of the [payment-channels program](https://github.com/solana-foundation/payment-channels), the program SVM [`upto`](../upto/scheme_upto_svm.md) and [`batch-settlement`](../batch-settlement/scheme_batch_settlement_svm.md) also settle on:

- The client signs one transaction: an `open` that escrows `amount` in a channel committing the receiver, the fee split, the receiver authorizer, and both deadlines. That signature is the `authorize`.
- Every later operation is authorized by an Ed25519 message signed by the receiver authorizer and verified by the program. `capture`, `void`, and `refund` each carry their own signed message, so the program rather than the facilitator enforces server consent.
- The capture deadline locks the hold until it passes and releases it afterwards. Before it, the client cannot close the channel. After it, no capture lands and anyone can return the remaining hold to the client.

The program instructions and message formats the binding relies on are summarized in [Program surface](#program-surface).

Only the `escrow` payment flow is defined. A channel always places a hold, so `paymentFlow: "authorization"` is not supported; see [Payment flows](#payment-flows).

## Roles

| x402 role | Channel role | Responsibility |
| --- | --- | --- |
| Client | `payer` | Signs `open` and funds the deposit. Receives every unreleased or refunded token. |
| Receiver (`payTo`) | `payee` | Receives captured funds less the fee, as the payee's implicit remainder of the distribution. Signs nothing. |
| Receiver authorizer (`extra.receiverAuthorizer`) | `authorized_signer` | Signs capture, final, and refund messages. Never signs a transaction and needs no SOL or token balance. A key the server owns, or the facilitator's advertised key when the server delegates. |
| Facilitator (`extra.feePayer`) | `rent_payer` | Fee payer for every relayed transaction; funds channel rent at `open` and recovers it at cleanup. Holds no channel authority. |
| Fee recipient (`extra.feeRecipient`) | distribution entry | Receives `feeBps` of captured funds, when the fee is non-zero. |

The facilitator is never `payee`. In SVM `upto` the facilitator takes the payee seat so it can seal an abandoned channel and recover its rent. Here the capture deadline makes that seal permissionless, so the seat goes to the receiver. Three things follow:

- The facilitator has no power to close a hold early. Every exit from `Open` before `captureDeadline` requires a final message from the receiver authorizer.
- Distribution rounding residue goes to the receiver, as the payee's implicit remainder, never to the facilitator.
- The facilitator still always recovers its rent: after `captureDeadline` (or `refundDeadline`, for `refundFunding: "escrow"`) it can seal, distribute, and reclaim without anyone's cooperation.

## Operator model

The scheme's [network requirements](./scheme_auth_capture.md#network-requirements) ask each binding to name who may drive each operation. On SVM no address is privileged as a submitter: the program checks a signed message for every operation the client did not authorize, and accepts it from any fee payer. The binding therefore defines one operator model and no `extra.operatorType`. A facilitator MUST reject requirements carrying `extra.operatorType`, `extra.captureAuthorizer`, `extra.policy`, or `extra.authCaptureEscrow` with `invalid_auth_capture_svm_extra`.

| Operation | Program instructions | Consent | Submitted by |
| --- | --- | --- | --- |
| `authorize` | `open` | Client's transaction signature | Facilitator, as fee payer and `rent_payer` |
| `capture` | Ed25519 + `settle` (+ `distribute`) | Capture message from `receiverAuthorizer` | Facilitator, relayed |
| `capture` + `void` | Ed25519 + `seal_final` + `distribute` | Final message from `receiverAuthorizer` | Facilitator, relayed |
| `void` | Ed25519 + `seal_final` + `distribute` | Final message from `receiverAuthorizer` | Facilitator, relayed |
| `refund` | Ed25519 + `refund` | Refund message from `receiverAuthorizer` | Facilitator, relayed (`refundFunding: "escrow"` only) |
| `reclaim` | `seal` + `distribute` after `captureDeadline` | None, time-gated | Client, or anyone |

`reclaim` is the client's escape hatch and is never a `/settle` operation. Because it is permissionless, a facilitator MAY also run it as rent-recovery maintenance; the program sends the remaining hold to the client whoever submits it.

## Program surface

The canonical program id is a network constant, not a wire field. Implementations MUST target the canonical payment-channels program for the selected `network` and MUST NOT read a program id from `extra`. The auth-capture channel is an opt-in account version of that program, created by `open` with deadlines; earlier channel versions keep their existing behavior and are never valid for this scheme.

The binding relies on the following program behavior:

| Instruction | Behavior relied on |
| --- | --- |
| `open` (auth-capture) | Creates the channel PDA, escrows `deposit`, and commits `capture_deadline`, `refund_deadline`, the refund policy, and the distribution. Requires `now < capture_deadline <= refund_deadline`. |
| `settle` | Advances `settled` to the cumulative amount of the preceding Ed25519-verified capture message. Rejected at or after `capture_deadline`. |
| `seal_final` | Permissionless. Seals the channel at the cumulative amount of the preceding Ed25519-verified final message, which MUST be `>= settled`. Rejected at or after `capture_deadline`. |
| `seal` | Permissionless at or after `capture_deadline`, from `Open` or `Closing`, with no grace period. |
| `request_close`, `settle_and_seal` | Rejected before `capture_deadline`, so the hold can leave `Open` early only through `seal_final`. |
| `distribute` | Pays `settled - refunded - payout_watermark` per the distribution and, once sealed, returns `deposit - settled` to the client. Under the escrow refund policy, captured funds are not paid out before `refund_deadline`. |
| `refund` | Advances the monotonic `refunded` counter to the cumulative amount of the preceding Ed25519-verified refund message, requires `refunded <= settled` and `now < refund_deadline`, and transfers the delta from the channel escrow to the client's canonical token account. Escrow refund policy only. |
| `reclaim` | Deallocates a distributed channel and returns its rent to `rent_payer`, no earlier than the open-slot window and, under the escrow refund policy, `refund_deadline`. |

Every signed message is 50 bytes, single-signature, and supplied through the Ed25519 native-program instruction immediately preceding the instruction that consumes it, as with the program's existing vouchers:

```text
magic(2) || channelId(32) || u64(cumulativeAmount).le || i64(expiresAt).le
```

| Message | Magic | `cumulativeAmount` | `expiresAt` | Consumed by |
| --- | --- | --- | --- | --- |
| Capture | `0x56 0x01` | Total captured after this capture | `extra.captureDeadline` | `settle` |
| Final | `0x56 0x05` | Total captured at seal (capture-and-void, or void when equal to current captured) | `extra.captureDeadline` | `seal_final` |
| Refund | `0x56 0x06` | Total refunded after this refund | `extra.refundDeadline` | `refund` |

The capture message is the program's existing version-1 voucher. Final and refund messages use magics distinct from it and from each other, so a message signed for one operation is never accepted by another.

`expiresAt` is fixed by the binding rather than chosen per message, so the facilitator can rebuild every message from the channel and the payload alone. The program enforces the deadlines in any case; `expiresAt` additionally binds each message to the deadline it was signed for.

### Single-use consent

`cumulativeAmount` is a target, not a delta. The program applies a capture or refund message only if it strictly raises its counter, and seals at most once. A consent therefore cannot be replayed: once applied, the same message fails, and an older message can never move a counter that has already passed it. No nonce or stored replay key is involved; the channel's own counters are the replay key, enforced onchain.

## PaymentRequirements

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "auth-capture",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "amount": "1000000",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "<receiver>",
      "maxTimeoutSeconds": 60,
      "extra": {
        "paymentFlow": "escrow",
        "feePayer": "<facilitator>",
        "receiverAuthorizer": "<server-hot-key>",
        "captureDeadline": 1740758554,
        "refundDeadline": 1741276954,
        "refundFunding": "escrow",
        "feeRecipient": "<fee-recipient>",
        "minFeeBps": 100,
        "maxFeeBps": 100,
        "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "transactionVersions": [0, 1],
        "recentBlockhash": "<cached>",
        "recentSlot": 341000000
      }
    }
  ]
}
```

### `extra` fields

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `paymentFlow` | No | `"escrow"` | The only supported value. New servers SHOULD write it out, as [x402 v2 §6.1](../../x402-specification-v2.md#61-asset-transfer-methods-and-payment-flow-models) requires for non-`authorization` flows. Any other value is `invalid_auth_capture_svm_unsupported_payment_flow`. |
| `captureMode` | No | `"sync"` \| `"deferred"` | When the post-resource finalize runs. Default `"sync"`. See [Sync and async finalize](#sync-and-async-finalize). |
| `feePayer` | Yes | `string` | Base58 facilitator key from `/supported`. Fee payer of every relayed transaction and the channel `rent_payer`. |
| `receiverAuthorizer` | Yes | `string` | Base58 Ed25519 key committed as channel `authorized_signer`. A key the server owns, or the facilitator's `/supported` `receiverAuthorizer` when the server delegates. MAY equal `feePayer` or `payTo`. |
| `captureDeadline` | Yes | `number` | Absolute Unix seconds. The last moment funds can be captured or voided by the server, and the moment `reclaim` becomes available. Committed onchain as `capture_deadline`. |
| `refundDeadline` | Yes | `number` | Absolute Unix seconds, `>= captureDeadline`. The last moment a refund can be issued. Committed onchain as `refund_deadline`. |
| `refundFunding` | No | `"none"` \| `"escrow"` | Refund liquidity, per [Refund funding](#refund-funding). Default `"none"`. |
| `feeRecipient` | Per fee | `string` | Base58 fee recipient. REQUIRED when `maxFeeBps > 0`; MUST NOT equal `payTo`. |
| `minFeeBps` | Yes | `number` | Fee floor in basis points. MUST equal `maxFeeBps`; see [Fee system](#fee-system). |
| `maxFeeBps` | Yes | `number` | Fee ceiling in basis points, `0`–`10000`. |
| `tokenProgram` | Yes | `string` | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` or `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022). The client SHOULD verify it against the onchain mint owner. |
| `transactionVersions` | No | `array` | Transaction message versions the facilitator accepts for `open`, copied from `/supported`. Absent means `[0]`. Same rules as SVM `upto` [Transaction versions](../upto/scheme_upto_svm.md#transaction-versions). |
| `memo` | No | `string` | Seller-defined UTF-8 Memo data for `open`, at most 256 bytes, with the SVM `upto` semantics. |
| `recentBlockhash` | No | `string` | Pre-fetched blockhash so the client can build `open` without an RPC round trip. |
| `lastValidBlockHeight` | No | `string` | Last block height at which `recentBlockhash` is valid, as a decimal string. Informational. |
| `recentSlot` | No | `number` | Recent slot the client MAY use as `openSlot`. The program still enforces its open-slot window. |

`amount` is the hold: the client escrows exactly this value and every capture is bounded by it. Unlike `upto`, `amount` keeps that meaning at every settle; the amount a lifecycle operation moves travels on its payload.

### Channel derivation

The wire format does not expose program-specific accounts or split arrays. Client and facilitator derive them from the requirements:

```text
payer             = payload.from
payee             = payTo
authorized_signer = extra.receiverAuthorizer
rent_payer        = extra.feePayer
mint              = asset
deposit           = amount
capture_deadline  = extra.captureDeadline
refund_deadline   = extra.refundDeadline
refund_policy     = extra.refundFunding        # "none" or "escrow"

recipients = maxFeeBps == 0 ? []
           : [{ recipient: extra.feeRecipient, bps: maxFeeBps }]
# payTo receives the payee's implicit remainder: 10000 - maxFeeBps
```

The channel address is the program-derived address:

```text
channelId = find_program_address(
  [
    "channel",
    payload.from,
    payTo,                    # payee seed slot
    asset,
    extra.receiverAuthorizer, # authorized_signer seed slot
    u64(payload.nonce).to_le_bytes(),
    u64(payload.openSlot).to_le_bytes()
  ],
  CANONICAL_PAYMENT_CHANNELS_PROGRAM_ID
)
```

`channelId` is the payment's identity. `open` creates the account exactly once, and the program keeps the address occupied until its open-slot window has elapsed, so a collected authorization can never be collected again and no message signed for one payment applies to another. The client's random `nonce` keeps the address fresh across concurrent payments with otherwise identical terms.

## Client payment payload

The client builds and partially signs the `open` transaction and sends it with the values needed to rederive the channel. It names no operation: under the `escrow` flow, the client payload always settles as `authorize`.

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/resource", "method": "GET" },
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "from": "<payer>",
    "nonce": "8216473920471",
    "openSlot": 341000123,
    "channelId": "<channel-pda>",
    "openTransaction": "<base64>"
  }
}
```

| Payload field | Type | Description |
| --- | --- | --- |
| `from` | `string` | Payer wallet, base58. The channel `payer`. |
| `nonce` | `string` | Fresh random decimal `u64`, encoded as the `open` salt. |
| `openSlot` | `number` | `u64` slot encoded in `open` and used as a channel PDA seed. |
| `channelId` | `string` | Channel PDA, base58, derived as in [Channel derivation](#channel-derivation). |
| `openTransaction` | `string` | Base64 partially signed transaction containing the auth-capture `open`. The `from` signature is present; the `feePayer` signature is added by the facilitator. |

The `open` instruction MUST encode every value in [Channel derivation](#channel-derivation), plus `salt == u64(nonce)` and `open_slot == openSlot`. The client MUST derive `channelId` before signing and use it as the writable `channel` account.

`nonce` is a decimal string because a `u64` exceeds the JSON safe-integer range. `openSlot` stays below 2^53 for the foreseeable life of every Solana network and is a JSON number, as in SVM `upto`.

## Lifecycle payloads

`capture`, `void`, and `refund` have no client payload to build on, so the resource server authors them and passes them to `POST /settle` with `payload.type` naming the operation. `payload.type` appears only on these three. The payment is identified by `channelId`; everything else the facilitator needs is in the channel account, and the facilitator reads it from chain rather than trusting the payload.

`accepted` and `paymentRequirements` are the requirements the payment was collected under, unchanged. In particular `paymentRequirements.amount` remains the hold.

### `capture`

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "type": "capture",
    "channelId": "<channel-pda>",
    "amount": "750000",
    "expectedCapturedAmount": "0",
    "voidRemainder": true,
    "authorizerSignature": "<base58 ed25519 signature>"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `amount` | `string` | Amount to capture by this operation, greater than zero, in atomic units. |
| `expectedCapturedAmount` | `string` | The channel's `settled` value the authorizer signed against. REQUIRED. |
| `voidRemainder` | `boolean` | OPTIONAL. When `true`, this settle captures `amount` and releases the rest of the hold in one transaction. |
| `authorizerSignature` | `string` | Base58 Ed25519 signature by `extra.receiverAuthorizer` over the capture message, or the final message when `voidRemainder` is `true`, with `cumulativeAmount = expectedCapturedAmount + amount`. Omitted when the authorizer is delegated. |

A capture without `voidRemainder` leaves the remaining hold capturable, so captures may repeat up to `amount` of the hold. With `voidRemainder`, the single final message is both legs: the program seals at exactly `expectedCapturedAmount + amount`, and `distribute` returns the rest to the client. There is no separate void signature to verify, and no race between the legs. A capture of the full remaining hold SHOULD set `voidRemainder` too, so the channel seals and pays out in the same transaction instead of waiting for the capture deadline.

### `void`

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "type": "void",
    "channelId": "<channel-pda>",
    "expectedCapturedAmount": "750000",
    "authorizerSignature": "<base58 ed25519 signature>"
  }
}
```

`authorizerSignature` is the final message with `cumulativeAmount = expectedCapturedAmount`: it seals the channel at what has already been captured and releases the rest of the hold. A void before any capture uses `expectedCapturedAmount: "0"` and returns the full deposit.

### `refund`

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "type": "refund",
    "channelId": "<channel-pda>",
    "amount": "250000",
    "expectedRefundedAmount": "0",
    "authorizerSignature": "<base58 ed25519 signature>"
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `amount` | `string` | Amount to refund by this operation, greater than zero. |
| `expectedRefundedAmount` | `string` | The channel's `refunded` value the authorizer signed against. REQUIRED. |
| `authorizerSignature` | `string` | Base58 Ed25519 signature by `extra.receiverAuthorizer` over the refund message with `cumulativeAmount = expectedRefundedAmount + amount`. Omitted when the authorizer is delegated. |

The destination is not on the wire: the program pays refunds only to the client's canonical token account for the channel mint.

### Delegated authorizer

When `extra.receiverAuthorizer` is the facilitator's advertised key, the server omits `authorizerSignature`, and the facilitator signs the message after authenticating the request out of band (SIWX, a JWT, or an API credential). The facilitator MUST bind the authenticated caller to `channelId` at the collect settle, before broadcasting `open`, and MUST reject a lifecycle settle whose caller does not match that binding, with `invalid_auth_capture_svm_unauthenticated_authorizer_request`. A failure to read or write the binding MUST fail with `invalid_auth_capture_svm_delegated_auth_unavailable` and MUST NOT broadcast. A signature present on a delegated request is verified as for a server-owned key, and a facilitator that does not hold the key rejects an omitted signature with `invalid_auth_capture_svm_authorizer_signature`.

## Sync and async finalize

`extra.captureMode` publishes when the post-resource finalize runs.

- **Sync** (default). The in-request `/settle` after the resource runs is a `capture` (usually with `voidRemainder`) or a `void`. The server needs no durable state for the finalize.
- **Deferred.** That second in-request settle does not call the facilitator. The server commits `channelId` and the accepted requirements to durable storage and authors lifecycle settles later, before `captureDeadline`.

A later `refund` always requires the same durable state, including after a sync finalize. Channel state itself is onchain and discoverable (see [Channel discovery](#channel-discovery)), so `channelId` and the requirements are the only state a server must keep.

A deferred payment that the server never finalizes is not stranded: after `captureDeadline` the hold returns to the client through `reclaim`, and the facilitator recovers its rent.

## Payment flows

Only `escrow` is defined. Its ordering is `settle(authorize)` → resource → `settle(capture | void)` → respond, with `refund` settles later still. Facilitator `/verify` is not part of the ordering; it MAY be offered as a read-only preflight of the collect checks below, without co-signing or broadcasting `open`.

`paymentFlow: "authorization"` would settle the client's payload as a terminal `charge` with no hold. A channel cannot do that without first placing one, and the client's `open` carries a blockhash valid for only about 60–90 seconds, which a verify → resource → settle ordering cannot guarantee to meet. A server that needs a charge-like outcome uses `escrow` with `captureMode: "sync"` and `voidRemainder`, which settles the final amount within the request.

## Verification

### Client payment payload

On the collect settle (or a `/verify` preflight), the facilitator MUST, in order:

1. **Shape guard**: the payload carries exactly `from`, `nonce`, `channelId`, `openSlot`, and `openTransaction`. A client payload carrying `type` or `authorizerSignature` fails with `invalid_auth_capture_svm_payload_format`.
2. **Scheme and network**: `requirements.scheme` and `payload.accepted.scheme` are `auth-capture`, and `payload.accepted.network === requirements.network`, a CAIP-2 `solana:` identifier.
3. **Extra validation**: every REQUIRED `extra` field is present and well formed, no field reserved for another binding is present, `paymentFlow` resolves to `"escrow"`, `refundFunding` is a defined value, and the fee fields satisfy [Fee system](#fee-system).
4. **Facilitator keys**: `extra.feePayer` is a key this facilitator signs with. When `extra.receiverAuthorizer` is the facilitator's advertised authorizer, the request carries the out-of-band authentication the [Delegated authorizer](#delegated-authorizer) rule requires.
5. **Deadline ordering**: `now + maxTimeoutSeconds <= captureDeadline <= refundDeadline`, and `captureDeadline > now + 6s` (the 6s figure is a floor; implementations MAY use a larger skew). A facilitator MAY reject a `refundDeadline` (or, for `refundFunding: "none"`, a `captureDeadline`) further in the future than its local maximum rent lockup, with `invalid_auth_capture_svm_payment_lifetime_exceeded`.
6. **Channel identity**: `payload.channelId` equals the PDA derived as in [Channel derivation](#channel-derivation) and the `open` instruction's `channel` account, otherwise `invalid_auth_capture_svm_channel_id_mismatch`; and no account exists at that address. An existing account fails with `invalid_auth_capture_svm_channel_already_open`: the collect settle MUST open the channel itself, and an out-of-band open or a replayed `channelId` MUST NOT succeed.
7. **Transaction policy**: `openTransaction` passes the [acceptance policy](#open-transaction-acceptance-policy), otherwise `invalid_auth_capture_svm_transaction_policy` (or `unsupported_transaction_version` for a message version outside the accepted set).
8. **Open binding**: the decoded `open` instruction encodes every value in [Channel derivation](#channel-derivation), `salt == u64(nonce)`, and `open_slot == openSlot`, with no truncated or trailing data. Any mismatch fails with `invalid_auth_capture_svm_open_mismatch`.
9. **Settlement readiness**: the paths the payment can later take can succeed for the bound mint, token program, payer, receiver, and fee recipient, so a hold is never placed that cannot be captured, voided, or reclaimed. This MAY be a simulation of `open` followed by a facilitator-built void (`seal_final` at zero, then `distribute`), or targeted checks that the client, receiver, and fee-recipient token accounts exist (or will be created), are for the right mint and token program, and are not frozen. A failure is `invalid_auth_capture_svm_settlement_readiness`.

### Open transaction acceptance policy

The facilitator adds its `feePayer` signature to bytes constructed by the client, so it MUST inspect the complete message before signing. The policy is the SVM `upto` [client-supplied `openTransaction` acceptance policy](../upto/scheme_upto_svm.md#client-supplied-opentransaction-acceptance-policy) — transaction versions, message and signer rules, the top-level instruction layout and its Compute Budget, Lighthouse, and Memo allowances, and the compute-unit caps — with these differences:

- The single payment-channels instruction is the auth-capture `open` defined in [Program surface](#program-surface), not the version-1 `open`.
- The `payee` account role is `payTo`, not `extra.feePayer`. `payTo` is a read-only, non-signing role; if it equals another requirements-bound role, the resulting privilege union MUST NOT itself cause rejection.
- The only writable signers are `payload.from` (as `payer`) and `extra.feePayer` (as `rent_payer` and transaction fee payer). The required-signer set MUST equal the distinct addresses in `{ payload.from, extra.feePayer }`.
- `extra.feePayer` MUST NOT appear in any instruction outside its `rent_payer` position and the fee-payer slot, except where it intentionally equals another requirements-bound role.

### Lifecycle payloads

For `type: "capture"`, `"void"`, and `"refund"`, the facilitator repeats checks 2 through 4 above, and then:

1. **Channel binding**: fetch the channel at `payload.channelId` and require that it is an auth-capture channel of the canonical program whose `payer`, `payee`, `mint`, `authorized_signer`, `rent_payer`, `deposit`, `capture_deadline`, `refund_deadline`, refund policy, and `distribution_hash` equal what the requirements dictate per [Channel derivation](#channel-derivation), and whose address rederives from its own fields. A mismatch fails with `invalid_auth_capture_svm_channel_mismatch`.
2. **Authorizer signature**: rebuild the operation's message from `channelId`, the cumulative target, and the deadline the message table fixes, and verify `authorizerSignature` against `extra.receiverAuthorizer`; or, when delegated, authenticate the caller and sign it. A signature that does not verify fails with `invalid_auth_capture_svm_authorizer_signature`.
3. **Operation preconditions**, read from the channel:

   | Operation | Preconditions |
   | --- | --- |
   | `capture` | Status `Open`; `now < captureDeadline`; `settled == expectedCapturedAmount`; `0 < amount <= deposit - settled`. With `voidRemainder`, the same. |
   | `void` | Status `Open`; `now < captureDeadline`; `settled == expectedCapturedAmount`. |
   | `refund` | `refundFunding == "escrow"`; `now < refundDeadline`; `refunded == expectedRefundedAmount`; `0 < amount <= settled - refunded`. |

   A status that does not admit the operation fails with `invalid_auth_capture_svm_channel_status`, a passed deadline with the matching `*_deadline_expired` code, and a balance mismatch with `invalid_auth_capture_svm_unexpected_payment_state`. Unlike the EVM `delegated` operator, this check is not the only replay protection: the program applies a cumulative target at most once, so a stale request that slipped past the check fails onchain rather than double-spending.

4. **Simulate** the settlement transaction and require success.

## Settlement

The facilitator builds every settlement transaction itself and signs it only as fee payer; no relayed transaction carries a client or server signature.

1. **Re-verify** the payload, catching anything consumed or expired since verification.
2. **Build** the transaction for the operation:

   | Operation | Instructions |
   | --- | --- |
   | `authorize` | The client's `openTransaction`, co-signed. |
   | `capture` | Ed25519(capture) + `settle`, followed by `distribute` when `refundFunding` is `"none"`. |
   | `capture` with `voidRemainder` | Ed25519(final) + `seal_final` + `distribute`. |
   | `void` | Ed25519(final) + `seal_final` + `distribute`. |
   | `refund` | Ed25519(refund) + `refund`. |

   Under `refundFunding: "escrow"`, `distribute` before `refundDeadline` returns the released hold to the client but pays no captured funds; the facilitator distributes those after `refundDeadline`, as maintenance.
3. **Submit**, wait for confirmation, and confirm the transaction succeeded onchain.
4. **Return** the `SettlementResponse`.

| `SettlementResponse` field | Value |
| --- | --- |
| `transaction` | Base58 signature of the confirmed transaction containing the operation's instruction: `open`, `settle`, `seal_final`, or `refund`. |
| `amount` | `authorize`: the hold. `capture`: the amount captured by this operation. `void`: `"0"`. `refund`: the amount refunded. |
| `payer` | `from` on the collect settle; the channel `payer` on lifecycle settles. |
| `network` | CAIP-2 network. |

A collect settle MUST wait until the channel account is confirmed `Open` and re-check that its fields bind the requirements before reporting success, so the resource is never served against a hold that did not land.

Settlement transactions are facilitator-built, so their message version is the facilitator's choice; the rules in SVM `upto` [Facilitator-built transactions](../upto/scheme_upto_svm.md#facilitator-built-transactions) apply.

### Duplicate settlement mitigation

Concurrent `/settle` calls for one operation can all pass the precondition check and each observe success. A facilitator MUST keep a short-term settlement cache, keyed per operation, and reject a key already present with `duplicate_settlement` without broadcasting:

| Operation | Cache key |
| --- | --- |
| `authorize` | `auth-capture:authorize:<network>:<channelId>` |
| `capture`, `void` | `auth-capture:finalize:<network>:<channelId>:<cumulativeAmount>` |
| `refund` | `auth-capture:refund:<network>:<channelId>:<cumulativeAmount>` |

The key is inserted after the request's checks pass and before broadcast, and evicted after 120 seconds. A request that fails its checks MUST NOT insert a key. The cache is a liveness measure, not the replay defense: the program's counters are.

## Refund funding

The scheme requires that a facilitator never become an unexpected source of value. Facilitator-relayed refunds are therefore funded only from the channel escrow, and `extra.refundFunding` declares whether that source exists:

- `"none"` (default). Captured funds are paid out at capture. The channel holds nothing to refund from, so the facilitator MUST reject `type: "refund"` with `invalid_auth_capture_svm_refund_funding_unavailable`. A receiver that wants to refund does so out of band, from its own funds; the facilitator is not involved. The channel can be cleaned up as soon as it is sealed and distributed.
- `"escrow"`. Captured funds stay in the channel escrow until `refundDeadline`. Refunds draw on them, bounded onchain by `settled - refunded`, and the receiver is paid `settled - refunded` per the distribution once `refundDeadline` passes. The receiver waits for its money until then, and the facilitator's rent stays locked until then.

Under `"escrow"` the fee is taken at payout on the net captured amount, so a refund also reduces the fee. This differs from EVM, where the fee is taken at capture and a refund returns only the receiver's share.

## Fee system

`minFeeBps` and `maxFeeBps` MUST be equal; unequal bounds fail with `invalid_auth_capture_svm_fee_range_unsupported`. The fee is a fixed split committed in the channel's distribution at `open`, not a value chosen at capture, so no party submitting a lifecycle transaction can vary it, and no message signs a fee.

- `maxFeeBps == 0`: no fee and no distribution entry; `feeRecipient` MAY be absent and is ignored.
- `maxFeeBps > 0`: the distribution's single entry sends `maxFeeBps` of every payout to `feeRecipient`, and `payTo` receives the remainder. `feeRecipient` MUST be present, MUST NOT be the all-zero key, and MUST differ from `payTo`.

The program computes each recipient's share from cumulative payouts, so the fee is `floor(payout * maxFeeBps / 10000)` within one atomic unit, and any rounding residue goes to `payTo` as the payee. Fee terms advertised in `/supported` MUST be copied verbatim into the requirements, as in the EVM binding.

## `/supported`

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "auth-capture",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "extra": {
        "feePayer": "<facilitator>",
        "receiverAuthorizer": "<facilitator-authorizer>",
        "feeRecipient": "<facilitator-fee-recipient>",
        "minFeeBps": 0,
        "maxFeeBps": 0,
        "transactionVersions": [0, 1]
      }
    }
  ],
  "extensions": [],
  "signers": { "solana:*": ["<facilitator>"] }
}
```

- `extra.feePayer` is REQUIRED: the key the facilitator signs `open` and every settlement transaction with, committed onchain as the channel `rent_payer`. A facilitator MAY vary it between responses; it MUST keep every advertised key able to pay fees until the payments that used it are reclaimed, since rent returns to that key.
- `extra.receiverAuthorizer` is OPTIONAL: a key the facilitator will sign messages with on a server's behalf. A facilitator MUST NOT advertise one unless it can authenticate lifecycle requests out of band. The key is committed in the channel's address and `authorized_signer`, so a payment that delegates it is captive to this facilitator until `refundDeadline` (or `captureDeadline` with `refundFunding: "none"`).
- `extra.feeRecipient`, `extra.minFeeBps`, and `extra.maxFeeBps` are OPTIONAL facilitator fee terms, with equal bounds.
- `extra.transactionVersions` is OPTIONAL, with the SVM `upto` semantics.

## Channel discovery

Channel state is onchain, so local storage is an optimization. A client finds the channels it funded by `payer`; a facilitator finds those it sponsored by `rent_payer`; a server finds those it can finalize by `authorized_signer` or `payee`. Implementations MUST use `getProgramAccounts` against the canonical program with a `dataSize` filter for the auth-capture channel version and `memcmp` filters at that version's field offsets, MUST decode results with the program's codec, and MUST rederive each PDA from its decoded fields before acting on it.

Maintenance that a facilitator SHOULD run, and that anyone MAY run:

- At or after `captureDeadline`, for a channel still `Open`: `seal` + `distribute`, which returns the remaining hold to the client.
- At or after `refundDeadline`, under `refundFunding: "escrow"`: `distribute`, which pays the receiver and fee recipient.
- Once distributed and past the program's gates: `reclaim`, which returns rent to `rent_payer`.

A server that lost its local state MUST NOT capture from a guess: without its own record of the amount owed, the conservative path is a `void`, or letting the capture deadline pass.

## Error Codes

The scheme uses the standard x402 error codes plus the following. Every reason this binding defines is namespaced `invalid_auth_capture_svm_*`; standard reasons it also returns, such as `invalid_network`, `unsupported_transaction_version`, and `duplicate_settlement`, keep their canonical names.

### Verification errors

| Error Code | Description |
| --- | --- |
| `invalid_auth_capture_svm_payload_format` | Payload matches neither the client shape nor a lifecycle shape, or a client payload carries `type` or `authorizerSignature`. |
| `invalid_auth_capture_svm_payload_type` | `payload.type` is not `"capture"`, `"void"`, or `"refund"`. |
| `invalid_auth_capture_svm_scheme` | Scheme is not `auth-capture`. |
| `invalid_auth_capture_svm_network_mismatch` | Payload network does not match requirements. |
| `invalid_auth_capture_svm_extra` | `extra` is missing a REQUIRED field, carries a malformed value, or carries a field reserved for another binding. |
| `invalid_auth_capture_svm_unsupported_payment_flow` | Resolved `paymentFlow` is not `"escrow"`. |
| `invalid_auth_capture_svm_fee_range_unsupported` | `minFeeBps != maxFeeBps`, or `feeRecipient` is missing or equals `payTo` for a non-zero fee. |
| `invalid_auth_capture_svm_deadline_ordering` | Deadlines violate `now + maxTimeoutSeconds <= captureDeadline <= refundDeadline`. |
| `invalid_auth_capture_svm_capture_deadline_expired` | `captureDeadline <= now + 6s` (floor) at collect, or a capture or void was attempted at or after it. |
| `invalid_auth_capture_svm_refund_deadline_expired` | A refund was attempted at or after `refundDeadline`. |
| `invalid_auth_capture_svm_payment_lifetime_exceeded` | A deadline is further out than the facilitator's maximum rent lockup. |
| `invalid_auth_capture_svm_channel_already_open` | An account already exists at `channelId` on the collect settle. |
| `invalid_auth_capture_svm_channel_id_mismatch` | `payload.channelId` does not equal the derived PDA or the `open` channel account. |
| `invalid_auth_capture_svm_open_mismatch` | The decoded `open` does not encode the values the requirements and payload dictate. |
| `invalid_auth_capture_svm_transaction_policy` | `openTransaction` violates the acceptance policy. |
| `invalid_auth_capture_svm_settlement_readiness` | The settlement-readiness check failed before the hold was placed. |
| `invalid_auth_capture_svm_channel_mismatch` | On a lifecycle settle, the channel is missing, not an auth-capture channel, or does not bind the requirements. |
| `invalid_auth_capture_svm_channel_status` | The channel's status does not admit the operation. |
| `invalid_auth_capture_svm_authorizer_signature` | `authorizerSignature` does not verify against `extra.receiverAuthorizer`, or is omitted at a facilitator that does not hold the key. |
| `invalid_auth_capture_svm_unauthenticated_authorizer_request` | The authorizer is delegated and the request carries no matching out-of-band authentication. |
| `invalid_auth_capture_svm_delegated_auth_unavailable` | The authorizer is delegated and the caller-binding store could not be read or written. Retryable. |
| `invalid_auth_capture_svm_unexpected_payment_state` | `settled` or `refunded` differs from the signed expectation, or the amount exceeds the remaining hold or refundable balance. |
| `invalid_auth_capture_svm_refund_funding_unavailable` | `type: "refund"` under `refundFunding: "none"`. |
| `invalid_auth_capture_svm_simulation_failed` | Simulation failed. |

### Settlement errors

| Error Code | Description |
| --- | --- |
| `invalid_auth_capture_svm_verification_failed` | Re-verification before settlement failed. |
| `invalid_auth_capture_svm_transaction_failed` | The transaction was not confirmed, or failed onchain. |

## Security considerations

- **Fund safety.** The program caps every capture by `deposit == amount`, which the client signed. The fee is a split the client signed in `open`. Refunds go only to the client's token account and are bounded by what was captured.
- **No redirection.** The receiver, fee recipient, and split are committed in `distribution_hash` and the `payee` seed at `open` and re-checked by `distribute`. No lifecycle operation names a destination.
- **Server consent.** `capture`, `void`, and `refund` each require a message from the receiver authorizer, checked onchain. A facilitator cannot capture, release, or refund on its own, and holds no channel authority that lets it close a hold early. When the server delegates the authorizer, the facilitator's out-of-band authentication of the server is the consent, and the server trusts the facilitator to sign what it asked for and no more.
- **Replay protection.** Each message is scoped to one `channelId`, one operation by its magic, and one cumulative target, and the program applies it at most once. The facilitator's state checks and settlement cache prevent wasted transactions; they are not the replay defense.
- **Hold guarantee.** Before `captureDeadline` the client cannot `request_close`, so a hold the server relied on to serve the resource cannot be withdrawn under it.
- **Client recourse.** At `captureDeadline` capture stops and the remaining hold becomes reclaimable by anyone on the client's behalf, without a grace period. A server or facilitator that disappears cannot keep the client's funds past the deadline.
- **Facilitator exposure.** The facilitator fronts rent and fees. Rent is locked at most until `captureDeadline`, or `refundDeadline` under `refundFunding: "escrow"`, and is always recoverable without cooperation; a facilitator bounds the lockup with its maximum payment lifetime. The `openTransaction` acceptance policy keeps the client-built transaction from spending the facilitator's SOL beyond fees and rent.
- **Settlement atomicity.** Each operation is one transaction. Capture-and-void is one signed message and one seal, so there is no window in which the capture landed and the void did not.
- **Receiver liveness under escrow refunds.** Under `refundFunding: "escrow"`, captured funds wait in the channel until `refundDeadline`. A receiver choosing it accepts that delay in exchange for relayed refunds.

## Appendix

### Comparison with the EVM binding

| Aspect | EVM | SVM |
| --- | --- | --- |
| Hold | `AuthCaptureEscrow` singleton, `paymentState` per `paymentInfoHash` | One payment-channels channel per payment |
| Client authorization | ERC-3009 or Permit2 signature naming a token collector | Partially signed `open` transaction |
| Payment identity | `paymentInfoHash`, salt-bound | Channel PDA, nonce- and slot-seeded |
| Operator | `extra.captureAuthorizer`, the only `msg.sender` the escrow accepts | None; any fee payer submits, the program checks messages |
| Server consent | EIP-712 signature, checked by the facilitator (`delegated`) or the operator (`policy`) | Ed25519 message, checked by the program |
| Replay protection | Signed `(capturable, refundable)` expectations, checked by the facilitator | Cumulative targets, enforced by the program |
| Capture-and-void | Two signatures, possibly two transactions | One final message, one transaction |
| Fee | Chosen at capture within `[minFeeBps, maxFeeBps]`, not refunded | Fixed split committed at `open`, reduced by escrow-funded refunds |
| Refund liquidity | `OperatorRefundCollector` pulls from the operator | Channel escrow (`refundFunding: "escrow"`), otherwise out of band |
| `reclaim` | Client-only, after `authorizationExpiry` | Permissionless, after `captureDeadline` |
| `authorization` flow | Supported | Not supported |

### Expiry ordering

| Deadline | Enforced by | Effect |
| --- | --- | --- |
| Blockhash of `openTransaction` | The runtime | Blocks collecting the client's funds after about 60–90 seconds |
| `captureDeadline` | `settle`, `seal_final`, `seal`, `request_close` | Blocks capture and void; unlocks `reclaim` |
| `refundDeadline` | `refund`, `distribute`, `reclaim` | Blocks refunds; under escrow funding, releases captured funds to the receiver |

## Version History

| Version | Date | Changes | Authors |
| --- | --- | --- | --- |
| v1.0 | 2026-10-26 | Initial draft | @lgalabru |
