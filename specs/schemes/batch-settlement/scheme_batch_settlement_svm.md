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
- **Receiver authorizer**: lifecycle key advertised as
  `extra.receiverAuthorizer`; recorded as channel `payee`; signs cooperative
  close/refund operations. It MUST equal `extra.feePayer` so the rent sponsor
  can close abandoned channels and recover its rent.
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
the watermark and causes the unclaimed remainder to be refunded to the client.
The server MUST treat unclaimed voucher value as facilitator credit risk and
claim promptly.

## 2. Mapping the Core Requirements to SVM

| Requirement (generic spec) | SVM mechanism |
|---|---|
| One-time escrow deposit | Payment-channels `open` deposits escrow, records `withdrawDelay`, fixes `payee`, `authorized_signer`, `rent_payer`, and commits `distribution_hash`. |
| Per-request authorization | Ed25519 voucher signed by `payerAuthorizer` over `0x56 0x01 || channelId || maxClaimableAmount || expiresAt`. |
| Monotonic amount | Server-owned offchain watermark plus onchain `settled < maxClaimableAmount <= deposit` at redemption. |
| Batched redemption | One `settle` per channel, packed transaction-size permitting; `distribute` pays settled deltas. |
| Recipient binding | `distribution_hash` fixed at `open` sends funds to `payTo`; program re-checks it at `distribute`. |
| Refund of unused deposit | `settle_and_seal` + `distribute` for cooperative close; `request_close` / `seal` / `withdraw_payer` for payer-forced close. |

## 3. Payment-Channel Method

SVM `batch-settlement` defines a single payment method backed by the
payment-channels program. Because there is only one method, the wire format does
not include `extra.profiles` or `extra.assetTransferMethod`.

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
   refund the payer or close the escrow.
4. `settle_and_seal`: receiver-authorizer-signed cooperative close. It may apply
   a final voucher, locks the watermark, and moves the channel to `Sealed`.
5. Sealed `distribute`: pays any final settled delta, refunds
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
payouts and client refunds are completed by `distribute` and are not delayed by
the later `reclaim` of PDA rent.

If the client invokes `request_close`, only the `payee` can cooperatively
`settle_and_seal` during the grace period. The server therefore depends on the
facilitator to include its latest voucher before the deadline. After the grace
period, anyone can call `seal`; the payer can recover unspent escrow through
`withdraw_payer` or sealed `distribute`.

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
| `amount` | string | yes | Maximum per-request price in atomic units. The server MAY charge less and reports the actual charge in `SettlementResponse.extra.chargedAmount`. |
| `asset` | string | yes | Concrete SPL / Token-2022 mint pubkey, not a symbol. |
| `payTo` | string | yes | Base58 final payment receiver. Normally a server cold wallet. |
| `maxTimeoutSeconds` | number | yes | HTTP completion window. |
| `extra` | object | yes | See below. |

`extra`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `feePayer` | string | yes | Base58 sponsor key set as channel `rent_payer` and zero-share `payee`. Co-signs setup/top-up transactions as transaction fee payer and signs cooperative close/refund transactions. |
| `receiverAuthorizer` | string | yes | Base58 lifecycle-authority key set as channel `payee`. MUST equal `feePayer`, so rent recovery never depends on a separate server key. |
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
    "receiverAuthorizer": "<facilitator-fee-payer>",
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
| `channelConfig.payer` | `Channel.payer` |
| `channelConfig.payerAuthorizer` | `Channel.authorized_signer` |
| `channelConfig.receiver` | Sole `DistributionEntry.recipient` with `bps = 10000`; the `Channel.payee` implicit remainder is always zero |
| `channelConfig.receiverAuthorizer` | `Channel.payee` |
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
| `payer` | string | Client wallet and channel payer. MUST NOT equal `receiverAuthorizer`, because the program requires distinct payer and payee accounts. |
| `payerAuthorizer` | string | Client-controlled Ed25519 voucher signer; maps to channel `authorized_signer`. MAY equal `payer` but MUST NOT equal `receiverAuthorizer` / `feePayer`. |
| `receiver` | string | MUST equal `payTo`. |
| `receiverAuthorizer` | string | MUST equal `extra.receiverAuthorizer == extra.feePayer`; maps to channel `payee`. |
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
    channelConfig.receiverAuthorizer,
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
- `payee == channelConfig.receiverAuthorizer`
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

`ChannelState`:

| Field | Type | Notes |
|---|---|---|
| `channelId` | string | Channel PDA (base58). |
| `balance` | string | Current `Channel.deposit` ceiling in atomic units. |
| `totalClaimed` | string | Current onchain `Channel.settled` watermark. |
| `withdrawRequestedAt` | number | `Channel.closure_started_at`, or `0` when no forced close is pending. |
| `chargedCumulativeAmount` | string | Server-owned offchain cumulative actual charge. Present only when the response is authored by the server. |

### 4.3 Client `PaymentPayload` Variants

The client payload is a tagged union on `payload.type`. `/verify` accepts all
three variants. `/settle` accepts `deposit` and `voucher` directly; the server
enriches `refund` before settlement as specified in section 4.5.

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
      "receiverAuthorizer": "<facilitator-fee-payer>",
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
      "receiverAuthorizer": "<facilitator-fee-payer>",
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
      "receiverAuthorizer": "<facilitator-fee-payer>",
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
      "receiverAuthorizer": "<facilitator-fee-payer>",
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

**`refund`** requests cooperative closure and a full refund of the unspent
escrow. The application resource handler is bypassed. Its voucher is
zero-charge: `maxClaimableAmount` MUST equal the server's current
`chargedCumulativeAmount`.

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"refund"` |
| `channelConfig` | `ChannelConfig` | Full channel configuration. |
| `voucher` | `BatchVoucher` | Zero-charge voucher at the server's current cumulative charge. |

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
      "receiverAuthorizer": "<facilitator-fee-payer>",
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
      "receiverAuthorizer": "<facilitator-fee-payer>",
      "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "withdrawDelay": 3600,
      "salt": "42",
      "openSlot": 341000000
    },
    "voucher": {
      "channelId": "<channel-pda>",
      "maxClaimableAmount": "3200",
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
| `extra.chargedAmount` | string | no | Actual per-request charge committed offchain. |
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
    "chargedAmount": "700",
    "channelState": {
      "channelId": "<channel-pda>",
      "balance": "100000",
      "totalClaimed": "3200",
      "withdrawRequestedAt": 0,
      "chargedCumulativeAmount": "4700"
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

`paymentPayload.payload` MUST be one of the client-authored `deposit`,
`voucher`, or `refund` variants in section 4.3. The facilitator validates the
wire fields, voucher signature, derived channel PDA, onchain channel state, and,
for `deposit`, the client-signed transaction.

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
| `refund` | Client, then server-enriched | Cooperatively close and return unspent escrow to the payer. | `settle_and_seal` + `distribute` |

The examples in this subsection show the inner `paymentPayload.payload`; the
caller MUST wrap each one in the standard request envelope defined above.

The `deposit` and `voucher` settle payloads are the client variants from
section 4.3. The server-authored or server-enriched variants are:

| Payload | Field | Type | Notes |
|---|---|---|---|
| Refund | `type` | string | `"refund"` |
| Refund | `channelConfig` | `ChannelConfig` | Client-provided channel configuration. |
| Refund | `voucher` | `BatchVoucher` | Client's zero-charge voucher. |
| Refund | `transaction` | string | Base64 transaction containing `settle_and_seal` and sealed `distribute`, prepared for `feePayer` to sign as transaction fee payer and channel `payee`. |
| Claim | `type` | string | `"claim"` |
| Claim | `claims` | array | One or more voucher claims. |
| Claim | `claims[].voucher.channelConfig` | `ChannelConfig` | Full channel configuration. |
| Claim | `claims[].voucher.channelId` | string | Channel PDA. |
| Claim | `claims[].voucher.maxClaimableAmount` | string | Cumulative amount for program `settle`. |
| Claim | `claims[].voucher.expiresAt` | number | Voucher expiry. |
| Claim | `claims[].signature` | string | Base58 Ed25519 voucher signature. |
| Settle | `type` | string | `"settle"` |
| Settle | `channels` | array | One or more channels to distribute. |
| Settle | `channels[].channelId` | string | Channel PDA. |
| Settle | `channels[].channelConfig` | `ChannelConfig` | Full configuration used to derive accounts, validate the channel, and reconstruct the distribution. |

The server forwards a client-authored `deposit` unchanged. It MAY settle
`voucher` locally by storing the commitment and producing the response in
section 4.4. Before forwarding `refund`, the server MUST build the cooperative
close transaction and add `transaction`. The facilitator MUST validate the
complete transaction, then sign as both transaction `feePayer` and channel
`payee` before broadcasting it:

```json
{
  "type": "refund",
  "channelConfig": {
    "payer": "<client-wallet>",
    "payerAuthorizer": "<client-voucher-signer>",
    "receiver": "<server-receiver>",
    "receiverAuthorizer": "<facilitator-fee-payer>",
    "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "withdrawDelay": 3600,
    "salt": "42",
    "openSlot": 341000000
  },
  "voucher": {
    "channelId": "<channel-pda>",
    "maxClaimableAmount": "3200",
    "expiresAt": 0,
    "signature": "<base58-ed25519-zero-charge-voucher-signature>"
  },
  "transaction": "<base64-settle-and-seal-and-distribute-transaction-awaiting-facilitator-signature>"
}
```

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
          "receiverAuthorizer": "<facilitator-fee-payer>",
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
          "receiverAuthorizer": "<facilitator-fee-payer>",
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

The facilitator MUST process every `claims[]` entry or fail the request; it
MUST NOT silently truncate a batch. For each claim it emits an Ed25519
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
        "receiverAuthorizer": "<facilitator-fee-payer>",
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
        "receiverAuthorizer": "<facilitator-fee-payer>",
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
    "channelState": {
      "channelId": "<channel-pda>",
      "balance": "100000",
      "totalClaimed": "3200",
      "withdrawRequestedAt": 0
    }
  }
}
```

Refund (`amount` is the amount returned to the payer):

```json
{
  "success": true,
  "transaction": "<base58-transaction-signature>",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "<client-wallet>",
  "amount": "96800",
  "extra": {
    "channelState": {
      "channelId": "<channel-pda>",
      "balance": "0",
      "totalClaimed": "3200",
      "withdrawRequestedAt": 0
    }
  }
}
```

#### `GET /supported`

The facilitator advertises its SVM transaction fee payer. The server MUST copy
this value into both `PaymentRequirements.extra.feePayer` and
`PaymentRequirements.extra.receiverAuthorizer`:

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
        "receiverAuthorizer": "<facilitator-fee-payer>",
        "withdrawDelay": 3600,
        "recentBlockhash": "<recent-blockhash>",
        "recentSlot": 341000000,
        "channelState": {
          "channelId": "<channel-pda>",
          "balance": "100000",
          "totalClaimed": "500",
          "withdrawRequestedAt": 0,
          "chargedCumulativeAmount": "3200"
        },
        "voucherState": {
          "signedMaxClaimable": "3200",
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

For `open`, the client MUST require `extra.receiverAuthorizer ==
extra.feePayer` and set `payee = extra.feePayer`,
`authorized_signer = channelConfig.payerAuthorizer`, `rent_payer =
extra.feePayer`, `mint = channelConfig.token`, `grace_period =
channelConfig.withdrawDelay`, `open_slot = channelConfig.openSlot`, and
`deposit = payload.deposit.amount`.

The sponsor MUST validate the full compiled setup transaction before co-signing,
not only the payment-channel instruction. It MUST resolve address lookup tables,
allow only the expected instruction set (payment-channel `open` or `top_up`,
optional associated-token-account creation required by `open`, and bounded
ComputeBudget instructions), confirm the canonical program id and instruction
arguments, and confirm `feePayer` is not used as an authority, source, or
sender of token value. It MAY appear only in its prescribed transaction-fee,
`rent_payer`, and zero-share `payee` roles, and MAY be writable only for fees
and the intended channel/escrow rent. Anything else MUST be rejected before
broadcasting.

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

The server stores `chargedCumulativeAmount`, `signedMaxClaimable`, the latest
voucher signature and expiry, and a cached response keyed by
`(channelId, maxClaimableAmount)`. For every voucher, the server MUST:

1. Verify the Ed25519 signature over the 50-byte message using
   `channelConfig.payerAuthorizer` and confirm that key equals the channel
   `authorized_signer`.
2. Confirm `channelId` matches the PDA derived from `channelConfig` and the
   canonical payment-channels program id.
3. Confirm the channel exists, is `Open`, has `mint == channelConfig.token ==
   asset`, `payee == channelConfig.receiverAuthorizer ==
   extra.receiverAuthorizer == extra.feePayer`, `authorized_signer ==
   channelConfig.payerAuthorizer`, `rent_payer == extra.feePayer`,
   `grace_period == channelConfig.withdrawDelay == extra.withdrawDelay`,
   `open_slot == channelConfig.openSlot`, and a distribution to `payTo`
   matching section 4.1. Reject if `payer` or `payerAuthorizer` equals
   `feePayer`.
4. **Expiry, accounting for async settlement.** `expiresAt` is re-checked
   onchain when `settle` or `settle_and_seal` executes. Because redemption is
   delayed, the server MUST require either `expiresAt == 0` or
   `expiresAt >= now + withdrawDelay + a settlement buffer`. A voucher that
   could expire before redemption MUST be rejected.
5. Enforce the deposit cap: `maxClaimableAmount <= channel.deposit`.
6. Enforce replay protection and the per-request ceiling:
   - A previously accepted `(channelId, maxClaimableAmount)` is an idempotent
     retry. Return its cached response and do not execute the resource handler
     again.
   - Any other `maxClaimableAmount <= signedMaxClaimable` is stale and MUST be
     rejected.
   - A fresh voucher MUST have `maxClaimableAmount ==
     chargedCumulativeAmount + PaymentRequirements.amount`.
7. Execute the resource handler and determine `chargedAmount`, which MUST be
   greater than zero and less than or equal to `PaymentRequirements.amount`.
   Only after the handler succeeds, atomically add `chargedAmount` to
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
  as many channels into one transaction as the transaction size permits; do not
  silently drop channels from a full batch. Program `settle` advances onchain
  `settled` to the voucher's exact `maxClaimableAmount`.
- **Settle (`type: "settle"`).** Call program `distribute` to pay the newly
  claimed delta to `payTo` and advance `payout_watermark`. The channel remains
  open.
- **Cooperative close/refund.** For a `refund` payload or server-initiated
  close, the facilitator signs `settle_and_seal` as `payee`, applying the final
  voucher when it advances the watermark (or using `has_voucher = 0` when no
  claim is needed). `distribute` then pays any remaining settled delta, refunds
  `deposit - settled` to the payer, closes the escrow token account, and moves
  the channel to its cleanup state.
- **Rent cleanup.** If final `distribute` leaves the channel in `Distributed`,
  anyone can later call `reclaim` after the open-slot window to return remaining
  PDA rent to `rent_payer`.

The server SHOULD claim with enough buffer before `withdrawDelay` can elapse
after a client starts forced close. If the payer calls `request_close`, only the
facilitator as `payee` can `settle_and_seal` during the grace period, using a
final voucher supplied by the server. After the grace period, anyone can call
`seal`; the payer can then recover unspent deposit via `withdraw_payer` or the
sealed `distribute` refund branch, and vouchers not yet claimed are forfeited by
the server.

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
- `invalid_batch_settlement_svm_receiver_authorizer_mismatch` - channel `payee`
  does not match `extra.receiverAuthorizer`, or `receiverAuthorizer` does not
  equal `feePayer`.
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

## 8. Security Properties

- **Bounded authorization.** Onchain `settle` rejects vouchers above `deposit`
  and sets the exact cumulative maximum signed by the client.
- **No redirection.** `distribution_hash` is fixed at `open` and re-checked at
  `distribute`; the derived distribution sends settled funds to `payTo`.
- **Authenticated claims.** The wire `extra.feePayer` address is recorded as
  program `Channel.rent_payer` and zero-share `Channel.payee`. Program
  `Channel.authorized_signer` instead comes from wire
  `channelConfig.payerAuthorizer`, so the facilitator can close a channel but
  cannot advance `settled` without a client-signed voucher. The committed
  distribution prevents payout redirection.
- **Facilitator rent recovery.** Because the facilitator is channel `payee`, it
  can run `settle_and_seal` with `has_voucher = 0`, then `distribute` and
  `reclaim`, without client or server cooperation. Abandoned channels cannot
  permanently lock sponsored rent.
- **Facilitator early-close exposure.** Closing before the latest voucher is
  claimed freezes the onchain watermark and refunds the remainder to the
  client. The server MUST bound its exposure by claiming promptly and SHOULD
  treat unclaimed voucher value as facilitator credit risk. During a
  client-initiated grace period, only the facilitator can apply the final
  voucher and seal cooperatively.
- **No replay / no rollback.** Server offchain watermark plus onchain
  `settled` monotonicity reject old vouchers. Equality is accepted only as an
  idempotent replay of a cached response.
- **Client escape hatch.** `withdrawDelay` is fixed at `open`; if the server
  does not settle, the payer can start forced close and recover unspent escrow
  after the grace period.
- **Time-bounded commitments.** Nonzero voucher `expiresAt` is checked both at
  server acceptance and onchain redemption. `expiresAt == 0` means no voucher
  expiry; in that case the channel's forced-close path bounds the commitment.
- **Metering trust.** Each voucher authorizes at most the advertised
  `PaymentRequirements.amount` above the previously reported actual cumulative
  charge. The client trusts the server to claim no more than the reported
  `chargedCumulativeAmount`; the server trusts itself to redeem before voucher
  expiry or forced-close expiry.

## 9. Out of Scope

- A prescribed persistence backend, worker topology, or scheduling architecture
  for the required asynchronous maintenance.
- Delegated passkey or secp256r1 voucher signers.
