# SVM `batch-settlement` Scheme: High-Throughput Channel Payments on Solana

> Status: **draft**. Companion to the network-agnostic
> [`scheme_batch_settlement.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md).
> This document specifies how the `batch-settlement` scheme is realized on
> Solana Virtual Machine (SVM) networks.

## 1. Purpose

`batch-settlement` is the high-throughput x402 scheme: a client deposits once
into an escrow channel, then signs cumulative Ed25519 vouchers for individual
requests. The server verifies each voucher offchain, stores the latest
commitment, serves immediately, and later redeems the latest voucher onchain.
This removes onchain settlement from the request path.

On SVM this scheme is backed by the
[payment-channels program](https://github.com/solana-foundation/payment-channels),
the same program used by SVM `upto`. `upto` is a one-request channel that closes
after one metered charge; `batch-settlement` keeps the channel open across many
requests and advances a cumulative watermark.

The x402 roles map to the payment-channel program as follows:

- **Client**: channel `payer`; funds deposits and signs per-request vouchers
  through `payerAuthorizer`.
- **Payer authorizer**: client-controlled Ed25519 key recorded as channel
  `authorized_signer`; signs cumulative vouchers. It MAY equal `payer`.
- **Server**: resource provider; receives funds at `payTo`; owns per-channel
  offchain state, including the accepted cumulative watermark and latest
  voucher.
- **Receiver authorizer**: server-controlled Ed25519 key advertised as
  `extra.receiverAuthorizer`. It authenticates server-approved cooperative
  refund requests to the facilitator. It is an offchain x402 role and is not
  recorded in the payment-channel account.
- **Facilitator / sponsor**: account advertised as `extra.feePayer`; sponsors
  transaction fees and channel rent. It is the transaction fee payer and channel
  `rent_payer`, and occupies the channel `payee` lifecycle-authority seat with a
  zero share of settled funds. The server MAY self-facilitate.

`payTo` is the server's payment receiver, typically a cold wallet. The channel
distribution always sends 100% of settled funds to `payTo` through one explicit
recipient and leaves the channel `payee` with a zero implicit remainder, even
when both roles use the same address.

This authority split prevents rent lock without granting payment authority to
the facilitator:

- The facilitator, as `payee`, can run `settle_and_seal` with
  `has_voucher = 0`, then `distribute` and `reclaim`, even if the client and
  server disappear. A client/server pair cannot strand the rent it sponsored.
- Only the client-controlled `payerAuthorizer` can sign a voucher that advances
  the settled watermark. The facilitator can close at the current onchain
  watermark, but it cannot create a nonzero claim or redirect funds.

A facilitator that closes before the latest client voucher is claimed freezes
the watermark and causes the unclaimed remainder to be returned to the client.
The server MUST treat unclaimed voucher value as facilitator credit risk and
claim promptly.

## 2. Mapping the Core Requirements to SVM

| Requirement (generic spec) | SVM mechanism |
|---|---|
| One-time escrow deposit | Payment-channels `open` deposits escrow, records `withdrawDelay`, fixes `payee`, `authorized_signer`, `rent_payer`, and commits `distribution_hash`. |
| Per-request authorization | Ed25519 voucher signed by `payerAuthorizer` over `0x56 0x01 \|\| channelId \|\| maxClaimableAmount \|\| expiresAt`. |
| Monotonic amount | Server-owned offchain watermark plus onchain `settled < maxClaimableAmount <= deposit` at redemption. |
| Batched redemption | One `settle` per channel, packed transaction-size permitting; `distribute` pays settled deltas. |
| Recipient binding | `distribution_hash` fixed at `open` sends funds to `payTo`; program re-checks it at `distribute`. |
| Recovery of unused deposit | Server-authorized `settle_and_seal` + `distribute` for full cooperative close; `request_close` / `seal` / `withdraw_payer` for payer-forced close. |

## 3. Payment-Channel Method

SVM `batch-settlement` defines a single payment method backed by the
payment-channels program, so the wire format does not include
`extra.assetTransferMethod`.

The canonical program id is a network/SDK constant, not a server-provided wire
field. For the current mainnet deployment:

```text
CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX
```

Implementations MUST target the canonical payment-channels program id for the
selected `network` and MUST NOT trust or negotiate a `channelProgram` value from
`extra`. Program documentation and instruction references live in the
[payment-channels repository](https://github.com/solana-foundation/payment-channels).

The current program lifecycle is:

1. `open`: creates the channel PDA, escrows the deposit, stores
   `grace_period == extra.withdrawDelay`, stores `open_slot`, and commits the
   payout distribution.
2. `settle`: permissionlessly advances the onchain `settled` watermark from a
   valid voucher.
3. `distribute`: permissionlessly pays the newly settled delta to `payTo` and
   advances `payout_watermark`. While the channel is still open, it does not
   return unused escrow to the payer or close the escrow.
4. `settle_and_seal`: `payee`-signed cooperative close. It may apply a final
   voucher, locks the watermark, and moves the channel to `Sealed`.
5. Sealed `distribute`: pays any final settled delta, returns
   `deposit - settled` to the payer, closes the escrow token account, and either
   deallocates the channel PDA immediately or marks it `Distributed`.
6. `reclaim`: permissionless cleanup for `Distributed` channels after
   `clock.slot > open_slot + OPEN_SLOT_WINDOW`; it returns remaining PDA rent to
   the recorded `rent_payer`.

The address carried on the x402 wire as `extra.feePayer` is recorded by the
program as both `Channel.rent_payer` and zero-share `Channel.payee`. Rent returns
to that address during the final `distribute` fast path or a later `reclaim`.
Because the sponsor holds the `payee` lifecycle authority, it can seal and clean
up an abandoned channel without a client or server signature. It MUST be able
to rediscover the channels it sponsored as specified in section 6. Token
payouts and the return of unused escrow are completed by `distribute` and are
not delayed by the later `reclaim` of PDA rent.

For an x402 cooperative refund, the facilitator MUST additionally require a
valid refund authorization from `extra.receiverAuthorizer`. That signature
authenticates the server's HTTP request; it does not replace the facilitator's
onchain `payee` signature or the client's voucher signature. The facilitator
MUST bind `receiverAuthorizer` to the authenticated resource server and `payTo`
through trusted configuration or an authenticated registration established no
later than channel opening. It MUST NOT trust a receiver-authorizer key merely
because it appears in `PaymentRequirements` or a settlement request. The
trusted receiver authorizer is fixed for the channel lifetime; changing it
requires cooperatively closing the channel and opening a new one.

If the client invokes `request_close`, the channel enters `Closing` and regular
`settle` is no longer available. Only the `payee` can apply a final voucher with
`settle_and_seal` during the grace period. After the grace period, anyone can
call `seal`; the payer can recover unspent escrow through `withdraw_payer` or
sealed `distribute`.

## 4. Wire Format

`batch-settlement` reuses the x402 v2 transport: a `402` response carries
`PAYMENT-REQUIRED`; each paid request carries `PAYMENT-SIGNATURE`; the response
carries `PAYMENT-RESPONSE`. The core `PaymentRequirements`, `PaymentPayload`,
and `SettlementResponse` types are defined in
[`x402-specification-v2.md`](../../x402-specification-v2.md).

### 4.1 `PaymentRequirements` (in `PAYMENT-REQUIRED.accepts[]`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `scheme` | string | yes | `"batch-settlement"` |
| `network` | string | yes | CAIP-2, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| `amount` | string | yes | Fixed per-request price in atomic units. |
| `asset` | string | yes | Concrete SPL / Token-2022 mint pubkey, not a symbol. |
| `payTo` | string | yes | Base58 final payment receiver. Normally a server cold wallet. |
| `maxTimeoutSeconds` | number | yes | HTTP completion window. |
| `extra` | object | yes | See below. |

`extra`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `feePayer` | string | yes | Base58 sponsor key set as channel `rent_payer` and zero-share `payee`. Co-signs setup/top-up transactions as transaction fee payer and signs channel lifecycle transactions. |
| `receiverAuthorizer` | string | yes | Base58 server-controlled Ed25519 key that authenticates cooperative refund requests to the facilitator. It is not a payment-channel account field. |
| `withdrawDelay` | number | yes | Server-defined forced-close grace period in seconds. The client MUST encode this exact value as the program `grace_period`; the verifier MUST reject any other value. |
| `recentBlockhash` | string | no | Pre-fetched blockhash the client MAY use to build an `open` or `top_up` transaction without an RPC round trip. The client MUST refresh it if it is no longer valid. |
| `recentSlot` | number | no | Recent slot the client MAY use as `channelConfig.openSlot` when it does not fetch its own slot. The program still enforces the open-slot window. |
| `channelState` | object | no | Corrective-only server channel snapshot for cumulative amount resynchronization. |
| `voucherState` | object | no | Corrective-only signed voucher proof for cumulative amount resynchronization. |

`recentBlockhash` and `recentSlot` are transaction-construction hints only. They
are not persistent channel configuration and are not included in the voucher
message. A client MAY ignore either hint and obtain a fresher value from an RPC.

The x402 wire format does not expose program-specific split arrays. The client
derives the payment-channel accounts and distribution from the x402 fields:

```text
rent_payer = extra.feePayer
payee = extra.feePayer
authorized_signer = channelConfig.payerAuthorizer
grace_period = extra.withdrawDelay

recipients = [{ recipient: payTo, bps: 10000 }]
payee_implicit_remainder_bps = 0
```

Any facilitator commercial fee is outside this wire contract or included in the
server's pricing. The channel distribution for this scheme MUST NOT assign any
portion of settled funds away from `payTo`. The explicit single-entry
distribution is REQUIRED even when `payTo == extra.feePayer`.

Example:

```json
{
  "scheme": "batch-settlement",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "1000",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payTo": "<server-receiver>",
  "maxTimeoutSeconds": 300,
  "extra": {
    "feePayer": "<facilitator-fee-payer>",
    "receiverAuthorizer": "<server-refund-authorizer>",
    "withdrawDelay": 3600,
    "recentBlockhash": "<recent-blockhash>",
    "recentSlot": 341000000
  }
}
```

### 4.2 Shared Wire Objects and Program Mapping

The wire format uses network-neutral x402 names even when the SVM program uses
different instruction or account notation:

In this section, camelCase names identify x402 wire fields. Snake_case names
identify the payment-channels program's Rust account fields; generated clients
may expose those program fields with language-specific casing.

| x402 wire field | Payment-channels program notation |
|---|---|
| `PaymentRequirements.extra.feePayer` | `Channel.rent_payer` and zero-share `Channel.payee` |
| `PaymentRequirements.extra.receiverAuthorizer` | No program field; trusted server key for offchain refund authorization |
| `channelConfig.payer` | `Channel.payer` |
| `channelConfig.payerAuthorizer` | `Channel.authorized_signer` |
| `channelConfig.receiver` | Sole `DistributionEntry.recipient` with `bps = 10000`; the `Channel.payee` implicit remainder is always zero |
| `channelConfig.receiverAuthorizer` | No program field; MUST equal `PaymentRequirements.extra.receiverAuthorizer` |
| `channelConfig.token` | `Channel.mint` |
| `channelConfig.withdrawDelay` | `Channel.grace_period` |
| `channelConfig.salt` | `Channel.salt` |
| `channelConfig.openSlot` | `Channel.open_slot` |
| `voucher.channelId` | `VoucherArgs.channel_id` |
| `voucher.maxClaimableAmount` | `VoucherArgs.cumulative_amount` |
| `voucher.expiresAt` | `VoucherArgs.expires_at`; `0` disables voucher expiry |
| `channelState.balance` | `Channel.deposit` |
| `channelState.totalClaimed` | `Channel.settled` |
| `channelState.withdrawRequestedAt` | `Channel.closure_started_at` |
| `channelState.chargedCumulativeAmount` | Server-owned offchain cumulative charge |

`ChannelConfig`:

| Field | Type | Notes |
|---|---|---|
| `payer` | string | Client wallet and channel payer. MUST NOT equal `feePayer`, because the program requires distinct payer and payee accounts. |
| `payerAuthorizer` | string | Client-controlled Ed25519 voucher signer; maps to channel `authorized_signer`. MAY equal `payer` but MUST NOT equal `feePayer`. |
| `receiver` | string | MUST equal `payTo`. |
| `receiverAuthorizer` | string | MUST equal `extra.receiverAuthorizer`. This key authenticates cooperative refund requests offchain and is not a channel PDA seed or program account field. |
| `token` | string | MUST equal `asset`; maps to channel `mint`. |
| `withdrawDelay` | number | MUST equal `extra.withdrawDelay`; maps to channel `grace_period`. |
| `salt` | string | Decimal `u64` channel salt. |
| `openSlot` | number | `u64` slot encoded in `open` and used as a channel PDA seed. |

The client MUST determine the token program from the onchain owner of
`channelConfig.token`; it MUST NOT accept an unverified token-program value from
the server.

`channelId` is the program-derived address:

```text
find_program_address(
  [
    "channel",
    channelConfig.payer,
    PaymentRequirements.extra.feePayer,
    channelConfig.token,
    channelConfig.payerAuthorizer,
    u64(channelConfig.salt).to_le_bytes(),
    u64(channelConfig.openSlot).to_le_bytes()
  ],
  CANONICAL_PAYMENT_CHANNELS_PROGRAM_ID
)
```

For a new channel, the `open` instruction MUST encode:

- `salt == channelConfig.salt`
- `deposit == deposit.amount`
- `grace_period == channelConfig.withdrawDelay`
- `open_slot == channelConfig.openSlot`
- `rent_payer == PaymentRequirements.extra.feePayer`
- `payee == PaymentRequirements.extra.feePayer`
- `authorized_signer == channelConfig.payerAuthorizer`
- `mint == channelConfig.token`
- the distribution derived from `channelConfig.receiver` as specified in
  section 4.1

`BatchVoucher`:

| Field | Type | Notes |
|---|---|---|
| `channelId` | string | Channel PDA (base58). |
| `maxClaimableAmount` | string | Cumulative authorized total in atomic units; maps to program `cumulative_amount`. |
| `expiresAt` | number | Unix seconds. `0` means no voucher expiry; otherwise the program enforces `now < expiresAt` at `settle` / `settle_and_seal`. |
| `signature` | string | Base58 Ed25519 signature by `channelConfig.payerAuthorizer`. |

The signed message is exactly:

```text
0x56 0x01 || channelId || u64(maxClaimableAmount).le || i64(expiresAt).le
```

This is the payment-channels program voucher layout (`VOUCHER_MAGIC`,
`channel_id`, `cumulative_amount`, `expires_at`), 50 bytes total.

`RefundAuthorization`:

| Field | Type | Notes |
|---|---|---|
| `validBefore` | number | Integer Unix seconds. The server MUST set it no later than its current time plus `maxTimeoutSeconds`; the facilitator MUST require `now < validBefore <= now + maxTimeoutSeconds`. |
| `signature` | string | Base58 Ed25519 signature by `extra.receiverAuthorizer` over the digest below. |

The receiver authorizer signs the SHA-256 digest of this exact byte sequence:

```text
UTF8("x402:batch-settlement:svm:refund:v1") || 0x00 ||
u16(len(network)).le || UTF8(network) ||
programId[32] ||
feePayer[32] ||
channelId[32] ||
u64(maxClaimableAmount).le ||
i64(voucherExpiresAt).le ||
i64(validBefore).le
```

`network` is the canonical CAIP-2 identifier from `PaymentRequirements`;
`programId` is the canonical payment-channels program id for that network; and
`feePayer`, `channelId`, and the voucher fields are decoded to their canonical
binary forms. The length is the number of UTF-8 bytes in `network`. This domain
separation prevents the signature from authorizing another operation, network,
program deployment, facilitator, channel, voucher watermark, or expiry.

`ChannelState`:

| Field | Type | Notes |
|---|---|---|
| `channelId` | string | Channel PDA (base58). |
| `balance` | string | Current `Channel.deposit` ceiling in atomic units. |
| `totalClaimed` | string | Current onchain `Channel.settled` watermark. |
| `withdrawRequestedAt` | number | `Channel.closure_started_at`, or `0` when no forced close is pending. |
| `chargedCumulativeAmount` | string | Server-owned offchain cumulative fixed charge. Present only when the response is authored by the server. |

### 4.3 Client `PaymentPayload` Variants

The client payload is a tagged union on `payload.type`. `/verify` accepts all
three variants. `/settle` accepts `deposit` directly; the server enriches
`refund` with a `RefundAuthorization` before forwarding it as specified in
section 4.5. A `voucher` is accepted offchain by the server.

**`deposit`** opens a channel or tops up an existing channel and authorizes the
current request:

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"deposit"` |
| `channelConfig` | `ChannelConfig` | Full channel configuration. |
| `voucher` | `BatchVoucher` | Cumulative authorization for the current request. |
| `deposit.amount` | string | Amount to deposit or top up in atomic units. |
| `deposit.transaction` | string | Base64 client-signed `open` or `top_up` transaction for the facilitator to validate, co-sign, and broadcast. |

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "batch-settlement",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "<server-receiver>",
    "maxTimeoutSeconds": 300,
    "extra": {
      "feePayer": "<facilitator-fee-payer>",
      "receiverAuthorizer": "<server-refund-authorizer>",
      "withdrawDelay": 3600,
      "recentBlockhash": "<recent-blockhash>",
      "recentSlot": 341000000
    }
  },
  "payload": {
    "type": "deposit",
    "channelConfig": {
      "payer": "<client-wallet>",
      "payerAuthorizer": "<client-voucher-signer>",
      "receiver": "<server-receiver>",
      "receiverAuthorizer": "<server-refund-authorizer>",
      "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "withdrawDelay": 3600,
      "salt": "42",
      "openSlot": 341000000
    },
    "voucher": {
      "channelId": "<channel-pda>",
      "maxClaimableAmount": "1000",
      "expiresAt": 0,
      "signature": "<base58-ed25519-signature>"
    },
    "deposit": {
      "amount": "100000",
      "transaction": "<base64-client-signed-open-or-top-up-transaction>"
    }
  }
}
```

**`voucher`** authorizes a steady-state paid request without an onchain
transaction:

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"voucher"` |
| `channelConfig` | `ChannelConfig` | Full channel configuration. |
| `voucher` | `BatchVoucher` | New cumulative voucher. |

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "batch-settlement",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "<server-receiver>",
    "maxTimeoutSeconds": 300,
    "extra": {
      "feePayer": "<facilitator-fee-payer>",
      "receiverAuthorizer": "<server-refund-authorizer>",
      "withdrawDelay": 3600,
      "recentBlockhash": "<recent-blockhash>",
      "recentSlot": 341000000
    }
  },
  "payload": {
    "type": "voucher",
    "channelConfig": {
      "payer": "<client-wallet>",
      "payerAuthorizer": "<client-voucher-signer>",
      "receiver": "<server-receiver>",
      "receiverAuthorizer": "<server-refund-authorizer>",
      "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "withdrawDelay": 3600,
      "salt": "42",
      "openSlot": 341000000
    },
    "voucher": {
      "channelId": "<channel-pda>",
      "maxClaimableAmount": "5000",
      "expiresAt": 0,
      "signature": "<base58-ed25519-signature>"
    }
  }
}
```

**`refund`** requests immediate cooperative closure and the return of all
unspent escrow. It is a payment operation, not a paid resource request, so the
application resource handler MUST be bypassed. The request MUST NOT contain an
`amount`: the payment-channel program supports only a full refund of
`deposit - settled`, and the closed channel cannot be reused.

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"refund"` |
| `channelConfig` | `ChannelConfig` | Full channel configuration. |
| `voucher` | `BatchVoucher` | Zero-charge voucher whose `maxClaimableAmount` equals the server's current `chargedCumulativeAmount`. |

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "batch-settlement",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "<server-receiver>",
    "maxTimeoutSeconds": 300,
    "extra": {
      "feePayer": "<facilitator-fee-payer>",
      "receiverAuthorizer": "<server-refund-authorizer>",
      "withdrawDelay": 3600,
      "recentBlockhash": "<recent-blockhash>",
      "recentSlot": 341000000
    }
  },
  "payload": {
    "type": "refund",
    "channelConfig": {
      "payer": "<client-wallet>",
      "payerAuthorizer": "<client-voucher-signer>",
      "receiver": "<server-receiver>",
      "receiverAuthorizer": "<server-refund-authorizer>",
      "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "withdrawDelay": 3600,
      "salt": "42",
      "openSlot": 341000000
    },
    "voucher": {
      "channelId": "<channel-pda>",
      "maxClaimableAmount": "5000",
      "expiresAt": 0,
      "signature": "<base58-ed25519-zero-charge-voucher-signature>"
    }
  }
}
```

### 4.4 `SettlementResponse` (in `PAYMENT-RESPONSE`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `success` | boolean | yes | Whether acceptance or settlement succeeded. |
| `errorReason` | string | no | Omitted on success. |
| `payer` | string | no | Channel `payer`. |
| `transaction` | string | yes | Onchain signature for deposit/top-up/refund/claim/settle operations; empty string for offchain voucher acceptance. |
| `network` | string | yes | CAIP-2 network identifier. |
| `amount` | string | no | Amount moved onchain; empty for voucher acceptance and `claim`. |
| `extra.commitmentId` | string | no | MUST be non-empty for voucher acceptance, e.g. `channelId:maxClaimableAmount`. |
| `extra.chargedAmount` | string | no | Fixed per-request charge; MUST equal `PaymentRequirements.amount`. |
| `extra.channelState` | `ChannelState` | no | Current channel snapshot. |

Scheme-specific response fields are nested under `extra`.
A successful voucher-only response is:

```json
{
  "success": true,
  "transaction": "",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "<client-wallet>",
  "amount": "",
  "extra": {
    "commitmentId": "<channel-pda>:5000",
    "chargedAmount": "1000",
    "channelState": {
      "channelId": "<channel-pda>",
      "balance": "100000",
      "totalClaimed": "3000",
      "withdrawRequestedAt": 0,
      "chargedCumulativeAmount": "5000"
    }
  }
}
```

### 4.5 Facilitator Interface

The standard x402 `POST /verify` and `POST /settle` request envelope contains
`x402Version`, `paymentPayload`, and `paymentRequirements`. For every request,
`paymentPayload.accepted` MUST equal `paymentRequirements`.

| Request field | Type | Required | Notes |
|---|---|---|---|
| `x402Version` | number | yes | MUST be `2`. |
| `paymentPayload` | `PaymentPayload` | yes | Its inner `payload` is one of the variants defined below. |
| `paymentRequirements` | `PaymentRequirements` | yes | The selected requirements from the server's `PaymentRequired`. |

#### `POST /verify`

`paymentPayload.payload` MUST be one of the client-authored `deposit`, `voucher`,
or `refund` variants in section 4.3. The facilitator validates the wire fields,
voucher signature, derived channel PDA, and onchain channel state and, for
`deposit`, the client-signed transaction. For `refund`, it additionally confirms
that the voucher is redeemable or already reflected in `Channel.settled`, the
channel is `Open` or is still within its `Closing` grace period, and the payer's
canonical refund ATA is healthy.

| Response field | Type | Required | Notes |
|---|---|---|---|
| `isValid` | boolean | yes | Whether the payload is valid. |
| `invalidReason` | string | no | Machine-readable reason when invalid. |
| `payer` | string | no | Channel payer when recoverable from the payload. |
| `extra.channelId` | string | no | Derived channel PDA. |
| `extra.balance` | string | no | Onchain `Channel.deposit`. |
| `extra.totalClaimed` | string | no | Onchain `Channel.settled`. |
| `extra.withdrawRequestedAt` | number | no | Onchain `Channel.closure_started_at`. |

A successful response is:

```json
{
  "isValid": true,
  "payer": "<client-wallet>",
  "extra": {
    "channelId": "<channel-pda>",
    "balance": "1000000",
    "totalClaimed": "500000",
    "withdrawRequestedAt": 0
  }
}
```

The facilitator MUST return `isValid: false` with `invalidReason` when
verification fails. The server MAY verify ordinary voucher payloads locally
when its onchain snapshot is fresh; `deposit` and `refund` MUST be sent to the
facilitator.

#### `POST /settle`

Each wire `type` names the effect of the payload, not the payment-channels
instruction it invokes:

| Wire `payload.type` | Author | Effect | SVM program instruction |
|---|---|---|---|
| `deposit` | Client | Open a channel or add escrow. | `open` / `top_up` |
| `voucher` | Client | Accept an offchain authorization; no funds move. | None |
| `claim` | Server | Advance accounting; no funds move to the receiver. | `settle` |
| `settle` | Server | Move earned funds to the receiver. | `distribute` |
| `refund` | Client, then server-enriched | Apply any final voucher, close the channel, and return all unspent escrow. | `settle_and_seal` + sealed `distribute` |

The examples in this subsection show the inner `paymentPayload.payload`; the
caller MUST wrap each one in the standard request envelope defined above.

The `deposit` settle payload is the client variant from section 4.3. A `voucher`
is stored and answered by the server without a facilitator settlement. The
server-authored or server-enriched variants are:

| Payload | Field | Type | Notes |
|---|---|---|---|
| Claim | `type` | string | `"claim"` |
| Claim | `claims` | array | One to four voucher claims. |
| Claim | `claims[].voucher.channelConfig` | `ChannelConfig` | Full channel configuration. |
| Claim | `claims[].voucher.channelId` | string | Channel PDA. |
| Claim | `claims[].voucher.maxClaimableAmount` | string | Cumulative amount for program `settle`. |
| Claim | `claims[].voucher.expiresAt` | number | Voucher expiry. |
| Claim | `claims[].signature` | string | Base58 Ed25519 voucher signature. |
| Settle | `type` | string | `"settle"` |
| Settle | `channels` | array | One or more channels to distribute. |
| Settle | `channels[].channelId` | string | Channel PDA. |
| Settle | `channels[].channelConfig` | `ChannelConfig` | Full configuration used to derive accounts, validate the channel, and reconstruct the distribution. |
| Refund | `type` | string | `"refund"` |
| Refund | `channelConfig` | `ChannelConfig` | Client-provided channel configuration. |
| Refund | `voucher` | `BatchVoucher` | Client's zero-charge voucher at the server's current cumulative charge. |
| Refund | `refundAuthorization` | `RefundAuthorization` | Server signature authorizing this full cooperative close. |

The server forwards a client-authored `deposit` unchanged. It MAY settle
`voucher` locally by storing the commitment and producing the response in
section 4.4.

For `refund`, the server MUST serialize processing with every paid request and
other refund for the channel. It MUST require
`voucher.maxClaimableAmount == chargedCumulativeAmount`, verify the client
voucher, bypass the resource handler, and obtain successful facilitator
verification. It then creates a fresh `RefundAuthorization` with
`extra.receiverAuthorizer`, atomically marks the channel refund-pending through
`validBefore`, and forwards the enriched payload. Once it signs, the server MUST
reject new paid requests for the channel until the refund confirms or the
authorization expires; otherwise a delayed valid authorization could close
after a later charge:

```json
{
  "type": "refund",
  "channelConfig": {
    "payer": "<client-wallet>",
    "payerAuthorizer": "<client-voucher-signer>",
    "receiver": "<server-receiver>",
    "receiverAuthorizer": "<server-refund-authorizer>",
    "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "withdrawDelay": 3600,
    "salt": "42",
    "openSlot": 341000000
  },
  "voucher": {
    "channelId": "<channel-pda>",
    "maxClaimableAmount": "5000",
    "expiresAt": 0,
    "signature": "<base58-ed25519-zero-charge-voucher-signature>"
  },
  "refundAuthorization": {
    "validBefore": 1785341100,
    "signature": "<base58-server-refund-authorization-signature>"
  }
}
```

The facilitator MUST validate `refundAuthorization` against the trusted
receiver-authorizer binding, reject it at or after `validBefore`, and construct
the transaction itself. When `Channel.settled <
voucher.maxClaimableAmount`, it emits the voucher's Ed25519 precompile
instruction immediately followed by `settle_and_seal` with `has_voucher = 1`.
When the values are equal, it invokes `settle_and_seal` with `has_voucher = 0`;
submitting an equal voucher onchain would fail the program's strict monotonicity
check. Any other relationship MUST be rejected. It then invokes sealed
`distribute` in the same transaction, verifies the confirmed onchain result,
and returns the full amount `deposit - settled` transferred to the payer.

The server initiates asynchronous accounting with a `claim` payload. Each
claim carries the full channel configuration needed to derive and validate the
channel plus the voucher signature needed to construct the Ed25519 precompile
instruction:

```json
{
  "type": "claim",
  "claims": [
    {
      "voucher": {
        "channelConfig": {
          "payer": "<client-wallet-1>",
          "payerAuthorizer": "<client-voucher-signer-1>",
          "receiver": "<server-receiver>",
          "receiverAuthorizer": "<server-refund-authorizer>",
          "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          "withdrawDelay": 3600,
          "salt": "42",
          "openSlot": 341000000
        },
        "channelId": "<channel-pda-1>",
        "maxClaimableAmount": "5000",
        "expiresAt": 0
      },
      "signature": "<base58-ed25519-voucher-signature-1>"
    },
    {
      "voucher": {
        "channelConfig": {
          "payer": "<client-wallet-2>",
          "payerAuthorizer": "<client-voucher-signer-2>",
          "receiver": "<server-receiver>",
          "receiverAuthorizer": "<server-refund-authorizer>",
          "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          "withdrawDelay": 3600,
          "salt": "43",
          "openSlot": 341000050
        },
        "channelId": "<channel-pda-2>",
        "maxClaimableAmount": "7000",
        "expiresAt": 0
      },
      "signature": "<base58-ed25519-voucher-signature-2>"
    }
  ]
}
```

`claims[]` MUST contain between one and four entries so the instruction pairs
fit in a legacy Solana transaction without address lookup tables. The
facilitator MUST process every entry or fail the request; it MUST NOT silently
truncate a batch. For each claim it emits an Ed25519
precompile instruction immediately followed by the program `settle`
instruction.

After claims advance onchain accounting, the server initiates distribution with
a `settle` payload:

```json
{
  "type": "settle",
  "channels": [
    {
      "channelId": "<channel-pda-1>",
      "channelConfig": {
        "payer": "<client-wallet-1>",
        "payerAuthorizer": "<client-voucher-signer-1>",
        "receiver": "<server-receiver>",
        "receiverAuthorizer": "<server-refund-authorizer>",
        "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "withdrawDelay": 3600,
        "salt": "42",
        "openSlot": 341000000
      }
    },
    {
      "channelId": "<channel-pda-2>",
      "channelConfig": {
        "payer": "<client-wallet-2>",
        "payerAuthorizer": "<client-voucher-signer-2>",
        "receiver": "<server-receiver>",
        "receiverAuthorizer": "<server-refund-authorizer>",
        "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "withdrawDelay": 3600,
        "salt": "43",
        "openSlot": 341000050
      }
    }
  ]
}
```

The facilitator invokes `distribute` for every `channels[]` entry and MUST
process every entry or fail the request. It MUST confirm each transaction
onchain before returning success.

Successful responses have operation-specific `amount` semantics:

Claim (`amount` is empty because no funds move):

```json
{
  "success": true,
  "transaction": "<base58-transaction-signature>",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": ""
}
```

Settle (`amount` is the total transferred to the receiver across the batch):

```json
{
  "success": true,
  "transaction": "<base58-transaction-signature>",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "5000"
}
```

Deposit (`amount` is the amount deposited or topped up):

```json
{
  "success": true,
  "transaction": "<base58-transaction-signature>",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "<client-wallet>",
  "amount": "100000",
  "extra": {
    "commitmentId": "<channel-pda>:1000",
    "chargedAmount": "1000",
    "channelState": {
      "channelId": "<channel-pda>",
      "balance": "100000",
      "totalClaimed": "0",
      "withdrawRequestedAt": 0,
      "chargedCumulativeAmount": "1000"
    }
  }
}
```

Refund (`amount` is the full unspent escrow returned to the payer):

```json
{
  "success": true,
  "transaction": "<base58-transaction-signature>",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "<client-wallet>",
  "amount": "95000",
  "extra": {
    "channelState": {
      "channelId": "<channel-pda>",
      "balance": "0",
      "totalClaimed": "5000",
      "withdrawRequestedAt": 0,
      "chargedCumulativeAmount": "5000"
    }
  }
}
```

After successful refund, the server MUST mark the channel closed and reject
further paid requests for that channel. A later session MUST open a new channel
with a new `openSlot`. If settlement fails, the server MUST retain the
refund-pending state until `refundAuthorization.validBefore` before it may
resume paid requests.

#### `GET /supported`

The facilitator advertises its SVM transaction fee payer. The server MUST copy
this value into `PaymentRequirements.extra.feePayer` and MUST set
`PaymentRequirements.extra.receiverAuthorizer` to the server key covered by its
trusted facilitator registration. The receiver authorizer is server-owned and
is therefore not advertised by the facilitator:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "batch-settlement",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "extra": {
        "feePayer": "<facilitator-fee-payer>"
      }
    }
  ],
  "extensions": [],
  "signers": {
    "solana:*": ["<facilitator-fee-payer>"]
  }
}
```

### 4.6 Corrective `PaymentRequired`

When the client's cumulative amount does not match server state, the server
SHOULD return `invalid_batch_settlement_svm_cumulative_amount_mismatch` with a
signed recovery proof:

```json
{
  "x402Version": 2,
  "error": "invalid_batch_settlement_svm_cumulative_amount_mismatch",
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "amount": "1000",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "<server-receiver>",
      "maxTimeoutSeconds": 300,
      "extra": {
        "feePayer": "<facilitator-fee-payer>",
        "receiverAuthorizer": "<server-refund-authorizer>",
        "withdrawDelay": 3600,
        "recentBlockhash": "<recent-blockhash>",
        "recentSlot": 341000000,
        "channelState": {
          "channelId": "<channel-pda>",
          "balance": "100000",
          "totalClaimed": "2000",
          "withdrawRequestedAt": 0,
          "chargedCumulativeAmount": "3000"
        },
        "voucherState": {
          "signedMaxClaimable": "3000",
          "expiresAt": 0,
          "signature": "<base58-ed25519-voucher-signature>"
        }
      }
    }
  ]
}
```

## 5. Phases

### Phase 1 - Open or Top Up

The client builds an `open` transaction for a new channel or a `top_up`
transaction for an existing channel. The client signs as channel `payer`; the
sponsor later signs as transaction fee payer. For `open`, the sponsor also signs
as program `rent_payer`, because the payment-channels program debits SOL from
that account to fund the channel PDA and escrow ATA rent.

The client MAY use `extra.recentBlockhash` and `extra.recentSlot` to avoid an
RPC round trip while constructing the transaction. If either hint is stale, the
client MUST fetch a fresh value and rebuild the transaction. The facilitator
MUST reject an expired transaction blockhash and an `openSlot` outside the
program's accepted window.

For `open`, the client MUST set `payee = extra.feePayer`, `authorized_signer =
channelConfig.payerAuthorizer`, `rent_payer = extra.feePayer`,
`mint = channelConfig.token`, `grace_period = channelConfig.withdrawDelay`,
`open_slot = channelConfig.openSlot`, and `deposit = payload.deposit.amount`.

The sponsor adds its signature to transaction bytes constructed by the client.
Before signing, it MUST statically validate the complete compiled message under
the acceptance policy below. Simulation or eventual onchain failure MUST NOT
replace these checks because either occurs only after the sponsor's signature
has authorized fee and, for `open`, rent expenditure. Smart-wallet wrappers are
not supported by this version of the scheme.

#### Client-supplied transaction acceptance policy

##### Message and signer rules

- The message MAY be legacy or version `0`, but it MUST NOT contain Address
  Lookup Table lookups. The canonical `open` and `top_up` forms fit in static
  account keys.
- The transaction fee payer MUST equal `extra.feePayer`.
- The complete required-signer set MUST equal the distinct addresses in
  `{ channelConfig.payer, extra.feePayer }`. No other signature may be required.
- The payer signature MUST be present and valid before the sponsor signs. The
  sponsor MUST add or replace only its own `extra.feePayer` signature slot.
- `channelConfig.payer` and `channelConfig.payerAuthorizer` MUST NOT equal
  `extra.feePayer`.
- For `open`, `extra.feePayer` MAY appear only in its canonical `rent_payer`
  and zero-share `payee` account positions. For `top_up`, it MUST NOT appear in
  the payment-channel instruction's account list. In either form it MUST NOT be
  invoked as a program or used by any other instruction.
- `channelConfig.receiverAuthorizer` MUST equal
  `extra.receiverAuthorizer`, and the facilitator MUST validate that key against
  its trusted binding for the authenticated server and `payTo`. It is not a
  required transaction signer or payment-channel instruction account.

##### Top-level instruction layout

The top-level instructions MUST consist only of the following ordered regions:

1. An optional Compute Budget prefix containing at most one
   `SetComputeUnitLimit` instruction and at most one `SetComputeUnitPrice`
   instruction. If both are present, the limit MUST precede the price.
2. Exactly one canonical payment-channels `open` or `top_up` instruction,
   matching the payload form selected by the decoded channel state.
3. An optional suffix of at most three Lighthouse instructions, each invoking
   `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`.

No other top-level instruction or program is allowed. In particular, a
top-level associated-token-account instruction, SPL Memo instruction, arbitrary
wallet program, second payment-channel instruction, or duplicate setup
instruction MUST cause rejection. The payment-channels `open` instruction
creates the escrow ATA internally.

When present, Compute Budget instructions:

- MUST invoke `ComputeBudget111111111111111111111111111111`;
- MUST use only discriminator `2` (`SetComputeUnitLimit`, exactly 5 data bytes)
  or discriminator `3` (`SetComputeUnitPrice`, exactly 9 data bytes);
- MUST set a compute-unit limit no greater than `400000`; and
- MUST set a compute-unit price no greater than `5000000` microlamports per
  compute unit.

Lighthouse instructions are allowed only for Phantom/Solflare assertions and
MUST NOT reference `extra.feePayer` as an account. A sponsor MAY apply stricter
local compute or priority-fee limits or reject all optional instructions, but it
MUST NOT admit instructions outside this allowlist or relax these maxima.

##### Canonical `open`

The `open` instruction MUST invoke the canonical payment-channels program, use
discriminator `1`, contain exactly these 14 accounts in order, and contain no
remaining accounts:

| Position | Account role | Required binding | Required privileges |
|---:|---|---|---|
| 0 | `payer` | `channelConfig.payer` | writable, signer |
| 1 | `rent_payer` | `extra.feePayer` | writable, signer |
| 2 | `payee` | `extra.feePayer` | read-only role |
| 3 | `mint` | `asset == channelConfig.token` | read-only |
| 4 | `authorized_signer` | `channelConfig.payerAuthorizer` | read-only role |
| 5 | `channel` | `voucher.channelId` | writable |
| 6 | `payer_token_account` | Canonical ATA for `payer`, `mint`, and the mint's token program | writable |
| 7 | `channel_token_account` | Canonical ATA for `channel`, `mint`, and the mint's token program | writable |
| 8 | `token_program` | Onchain owner of `mint`; supported SPL Token or Token-2022 program | read-only |
| 9 | `system_program` | `11111111111111111111111111111111` | read-only |
| 10 | `rent` | `SysvarRent111111111111111111111111111111111` | read-only |
| 11 | `associated_token_program` | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | read-only |
| 12 | `event_authority` | Canonical event-authority PDA for the payment-channels program | read-only |
| 13 | `self_program` | Canonical payment-channels program id | read-only |

The facilitator MUST fully decode the instruction data, reject truncated data or
trailing bytes, and enforce the exact salt, deposit, grace period, open slot,
single-recipient distribution, and PDA derivation specified in sections 4.1 and
4.2. It MUST confirm the payer has sufficient tokens for the deposit and the
sponsor has sufficient SOL for the transaction fee plus the channel PDA and
escrow ATA rent. The sponsor's signature authorizes no other SOL or token debit.

##### Canonical `top_up`

The `top_up` instruction MUST invoke the canonical payment-channels program, use
discriminator `3`, contain exactly these six accounts in order, and contain no
remaining accounts:

| Position | Account role | Required binding | Required privileges |
|---:|---|---|---|
| 0 | `payer` | `channelConfig.payer` | writable, signer |
| 1 | `channel` | `voucher.channelId` | writable |
| 2 | `payer_token_account` | Canonical ATA for `payer`, `mint`, and the mint's token program | writable |
| 3 | `channel_token_account` | Canonical escrow ATA for `channel`, `mint`, and the mint's token program | writable |
| 4 | `mint` | `asset == channelConfig.token` | read-only |
| 5 | `token_program` | Onchain owner of `mint`; supported SPL Token or Token-2022 program | read-only |

The facilitator MUST confirm the decoded amount equals
`payload.deposit.amount`; the channel is `Open`; and every immutable channel
field and the committed distribution match the payload and requirements. It
MUST confirm the payer has sufficient tokens. In this form `extra.feePayer`
authorizes only the bounded transaction fee and MUST NOT be an instruction
account, authority, source, or delegate.

Solana message compilation deduplicates equal keys and unions privileges.
Therefore `authorized_signer` MAY be effectively writable and a signer when
`payerAuthorizer == payer`, and `payee` is effectively writable and a signer
because `payee == rent_payer`. Those prescribed unions MUST NOT cause rejection;
no other privilege escalation is permitted.

After static validation, the facilitator MUST simulate the exact transaction,
reject a failed simulation, sign and broadcast it, and confirm its onchain
effects before returning success. An expired blockhash or out-of-window
`openSlot` MUST be rejected; the client must rebuild and re-sign with fresh
values.

After confirmation, the server records the channel in its `ChannelStore` and
accepts the voucher for the request under Phase 3.

### Phase 2 - Steady-State Request

Using the last authenticated `PAYMENT-RESPONSE`, the client sets
`maxClaimableAmount = channelState.chargedCumulativeAmount +
PaymentRequirements.amount`, signs a new `BatchVoucher`, and sends a `voucher`
payload. No onchain transaction is required in the request path. The server
verifies and stores the voucher under Phase 3, then serves immediately.
For a new channel, `chargedCumulativeAmount` starts at zero.

### Phase 3 - Voucher Acceptance (before serving)

The server is the sole owner of per-channel offchain state. A separate
facilitator, if used, remains stateless for ordinary voucher acceptance; it only
needs onchain state plus a voucher when it later settles.

The server MUST serialize all paid-request and refund processing per channel.
The server stores `chargedCumulativeAmount`, `signedMaxClaimable`, the latest
voucher signature and expiry, and a cached paid-response entry keyed by
`("access", channelId, maxClaimableAmount)`. For every paid-request voucher,
the server MUST:

1. Verify the Ed25519 signature over the 50-byte message using
   `channelConfig.payerAuthorizer` and confirm that key equals the channel
   `authorized_signer`.
2. Confirm `channelId` matches the PDA derived from `channelConfig` and the
   canonical payment-channels program id.
3. Confirm the channel exists, is `Open`, has `mint == channelConfig.token ==
   asset`, `payee == extra.feePayer`, `authorized_signer ==
   channelConfig.payerAuthorizer`, `rent_payer == extra.feePayer`,
   `grace_period == channelConfig.withdrawDelay == extra.withdrawDelay`,
   `open_slot == channelConfig.openSlot`, and a distribution to `payTo`
   matching section 4.1. Confirm `channelConfig.receiverAuthorizer ==
   extra.receiverAuthorizer`. Reject if `payer` or `payerAuthorizer` equals
   `feePayer`.
4. **Expiry, accounting for async settlement.** `expiresAt` is re-checked
   onchain when `settle` or `settle_and_seal` executes. Because redemption is
   delayed, the server MUST require either `expiresAt == 0` or
   `expiresAt >= now + withdrawDelay + a settlement buffer`. A voucher that
   could expire before redemption MUST be rejected.
5. Enforce the deposit cap: `maxClaimableAmount <= channel.deposit`.
6. Enforce replay protection and the per-request ceiling:
   - A previously accepted `("access", channelId, maxClaimableAmount)` is an
     idempotent retry. Return its cached response and do not execute the resource
     handler again.
   - Any other `maxClaimableAmount <= signedMaxClaimable` is stale and MUST be
     rejected.
   - A fresh voucher MUST have `maxClaimableAmount ==
     chargedCumulativeAmount + PaymentRequirements.amount`.
7. Execute the resource handler. Only after it succeeds, set `chargedAmount =
   PaymentRequirements.amount`, atomically add `chargedAmount` to
   `chargedCumulativeAmount`, store `signedMaxClaimable`, the voucher and the
   cached response, and return `PAYMENT-RESPONSE` with `transaction == ""`,
   `extra.commitmentId`, `extra.chargedAmount`, and `extra.channelState`. If the
   handler fails, state MUST remain unchanged so the client can retry.

On any failure, the server returns `402` without serving the resource. If the
server has local channel state and the client submits the wrong cumulative
amount, the server SHOULD return a corrective 402 with
`accepts[].extra.channelState` and `accepts[].extra.voucherState`, as shown in
section 4.6.

### Phase 4 - Batched Redemption (out of band)

The server or facilitator redeems accumulated vouchers asynchronously, outside
the request path:

- **Claim (`type: "claim"`).** For each channel, build an Ed25519 precompile
  instruction for the latest stored voucher followed by program `settle`. Pack
  no more than four channels into one transaction and do not silently drop
  channels from a full batch. Program `settle` advances onchain `settled` to
  the voucher's exact `maxClaimableAmount`.
- **Settle (`type: "settle"`).** Call program `distribute` to pay the newly
  claimed delta to `payTo` and advance `payout_watermark`. The channel remains
  open.
- **Refund (`type: "refund"`).** Verify the server's `RefundAuthorization`;
  apply the final client voucher when it advances `settled`; sign
  `settle_and_seal` as channel `payee`; and invoke sealed `distribute`.
  `distribute` pays any remaining settled delta, returns the full
  `deposit - settled` remainder to the payer, closes the escrow token account,
  and moves the channel to its cleanup state.
- **Rent cleanup.** If final `distribute` leaves the channel in `Distributed`,
  anyone can later call `reclaim` after the open-slot window to return remaining
  PDA rent to `rent_payer`.

The refund authorization is required for the x402 cooperative-refund flow. It
does not remove the facilitator's independent lifecycle authority to close an
abandoned channel at the current onchain watermark under its published rent
recovery policy.

The payer exits through the payment-channel program's forced-close path. The
server SHOULD claim with enough buffer before `withdrawDelay` can elapse after
the payer calls `request_close`. During the grace period, only the facilitator
as `payee` can apply a final voucher and seal cooperatively. After the grace
period, anyone can call `seal`; the payer can recover unspent deposit via
`withdraw_payer` or sealed `distribute`, and vouchers not yet claimed are
forfeited by the server.

### Phase 5 - Duplicate and Concurrent Operation Handling

The cumulative voucher and payment-channel state machine prevent duplicate
token movement, but HTTP retries still require explicit operation-level
idempotency:

- **Paid requests (`deposit` and `voucher`).** The server's per-channel lock and
  `("access", channelId, maxClaimableAmount)` cache are the authoritative replay
  defense. The same authorization MUST NOT execute the resource handler more
  than once, regardless of whether a retry changes from `deposit` to `voucher`.
- **Client-supplied deposit transactions.** The facilitator SHOULD maintain a
  short-lived in-flight cache keyed by the exact serialized transaction or its
  first signature. Concurrent `/settle` calls for the same transaction MUST be
  coalesced to one broadcast and one result or rejected with
  `duplicate_settlement`; they MUST NOT produce independent successful
  settlements. The entry MAY be evicted once the transaction's blockhash is no
  longer valid.
- **Claims.** Program `settle` requires a strictly increasing watermark, so the
  same claim cannot advance accounting twice. A facilitator MAY coalesce
  in-flight `(channelId, maxClaimableAmount)` claims to avoid a predictable
  second transaction failure; no durable duplicate cache is required.
- **Open-channel distributions.** `distribute` advances `payout_watermark` to
  `settled`; a repeat cannot pay the same delta again. A facilitator MAY
  coalesce concurrent distributions for the same channel and observed
  watermark.
- **Refunds.** A refund intentionally reuses the latest zero-charge voucher and
  therefore occupies a distinct `("refund", channelId,
  maxClaimableAmount)` namespace. The server and facilitator MUST cache the
  refund result at least through `refundAuthorization.validBefore`; a retry
  returns that result and never invokes a resource handler. Sealing and final
  distribution make the channel terminal, so the authorization cannot refund
  twice. Because the signature has no revocation nonce, the server MUST keep the
  channel refund-pending and reject later charges until the authorization
  expires or confirms.
- **Reclaim.** A channel can transition from `Distributed` to deallocated only
  once. Concurrent reclaim attempts require no additional replay mitigation;
  later attempts observe an absent account or invalid status.

## 6. Asynchronous Recovery and Channel Discovery

Channel discovery is onchain for lifecycle and rent recovery. A client can
discover channels whose `payer` equals its wallet. A facilitator can discover
every channel for which it fronted rent by querying `rent_payer` or, equivalently
in this scheme, `payee`. The server still requires durable offchain storage for
the accepted charge watermark, unclaimed voucher, request correlation, and
cached responses; those values cannot be reconstructed from channel accounts.

Implementations MAY retain a local lifecycle index, but a facilitator MUST be
able to rebuild the onchain portion after local state loss, at startup, and
periodically while it sponsors rent.

### 6.1 `getProgramAccounts` Discovery

Implementations MUST call `getProgramAccounts` against the canonical
payment-channels program for the selected network. This specification targets
the current 256-byte channel account layout, whose public-key offsets are:

| Channel field | Offset | Discovery use |
|---|---:|---|
| `payer` | 88 | Client deposit/channel recovery |
| `payee` | 120 | Facilitator lifecycle recovery; equals `feePayer` in this scheme |
| `authorized_signer` | 152 | Client voucher-authorizer recovery |
| `rent_payer` | 216 | Facilitator rent recovery; equals `feePayer` in this scheme |

For example, a facilitator discovers channels for which it paid rent using a
base58-encoded key in a `memcmp` filter:

```json
{
  "encoding": "base64",
  "commitment": "confirmed",
  "filters": [
    { "dataSize": 256 },
    { "memcmp": { "offset": 216, "bytes": "<facilitator-fee-payer>" } }
  ]
}
```

The client uses the same filter with offset `88` and its payer key. A
facilitator MAY additionally filter `payee` at offset `120`; because `payee ==
rent_payer == feePayer`, the two fields provide equivalent identities in valid
channels for this scheme.

Every returned account MUST be decoded with the supported payment-channels
codec. The implementation MUST reject an account whose owner, discriminator,
version, data length, or PDA does not match the selected program and decoded
channel fields. It MUST rederive the PDA from `payer`, `payee`, `mint`,
`authorized_signer`, `salt`, and `open_slot` before accepting the account.
Implementations MUST NOT reuse these byte offsets for an unsupported future
channel-account version.

### 6.2 Recovery Flow

Discovery and cleanup are asynchronous maintenance, not part of the paid HTTP
request path. After startup or local state loss, a rent sponsor MUST:

1. Query and decode matching channels, then upsert their addresses and statuses
   into a disposable local work queue.
2. Refetch and revalidate a channel immediately before acting. If another worker
   or user changes its status, refetch and reclassify it instead of treating the
   stale transition failure as permanent.
3. For an `Open` channel, allow the server a policy-defined notice or idle
   timeout to submit its latest voucher. The facilitator MAY then close at the
   current onchain watermark using `settle_and_seal` with `has_voucher = 0`,
   followed by `distribute` and, when necessary, `reclaim`.
4. For a `Closing` channel, schedule a recheck at the grace deadline. During the
   grace period, the facilitator MAY apply a final voucher supplied by the
   server; afterward the normal permissionless `seal` path applies.
5. For a `Sealed` channel, submit or relay `distribute`. For a `Distributed`
   channel, schedule `reclaim` after the open-slot gate; recovered SOL always
   returns to the recorded `rent_payer`.

Onchain recovery does not recreate an unclaimed voucher or the server's
`chargedCumulativeAmount`. If those records are lost, the server MUST NOT invent
a charge. The facilitator's conservative recovery action is to close at the
current onchain `settled` watermark and return the remainder to the payer.

## 7. Error Codes

Standard x402 codes apply. The facilitator reports verification failures in
`VerifyResponse.invalidReason` and settlement failures in
`SettlementResponse.errorReason`; a resource server returning a corrective
`PaymentRequired` uses `error`. Scheme-specific codes are:

- `invalid_batch_settlement_svm_payload_type` - payload `type` is not valid for
  the current verify or settle operation.
- `invalid_batch_settlement_svm_voucher_signature` - signature invalid or
  `channelConfig.payerAuthorizer` does not match channel `authorized_signer`.
- `invalid_batch_settlement_svm_channel_id_mismatch` - `channelId` does not
  match the canonical PDA derivation.
- `invalid_batch_settlement_svm_fee_payer_mismatch` - channel `payee` or
  `rent_payer` does not match `extra.feePayer`.
- `invalid_batch_settlement_svm_receiver_authorizer_mismatch` -
  `channelConfig.receiverAuthorizer` does not match
  `extra.receiverAuthorizer` or the facilitator's trusted server binding.
- `invalid_batch_settlement_svm_refund_authorization` - refund authorization is
  malformed, expired, signed by the wrong receiver authorizer, or does not bind
  the exact refund request.
- `invalid_batch_settlement_svm_refund_amount_unsupported` - refund payload
  contains an `amount`; this scheme supports full cooperative close only.
- `invalid_batch_settlement_svm_refund_state` - channel cannot be cooperatively
  closed, the zero-charge voucher does not equal server state, or its watermark
  is behind the channel's onchain `settled` value.
- `invalid_batch_settlement_svm_withdraw_delay_mismatch` - channel grace period
  does not match `extra.withdrawDelay`.
- `invalid_batch_settlement_svm_cumulative_amount_mismatch` - corrective 402:
  client's cumulative voucher does not match server state.
- `invalid_batch_settlement_svm_cumulative_exceeds_deposit` - voucher exceeds
  escrowed deposit.
- `invalid_batch_settlement_svm_expiry_window_too_short` - voucher may expire
  before redemption.
- `invalid_batch_settlement_svm_setup_transaction` - setup transaction fails the
  sponsor safety checks.
- `duplicate_settlement` - the same client-supplied setup transaction is already
  being settled.

## 8. Security Properties

- **Bounded authorization.** Onchain `settle` rejects vouchers above `deposit`
  and sets the exact cumulative maximum signed by the client.
- **No redirection.** `distribution_hash` is fixed at `open` and re-checked at
  `distribute`; the derived distribution sends settled funds to `payTo`.
- **Authenticated vouchers.** The wire `extra.feePayer` address is recorded as
  program `Channel.rent_payer` and zero-share `Channel.payee`. Program
  `Channel.authorized_signer` instead comes from wire
  `channelConfig.payerAuthorizer`, so the facilitator can close a channel but
  cannot advance `settled` without a client-signed voucher. The committed
  distribution prevents payout redirection.
- **Authenticated cooperative refunds.** The facilitator constructs and signs
  the close transaction only after verifying a domain-separated authorization
  from the receiver authorizer trusted for the server and `payTo`. The key
  supplied in an untrusted request is not itself a trust anchor. The client
  voucher independently binds the final cumulative spend.
- **Full-close refunds.** Cooperative refund first locks the final `settled`
  watermark, then returns exactly `deposit - settled` and closes the escrow.
  Partial refunds and channel reuse after refund are not supported.
- **Facilitator rent recovery.** Because the facilitator is channel `payee`, it
  can run `settle_and_seal` with `has_voucher = 0`, then `distribute` and
  `reclaim`, without client or server cooperation. Abandoned channels cannot
  permanently lock sponsored rent.
- **Facilitator early-close exposure.** Closing before the latest voucher is
  claimed freezes the onchain watermark and returns the remainder to the
  client. The server MUST bound its exposure by claiming promptly and SHOULD
  treat unclaimed voucher value as facilitator credit risk. During a
  client-initiated grace period, only the facilitator can apply the final
  voucher and seal cooperatively.
- **No replay / no rollback.** Server offchain watermark plus onchain
  `settled` monotonicity reject old vouchers. Paid-request equality is accepted
  only as an idempotent replay of a cached access response. Refunds use a
  separate operation namespace, a time-bounded server authorization, and a
  terminal onchain transition.
- **Bounded sponsor exposure.** Client-supplied transactions have a static
  instruction allowlist, exact signer and account layouts, no address lookup
  tables, bounded compute-unit limit and price, and transaction simulation.
  Outside the prescribed `open` rent roles, the facilitator signature
  authorizes network fees only.
- **Client escape hatch.** `withdrawDelay` is fixed at `open`; if the server
  does not settle, the payer can start forced close and recover unspent escrow
  after the grace period.
- **Time-bounded commitments.** Nonzero voucher `expiresAt` is checked both at
  server acceptance and onchain redemption. `expiresAt == 0` means no voucher
  expiry; in that case the channel's forced-close path bounds the commitment.
- **Fixed pricing.** Each fresh voucher increases the cumulative authorization
  by exactly `PaymentRequirements.amount`. The server trusts itself to redeem
  before voucher expiry or forced-close expiry.

## 9. Out of Scope

- A prescribed persistence backend, worker topology, or scheduling architecture
  for the required asynchronous maintenance.
- Smart-wallet-wrapped `open` or `top_up` transactions and simulation-based
  acceptance of arbitrary wallet programs.
- Delegated passkey or secp256r1 voucher signers.
