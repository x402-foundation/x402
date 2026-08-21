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
- **Receiver authorizer**: optional server-controlled Ed25519 key advertised as
  `extra.receiverAuthorizer`. It authenticates server-approved cooperative
  close requests to the facilitator. It is an offchain x402 role and is not
  recorded in the payment-channel account. It is not required for unilateral
  refund or rent recovery.
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
| Recovery of unused deposit | Client-signed `request_close`, followed after the grace period by permissionless `seal` + `distribute`; an optional server authorization can replace this with immediate cooperative `settle_and_seal` + `distribute`. |

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

For an x402 immediate cooperative close, the facilitator MUST authenticate the
resource server and bind that identity to `payTo` and the channel. It MAY do so
with a valid `CloseAuthorization` signed by `extra.receiverAuthorizer`, or with
facilitator-specific out-of-band authentication established no later than the
channel's first deposit. Neither mechanism replaces the facilitator's onchain
`payee` signature or the client's voucher signature. The facilitator MUST NOT
trust a receiver-authorizer key or claimed server identity merely because it
appears in `PaymentRequirements` or a settlement request. Any trusted binding
is fixed for the channel lifetime; changing it requires closing the channel and
opening a new one.

For out-of-band authentication, the facilitator MUST record the authenticated
server principal that submitted or sponsored the first deposit together with
the derived `channelId` and verified `payTo`. It MUST require that same principal
on an immediate cooperative-close request. This mechanism is facilitator-local;
the interoperable wire fallback remains payer-signed forced close.

The facilitator MUST accept a refund without a receiver authorizer. In that
case, the client supplies a payer-signed `request_close` transaction, the
facilitator adds its fee-payer signature and broadcasts it, and the facilitator
or another permissionless crank finalizes the channel after the grace period.
The facilitator MAY use the immediate cooperative path when it receives the
server's latest valid voucher through an authenticated request under that
binding. Out-of-band authentication is an optimization and is not required for
interoperability.

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
| `paymentFlow` | string | no | When present, MUST be `"authorization"`. The scheme resolves to the protocol-default `authorization` flow: read-only verification runs before the resource handler, and `/settle` commits the voucher — and broadcasts any `deposit` transaction — after it. |
| `feePayer` | string | yes | Base58 sponsor key set as channel `rent_payer` and zero-share `payee`. Co-signs setup/top-up transactions as transaction fee payer and signs channel lifecycle transactions. |
| `receiverAuthorizer` | string | no | Base58 server-controlled Ed25519 key that authenticates an optional immediate cooperative close to the facilitator. It is not a payment-channel account field. |
| `withdrawDelay` | number | yes | Forced-close grace period in seconds. MUST be an integer from `900` through `2592000` (15 minutes through 30 days), MUST be `>= maxTimeoutSeconds`, and MUST be encoded exactly as the program `grace_period`. The payment-channels program accepts any positive `grace_period`; this range is an x402 conformance bound, so verifying facilitators MUST enforce it and reject out-of-range requirements. |
| `tokenProgram` | string | yes | SPL Token (`Tokenkeg...`) or Token-2022 (`TokenzQ...`) program that owns `asset`. The client and facilitator MUST verify it against the onchain mint owner. |
| `memo` | string | no | Seller-defined UTF-8 payment reference for the setup transaction's Memo instruction. Maximum 256 bytes. |
| `recentBlockhash` | string | no | Pre-fetched blockhash the client MAY use to build an `open` or `top_up` transaction without an RPC round trip. The client MUST refresh it if it is no longer valid. |
| `recentSlot` | number | no | Recent slot the client MAY use as `channelConfig.openSlot` when it does not fetch its own slot. The program still enforces the open-slot window. |
| `channelState` | object | no | Corrective-only server channel snapshot for cumulative amount resynchronization. |
| `voucherState` | object | no | Corrective-only signed voucher proof for cumulative amount resynchronization. |

`recentBlockhash` and `recentSlot` are
transaction-construction hints only. They are not persistent channel
configuration and are not included in the voucher message. A client MAY ignore
the hints and obtain fresher values from an RPC.

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
    "receiverAuthorizer": "<server-close-authorizer>",
    "withdrawDelay": 3600,
    "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "memo": "invoice-123",
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
| `PaymentRequirements.extra.receiverAuthorizer` | No program field; optional trusted server key for offchain close authorization |
| `PaymentRequirements.extra.tokenProgram` | `open.token_program` / `top_up.token_program`; MUST equal the onchain owner of `Channel.mint` |
| `channelConfig.payer` | `Channel.payer` |
| `channelConfig.payerAuthorizer` | `Channel.authorized_signer` |
| `channelConfig.receiver` | Sole `DistributionEntry.recipient` with `bps = 10000`; the `Channel.payee` implicit remainder is always zero |
| `channelConfig.receiverAuthorizer` | No program field; when supplied, MUST equal `PaymentRequirements.extra.receiverAuthorizer` |
| `channelConfig.token` | `Channel.mint` |
| `channelConfig.withdrawDelay` | `Channel.grace_period` |
| `channelConfig.salt` | `Channel.salt` |
| `channelConfig.openSlot` | `Channel.open_slot` |
| `voucher.channelId` | `VoucherArgs.channel_id` |
| `voucher.maxClaimableAmount` | `VoucherArgs.cumulative_amount` |
| `voucher.expiresAt` | `VoucherArgs.expires_at`; MUST be `0` in this scheme |
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
| `receiverAuthorizer` | string | Optional. When supplied, MUST equal `extra.receiverAuthorizer`. This key authenticates cooperative close requests offchain and is not a channel PDA seed or program account field. |
| `token` | string | MUST equal `asset`; maps to channel `mint`. |
| `withdrawDelay` | number | MUST equal `extra.withdrawDelay`; maps to channel `grace_period`. |
| `salt` | string | Decimal `u64` channel salt. |
| `openSlot` | number | `u64` slot encoded in `open` and used as a channel PDA seed. |

The client and facilitator MUST confirm `extra.tokenProgram` equals the onchain
owner of `channelConfig.token`; neither role may trust the server-provided value
without that check.

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
| `expiresAt` | number | MUST be `0` (no voucher expiry). The field stays in the signed message for program compatibility; the forced-close grace period alone bounds the redemption window. |
| `signature` | string | Base58 Ed25519 signature by `channelConfig.payerAuthorizer`. |

The signed message is exactly:

```text
0x56 0x01 || channelId || u64(maxClaimableAmount).le || i64(expiresAt).le
```

This is the payment-channels program voucher layout (`VOUCHER_MAGIC`,
`channel_id`, `cumulative_amount`, `expires_at`), 50 bytes total.

`CloseAuthorization`:

| Field | Type | Notes |
|---|---|---|
| `validBefore` | number | Integer Unix seconds. The server MUST set it no later than its current time plus `maxTimeoutSeconds`; the facilitator MUST require `now < validBefore <= now + maxTimeoutSeconds`. |
| `signature` | string | Base58 Ed25519 signature by the receiver authorizer bound to the server through `extra.receiverAuthorizer` or a trusted out-of-band registration. |

The receiver authorizer signs the SHA-256 digest of this exact byte sequence:

```text
UTF8("x402:batch-settlement:svm:close:v1") || 0x00 ||
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
three variants. `/settle` accepts `deposit` and `refund` directly. The server
MAY enrich `refund` with its latest accepted voucher and, when needed, a
`CloseAuthorization` before forwarding it as specified in section 4.5. A
`voucher` is accepted offchain by the server.

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
      "receiverAuthorizer": "<server-close-authorizer>",
      "withdrawDelay": 3600,
      "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
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
      "receiverAuthorizer": "<server-close-authorizer>",
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
      "receiverAuthorizer": "<server-close-authorizer>",
      "withdrawDelay": 3600,
      "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
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
      "receiverAuthorizer": "<server-close-authorizer>",
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

**`refund`** is retained as the cross-binding wire discriminator for a channel
close. The client MUST provide a payer-signed `request_close` transaction. This
is a payment operation, not a paid resource request, so the application
resource handler MUST be bypassed. The request MUST NOT contain an `amount`:
the payment-channel program supports only the return of all unused escrow, and
the closed channel cannot be reused. A client MAY also provide a voucher as a
hint for an immediate cooperative close, but the facilitator MUST NOT apply it
unless an authenticated server confirms it is the latest accepted voucher.

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"refund"` |
| `channelConfig` | `ChannelConfig` | Full channel configuration. |
| `transaction` | string | Base64 client-signed `request_close` transaction. The transaction MUST set `extra.feePayer` as its Solana fee payer so the facilitator can co-sign and broadcast it. |
| `voucher` | `BatchVoucher` | Optional latest accepted voucher. It is used only when supplied or confirmed by an authenticated server for immediate cooperative close. |

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
      "withdrawDelay": 3600,
      "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
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
      "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "withdrawDelay": 3600,
      "salt": "42",
      "openSlot": 341000000
    },
    "transaction": "<base64-client-signed-request-close-transaction>"
  }
}
```

### 4.4 `SettlementResponse` (in `PAYMENT-RESPONSE`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `success` | boolean | yes | Whether acceptance or settlement succeeded. |
| `errorReason` | string | no | Omitted on success. |
| `payer` | string | no | Channel `payer`. |
| `transaction` | string | yes | Onchain signature for deposit/top-up/refund-initiation/cooperative-close/claim/settle operations; empty string for offchain voucher acceptance. |
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
`deposit` and `refund`, the client-signed transaction. For `refund`, it
additionally confirms that the transaction is an exact payer-authorized
`request_close` for the derived channel, the channel is `Open` or is still
within its `Closing` grace period, and the payer's canonical return ATA is
healthy. If a voucher is present, the facilitator MAY validate it during
verification, but MUST only apply it after authenticating the server through a
trusted request context or a valid `CloseAuthorization`.

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
| `refund` | Client, optionally server-enriched | Start a payer-forced close; after the grace period, finalize and return all unused escrow, or use an authenticated immediate cooperative close. | `request_close` then `seal` + sealed `distribute`, or `settle_and_seal` + sealed `distribute` |

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
| Claim | `claims[].voucher.expiresAt` | number | MUST be `0`. |
| Claim | `claims[].signature` | string | Base58 Ed25519 voucher signature. |
| Settle | `type` | string | `"settle"` |
| Settle | `channels` | array | One or more channels to distribute. |
| Settle | `channels[].channelId` | string | Channel PDA. |
| Settle | `channels[].channelConfig` | `ChannelConfig` | Full configuration used to derive accounts, validate the channel, and reconstruct the distribution. |
| Refund | `type` | string | `"refund"` |
| Refund | `channelConfig` | `ChannelConfig` | Client-provided channel configuration. |
| Refund | `transaction` | string | Client-signed `request_close` transaction forwarded to the facilitator. |
| Immediate cooperative close | `voucher` | `BatchVoucher` | Latest accepted client voucher supplied or confirmed by the authenticated server. |
| Immediate cooperative close | `closeAuthorization` | `CloseAuthorization` | Optional server signature authorizing the immediate cooperative close. Omit when trusted out-of-band request authentication supplies the server binding. |

The server forwards a client-authored `deposit` unchanged. It MAY settle
`voucher` locally by storing the commitment and producing the response in
section 4.4.

For `refund`, the server MUST serialize processing with every paid request and
other close for the channel, bypass the resource handler, and forward the
client-signed `request_close` transaction after successful facilitator
verification. For the unilateral path, once the request-close transaction
confirms, the server MUST reject new paid requests for the channel. The server
MAY instead provide the latest voucher through a facilitator-authenticated
request for an immediate cooperative close. When the facilitator does not
authenticate the request out of band, the server MUST also create a fresh
`CloseAuthorization` with `extra.receiverAuthorizer`:

```json
{
  "type": "refund",
  "channelConfig": {
    "payer": "<client-wallet>",
    "payerAuthorizer": "<client-voucher-signer>",
    "receiver": "<server-receiver>",
    "receiverAuthorizer": "<server-close-authorizer>",
    "token": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "withdrawDelay": 3600,
    "salt": "42",
    "openSlot": 341000000
  },
  "transaction": "<base64-client-signed-request-close-transaction>",
  "voucher": {
    "channelId": "<channel-pda>",
    "maxClaimableAmount": "5000",
    "expiresAt": 0,
    "signature": "<base58-ed25519-latest-voucher-signature>"
  },
  "closeAuthorization": {
    "validBefore": 1785341100,
    "signature": "<base58-server-close-authorization-signature>"
  }
}
```

If the server supplied a cooperative voucher, the facilitator MUST authenticate
the server either from its trusted request context or by validating
`closeAuthorization` against the trusted receiver-authorizer binding. It MUST
reject a supplied `CloseAuthorization` at or after `validBefore`, and MUST
validate the voucher against the channel. When
`Channel.settled < voucher.maxClaimableAmount`, it emits the
voucher's Ed25519 precompile instruction immediately followed by
`settle_and_seal` with `has_voucher = 1`. When the values are equal, it invokes
`settle_and_seal` with `has_voucher = 0`; submitting an equal voucher onchain
would fail the program's strict monotonicity check. Any other relationship
MUST be rejected. It then invokes sealed `distribute` in the same transaction,
verifies the confirmed onchain result, and returns the full amount
`deposit - settled` transferred to the payer.

Without a valid cooperative authorization, the facilitator MUST validate and
co-sign the client's `request_close` transaction with `extra.feePayer`,
broadcast it, and confirm that the channel entered `Closing`. It MUST NOT
fabricate or apply a final voucher. After `Channel.closure_started_at +
Channel.grace_period`, the facilitator MUST schedule and attempt `seal` followed
by sealed `distribute`, returning `deposit - settled` to the payer. If another
permissionless crank completes either transition first, the facilitator MUST
treat the observed terminal state as success. Eligible PDA rent is recovered
by the same worker through `reclaim`; none of these asynchronous transactions
is part of the initial HTTP refund response.

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
          "receiverAuthorizer": "<server-close-authorizer>",
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
          "receiverAuthorizer": "<server-close-authorizer>",
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
        "receiverAuthorizer": "<server-close-authorizer>",
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
        "receiverAuthorizer": "<server-close-authorizer>",
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

Refund initiation (`amount` is empty because the grace period may still be
running):

```json
{
  "success": true,
  "transaction": "<base58-request-close-transaction-signature>",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "<client-wallet>",
  "amount": "",
  "extra": {
    "channelState": {
      "channelId": "<channel-pda>",
      "balance": "100000",
      "totalClaimed": "5000",
      "withdrawRequestedAt": 1785341100,
      "chargedCumulativeAmount": "5000"
    }
  }
}
```

The facilitator MUST return the request-close signature after it confirms the
channel entered `Closing`; it MUST NOT claim that the refund amount has moved
until a later `seal`/`distribute` cleanup confirms it. For this unilateral path,
the server MUST mark the channel close-pending and reject further paid
requests. A later session MUST open a new channel with a new `openSlot`.

When the immediate cooperative shortcut is used, the response instead contains
the final cooperative-close signature and `amount = deposit - settled`; the
server marks the channel closed after confirmation.

#### `GET /supported`

The facilitator advertises its SVM transaction fee payer. The server MUST copy
that value into `PaymentRequirements.extra.feePayer`, then set
`extra.tokenProgram` from the selected asset's verified mint owner. The scheme
resolves to the protocol-default `authorization` payment flow, so
`extra.paymentFlow` is normally omitted; when either party emits it, the value
MUST be `"authorization"`. The server
MAY also set `extra.receiverAuthorizer` to a key covered by a trusted
facilitator registration when it wants signed immediate cooperative closes.
The receiver authorizer is server-owned and is therefore not advertised by the
facilitator:

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
        "receiverAuthorizer": "<server-close-authorizer>",
        "withdrawDelay": 3600,
        "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
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

Before adopting the corrective state, the client MUST verify
`voucherState.signature` against its own `payerAuthorizer` key as an Ed25519
signature over the 50-byte voucher message of section 4.2, reconstructed from
the derived `channelId`, `maxClaimableAmount = voucherState.signedMaxClaimable`,
and `expiresAt = voucherState.expiresAt`. The client MUST reject the snapshot
when the signature does not verify or when
`channelState.chargedCumulativeAmount` exceeds `voucherState.signedMaxClaimable`.
Only after these checks does the client adopt `chargedCumulativeAmount` as its
new cumulative base and retry. When the server has no accepted voucher for the
channel, it omits `voucherState` and the client resynchronizes from onchain
state instead.

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
- When either receiver-authorizer field is supplied, the two values MUST be
  equal, and the facilitator MUST validate that key against its trusted binding
  for the authenticated server and `payTo`. It is not a required transaction
  signer or payment-channel instruction account.

##### Top-level instruction layout

The top-level instructions MUST consist only of the following ordered regions:

1. An optional Compute Budget prefix containing at most one
   `SetComputeUnitLimit` instruction and at most one `SetComputeUnitPrice`
   instruction. If both are present, the limit MUST precede the price.
2. Exactly one canonical payment-channels `open` or `top_up` instruction,
   matching the payload form selected by the decoded channel state.
3. A suffix containing exactly one SPL Memo instruction
   (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) and at most three Lighthouse
   instructions (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`). The Memo data
   MUST be `extra.memo` as UTF-8 when supplied, or otherwise a random nonce of
   at least 16 bytes encoded as hexadecimal text.

No other top-level instruction or program is allowed. In particular, a
top-level associated-token-account instruction, arbitrary wallet program,
second payment-channel instruction, or duplicate setup instruction MUST cause
rejection. The payment-channels `open` instruction creates the escrow ATA
internally.

When present, Compute Budget instructions:

- MUST invoke `ComputeBudget111111111111111111111111111111`;
- MUST use only discriminator `2` (`SetComputeUnitLimit`, exactly 5 data bytes)
  or discriminator `3` (`SetComputeUnitPrice`, exactly 9 data bytes);
- MUST set a compute-unit limit no greater than `400000`; and
- MUST set a compute-unit price no greater than `5000000` microlamports per
  compute unit.

A sponsor MAY apply stricter local compute-unit, priority-fee, or
required-signature caps, but MUST NOT relax the absolute maxima above.
Lighthouse and Memo instructions are allowed only in the final suffix and
MUST NOT reference `extra.feePayer` as an account or as the invoked program. If
`extra.memo` is present, the facilitator MUST require exactly one Memo and an
exact UTF-8 data match. A sponsor MAY reject all optional Lighthouse
instructions, but MUST NOT reject the required Memo or admit instructions
outside this allowlist.

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

Before co-signing an `open` or `top_up`, the facilitator MUST simulate the exact
client-supplied transaction and confirm the eventual settlement path is usable
for the bound mint, token program, payer return ATA, treasury, and `payTo`
recipient ATA. It MAY use a facilitator-built composite simulation or targeted
account checks in addition to the setup simulation, but it MUST reject before
escrowing when a settlement account is missing, frozen, has the wrong owner or
mint, or is otherwise unusable under the program rules. After confirmation it
MUST re-read the channel and verify its status, deposit, mint, payer, payee,
authorized signer, rent payer, grace period, open slot, and distribution against
the payload and requirements before reporting settlement success.

Under the `authorization` flow, the `open` or `top_up` transaction is broadcast
by the post-handler `/settle`, after the statically validated `deposit` request
passes Phase 3 and the resource handler succeeds. After the transaction
confirms, the server records the channel in its `ChannelStore`.

##### Canonical refund `request_close`

The refund transaction MUST contain exactly one canonical payment-channels
`request_close` instruction for the PDA derived from `channelConfig`. It MAY
also contain the bounded Compute Budget prefix allowed above and a suffix with
at most three Lighthouse instructions and at most one Memo. The suffix uses the
same program and fee-payer-isolation rules as setup transactions; when
`extra.memo` is present, a supplied Memo MUST match it. The instruction MUST
use discriminator `5`, contain exactly these two accounts in order, and contain
no remaining accounts:

| Position | Account role | Required binding | Required privileges |
|---:|---|---|---|
| 0 | `payer` | `channelConfig.payer == Channel.payer` | read-only, signer |
| 1 | `channel` | PDA derived from `channelConfig` | writable |

The transaction MUST contain the payer signature and `extra.feePayer` as fee
payer; no other signer or address lookup table is permitted. No instruction or
program outside the prefix/suffix allowlist is permitted. The facilitator MUST
verify that the channel is `Open` or `Closing`, that the payer and fee-payer
bindings match the decoded channel, and that the transaction does not include
`seal`, `settle_and_seal`, `distribute`, or any token transfer. The sponsor
signature authorizes only the bounded network fee.

If the channel is `Open`, the facilitator MUST simulate the exact transaction,
reject a failed simulation, sign and broadcast it, and confirm that the channel
entered `Closing` before returning success. An expired blockhash or
out-of-window `openSlot` MUST be rejected; the client must rebuild and re-sign
with fresh values. If the channel is already `Closing`, the facilitator MUST
NOT rebroadcast; after revalidating the channel bindings, it returns the
observed initiation state as the idempotent result.

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

The server MUST serialize all paid-request and close processing per
channel.
The server stores `chargedCumulativeAmount`, `signedMaxClaimable`, the latest
voucher signature, and a cached paid-response entry keyed by
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
   matching section 4.1. When `channelConfig.receiverAuthorizer` is supplied,
   confirm it equals `extra.receiverAuthorizer`; otherwise both fields MUST be
   absent. Reject if `payer` or `payerAuthorizer` equals `feePayer`.
4. **No voucher expiry.** The client MUST sign `expiresAt = 0`, and the
   server and facilitator MUST reject any voucher with nonzero `expiresAt`.
   The forced-close grace period already bounds the redemption window after a
   payer `request_close`; a per-voucher expiry would add a second clock the
   server has to beat and could make an accepted voucher unredeemable while
   the channel is still open, after the resource has been served.
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

For a `deposit` payload, the `open` or `top_up` transaction is broadcast by the
post-handler `/settle`, so the checks above run against the statically
validated transaction: for `open`, the step-3 bindings and the step-5 cap are
evaluated against the transaction's instruction fields with
`deposit = payload.deposit.amount`; for `top_up`, against the existing onchain
channel with its deposit increased by `payload.deposit.amount`. The server
accepts the risk that a validated deposit transaction later fails to confirm;
because earlier vouchers were capped by the confirmed deposit, that exposure is
bounded by the single request's `amount`.

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
- **Refund (`type: "refund"`).** The facilitator broadcasts the client's
  payer-signed `request_close` transaction with its fee-payer signature. After
  the configured grace period, it or another permissionless crank calls `seal`
  and sealed `distribute`. `distribute` pays any remaining settled delta,
  returns the full `deposit - settled` remainder to the payer, closes the
  escrow token account, and moves the channel to its cleanup state. If the
  server supplies or confirms the final voucher through an authenticated
  request, the facilitator MAY skip the wait and use `settle_and_seal` plus
  sealed `distribute` immediately.
- **Rent cleanup.** If final `distribute` leaves the channel in `Distributed`,
  anyone can later call `reclaim` after the open-slot window to return remaining
  PDA rent to `rent_payer`.

The close authorization is required only for the optional immediate
cooperative-close optimization. It does not remove the facilitator's
independent permissionless lifecycle authority to finalize a forced close at
the current onchain watermark under its published rent-recovery policy.

The payer exits through the payment-channel program's forced-close path. The
server SHOULD claim with enough buffer before `withdrawDelay` can elapse after
the payer calls `request_close`. During the grace period, only the facilitator
as `payee` can apply a final voucher and seal cooperatively, and only when the
server has authenticated that close. After the grace period, anyone can call
`seal`; the payer can recover unspent deposit via `withdraw_payer` or sealed
`distribute`, and vouchers not yet claimed are forfeited by the server.

### Phase 5 - Duplicate and Concurrent Operation Handling

The cumulative voucher and payment-channel state machine prevent duplicate
token movement, but HTTP retries still require explicit operation-level
idempotency:

- **Paid requests (`deposit` and `voucher`).** The server's per-channel lock and
  `("access", channelId, maxClaimableAmount)` cache are the authoritative replay
  defense. The same authorization MUST NOT execute the resource handler more
  than once, regardless of whether a retry changes from `deposit` to `voucher`.
- **Client-supplied transactions.** For `deposit` and `refund`, the facilitator
  SHOULD maintain a short-lived in-flight cache keyed by the exact serialized
  transaction or its first signature. Concurrent `/settle` calls for the same
  transaction MUST be coalesced to one broadcast and one result or rejected
  with `duplicate_settlement`; they MUST NOT produce independent successful
  settlements. The entry MAY be evicted once the transaction's blockhash is no
  longer valid. A refund retry after `request_close` confirms MUST return the
  observed `Closing` state rather than attempt a second transition.
- **Claims.** Program `settle` requires a strictly increasing watermark, so the
  same claim cannot advance accounting twice. A facilitator MAY coalesce
  in-flight `(channelId, maxClaimableAmount)` claims to avoid a predictable
  second transaction failure; no durable duplicate cache is required.
- **Open-channel distributions.** `distribute` advances `payout_watermark` to
  `settled`; a repeat cannot pay the same delta again. A facilitator MAY
  coalesce concurrent distributions for the same channel and observed
  watermark.
- **Refunds.** The facilitator MUST coalesce retries of the same
  `request_close` transaction into one broadcast and one initiation result.
  Once `Closing`, later retries return the observed channel state. A client
  refund does not occupy the cooperative-close authorization namespace and does
  not require a server signature. If the server supplies a cooperative close,
  the latest voucher and its authorization occupy a distinct `("close",
  channelId, maxClaimableAmount)` namespace; the server and facilitator MUST
  cache that result through `closeAuthorization.validBefore` or the replay
  window of the trusted out-of-band request authentication.
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
   server when it has a valid cooperative authorization; afterward the normal
   permissionless `seal` path applies regardless of server availability.
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
- `invalid_batch_settlement_svm_payment_flow` - `extra.paymentFlow` is present
  and is not `"authorization"`.
- `invalid_batch_settlement_svm_token_program` - `extra.tokenProgram` is not a
  supported SPL token program or does not own the selected mint.
- `invalid_batch_settlement_svm_voucher_signature` - signature invalid or
  `channelConfig.payerAuthorizer` does not match channel `authorized_signer`.
- `invalid_batch_settlement_svm_channel_id_mismatch` - `channelId` does not
  match the canonical PDA derivation.
- `invalid_batch_settlement_svm_fee_payer_mismatch` - channel `payee` or
  `rent_payer` does not match `extra.feePayer`.
- `invalid_batch_settlement_svm_receiver_authorizer_mismatch` -
  `channelConfig.receiverAuthorizer` does not match
  `extra.receiverAuthorizer` or the facilitator's trusted server binding.
- `invalid_batch_settlement_svm_close_authorization` - close authorization is
  malformed, expired, signed by the wrong receiver authorizer, does not bind the
  exact cooperative-close request, or the out-of-band request principal does
  not match the server principal bound at deposit.
- `invalid_batch_settlement_svm_close_amount_unsupported` - the `"refund"`
  wire payload contains an `amount`; this scheme supports only returning the
  full unused escrow.
- `invalid_batch_settlement_svm_close_state` - the channel cannot be closed, or
  an optional cooperative voucher does not equal server state or is behind the
  channel's onchain `settled` value.
- `invalid_batch_settlement_svm_withdraw_delay_mismatch` - channel grace period
  does not match `extra.withdrawDelay`.
- `invalid_batch_settlement_svm_withdraw_delay_out_of_range` - `withdrawDelay`
  is outside `900..=2592000` seconds or is shorter than `maxTimeoutSeconds`.
- `invalid_batch_settlement_svm_cumulative_amount_mismatch` - corrective 402:
  client's cumulative voucher does not match server state.
- `invalid_batch_settlement_svm_cumulative_exceeds_deposit` - voucher exceeds
  escrowed deposit.
- `invalid_batch_settlement_svm_voucher_expiry` - voucher `expiresAt` is
  nonzero; this scheme requires non-expiring vouchers.
- `invalid_batch_settlement_svm_setup_transaction` - setup transaction fails the
  sponsor safety checks.
- `invalid_batch_settlement_svm_settlement_simulation` - setup or
  settlement-readiness simulation/checks failed before accepting the deposit.
- `invalid_batch_settlement_svm_channel_state` - confirmed channel state does
  not match the payload and challenge-bound requirements.
- `invalid_batch_settlement_svm_refund_transaction` - refund transaction is not
  a valid payer-signed `request_close` for the derived channel or contains an
  unauthorized instruction.
- `duplicate_settlement` - the same client-supplied setup or refund transaction
  is already being settled.

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
- **Optional authenticated cooperative closes.** The facilitator uses the
  authenticated server request only for the immediate cooperative shortcut. A
  key or principal supplied in an untrusted request is not itself a trust
  anchor: the facilitator binds a receiver-authorizer key through trusted
  registration, or records the authenticated server principal, `channelId`, and
  `payTo` at deposit. The client voucher independently binds the final
  cumulative spend.
- **Committed value is preserved at close.** Both forced and cooperative close
  paths pay any settled delta to `payTo`, return exactly `deposit - settled` to
  the payer, and close the escrow. Partial unused-escrow returns and channel
  reuse after close are not supported.
- **Facilitator rent recovery.** Because the facilitator is channel `payee`, it
  can run `settle_and_seal` with `has_voucher = 0`, then `distribute` and
  `reclaim`, without client or server cooperation. Abandoned channels cannot
  permanently lock sponsored rent.
- **Facilitator early-close exposure.** Closing before the latest voucher is
  claimed freezes the onchain watermark and returns the remainder to the
  client. The server MUST bound its exposure by claiming promptly and SHOULD
  treat unclaimed voucher value as facilitator credit risk. During a
  client-initiated grace period, only the facilitator can apply the final
  voucher, and only after authenticating the server.
- **No replay / no rollback.** Server offchain watermark plus onchain
  `settled` monotonicity reject old vouchers. Paid-request equality is accepted
  only as an idempotent replay of a cached access response. Refund initiation
  is idempotent by the client-signed `request_close` transaction; optional
  cooperative closes use a separate operation namespace and a terminal onchain
  transition.
- **Bounded sponsor exposure.** Client-supplied transactions have a static
  instruction allowlist, exact signer and account layouts, no address lookup
  tables, bounded compute-unit limit and price, and transaction simulation.
  Outside the prescribed `open` rent roles, the facilitator signature
  authorizes network fees only.
- **Client escape hatch.** `withdrawDelay` is fixed at `open`; if the server
  does not settle, the payer can start forced close and recover unspent escrow
  after the grace period. The protocol bounds that delay to 15 minutes through
  30 days and never shorter than the HTTP completion window.
- **Single settlement clock.** Vouchers never expire (`expiresAt` is fixed at
  `0`); the channel's forced-close path alone bounds the commitment. The server
  beats one clock — the grace period after a payer `request_close` — and an
  accepted voucher can never become unredeemable while the channel is open.
- **Fixed pricing.** Each fresh voucher increases the cumulative authorization
  by exactly `PaymentRequirements.amount`. The server trusts itself to redeem
  before forced-close expiry.

## 9. Out of Scope

- A prescribed persistence backend, worker topology, or scheduling architecture
  for the required asynchronous maintenance.
- Smart-wallet-wrapped `open` or `top_up` transactions and simulation-based
  acceptance of arbitrary wallet programs.
- Delegated passkey or secp256r1 voucher signers.
