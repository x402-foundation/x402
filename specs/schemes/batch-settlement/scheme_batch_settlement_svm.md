# SVM `batch-settlement` Scheme: High-Throughput Channel Payments on Solana

> Status: **draft**. Companion to the network-agnostic
> [`scheme_batch_settlement.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md)
> and the EVM profile
> [`scheme_batch_settlement_evm.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md).
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
- **Receiver authorizer**: server-controlled hot key advertised as
  `extra.receiverAuthorizer`; recorded as channel `payee`; signs cooperative
  close/refund operations. It does not need to receive the settled funds.
- **Facilitator / sponsor**: account advertised as `extra.feePayer`; sponsors
  transaction fees and channel rent. It is the transaction fee payer and channel
  `rent_payer`, but it is not a payment authority.

`payTo` is the server's payment receiver, typically a cold wallet. If
`payTo != receiverAuthorizer`, the channel distribution sends 100% of settled
funds to `payTo`, leaving the channel `payee` with a zero implicit remainder.
If `payTo == receiverAuthorizer`, the client MAY omit recipients and let the
payee receive the implicit 100% remainder.

## 2. Mapping the Core Requirements to SVM

| Requirement (generic spec) | EVM mechanism | SVM mechanism |
|---|---|---|
| One-time escrow deposit | Token authorization plus channel contract | Payment-channels `open` deposits escrow, records `withdrawDelay`, fixes `payee`, `authorized_signer`, `rent_payer`, and commits `distribution_hash`. |
| Per-request authorization | Cumulative signed voucher | Ed25519 voucher signed by `payerAuthorizer` over `0x56 0x01 || channelId || cumulativeAmount || expiresAt`. |
| Monotonic amount | `maxClaimableAmount` increases | Server-owned offchain watermark plus onchain `settled < cumulativeAmount <= deposit` at redemption. |
| Batched redemption | Claim many channels | One `settle` per channel, packed transaction-size permitting; `distribute` pays settled deltas. |
| Recipient binding | Receiver fixed in channel config | `distribution_hash` fixed at `open` sends funds to `payTo`; program re-checks it at `distribute`. |
| Refund of unused deposit | Cooperative refund or timed withdrawal | `settle_and_seal` + `distribute` for cooperative close; `request_close` / `seal` / `withdraw_payer` for payer-forced close. |

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
| `amount` | string | yes | Fixed per-request price in base units. |
| `asset` | string | yes | Concrete SPL / Token-2022 mint pubkey, not a symbol. |
| `payTo` | string | yes | Base58 final payment receiver. Normally a server cold wallet. |
| `maxTimeoutSeconds` | number | yes | HTTP completion window. |
| `extra` | object | yes | See below. |

`extra`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `feePayer` | string | yes | Base58 sponsor key that co-signs channel setup/top-up/settlement transactions as transaction fee payer and funds channel rent as `rent_payer`. |
| `receiverAuthorizer` | string | yes | Base58 server-controlled key set as channel `payee`; signs cooperative close/refund transactions. |
| `withdrawDelay` | number | yes | Server-defined forced-close grace period in seconds. The client MUST encode this exact value as the program `grace_period`; the verifier MUST reject any other value. |
| `tokenProgram` | string | yes | `Tokenkeg...` or `TokenzQ...` (Token-2022); the client SHOULD verify it against the onchain mint owner. |
| `recentBlockhash` | string | no | Pre-fetched blockhash so the client can build setup transactions without an RPC round trip. |
| `recentSlot` | number | no | Recent slot the client MAY use as `openSlot` when it does not fetch its own slot. The program still enforces the slot window. |
| `suggestedDeposit` | string | no | Suggested initial deposit in base units. |
| `minimumDeposit` | string | no | HTTP-enforced minimum initial deposit in base units. |
| `minVoucherDelta` | string | no | Minimum cumulative increment between accepted vouchers in base units. |
| `channelState` | object | no | Corrective-only server channel snapshot for cumulative amount resynchronization. |
| `voucherState` | object | no | Corrective-only signed voucher proof for cumulative amount resynchronization. |

The x402 wire format does not expose program-specific split arrays. The client
derives the payment-channel accounts and distribution from the x402 fields:

```text
rent_payer = extra.feePayer
payee = extra.receiverAuthorizer
authorized_signer = channelConfig.payerAuthorizer
grace_period = extra.withdrawDelay

if payTo == extra.receiverAuthorizer:
  recipients = []
  payee_implicit_remainder_bps = 10000
else:
  recipients = [{ recipient: payTo, bps: 10000 }]
  payee_implicit_remainder_bps = 0
```

Any facilitator commercial fee is outside this wire contract or included in the
server's pricing. The channel distribution for this scheme MUST NOT assign any
portion of settled funds away from `payTo`, except when `payTo` is itself the
channel payee via the implicit remainder path.

Example:

```json
{
  "scheme": "batch-settlement",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "1000",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payTo": "<server-cold-wallet>",
  "maxTimeoutSeconds": 300,
  "extra": {
    "feePayer": "<facilitator>",
    "receiverAuthorizer": "<server-hot-wallet>",
    "withdrawDelay": 3600,
    "tokenProgram": "<token-program>",
    "recentBlockhash": "<cached>",
    "recentSlot": 341000000,
    "suggestedDeposit": "100000",
    "minimumDeposit": "10000"
  }
}
```

### 4.2 `BatchPayload` (in `PAYMENT-SIGNATURE.payload`)

A tagged union on `type`:

**`deposit`** - open a channel or top up an existing channel and authorize the
current request:

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"deposit"` |
| `channelConfig` | object | See `ChannelConfig` below. |
| `transaction` | string | Base64 client-signed `open` or `top_up` transaction for the sponsor to co-sign and broadcast. |
| `voucher` | object | New cumulative `BatchVoucher` for the request being paid. |

**`voucher`** - steady-state paid request with no onchain transaction:

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"voucher"` |
| `channelId` | string | Channel PDA (base58). |
| `voucher` | object | New cumulative `BatchVoucher`. |

**`refund`** - cooperative close; the application resource handler is bypassed:

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"refund"` |
| `channelId` | string | Channel PDA (base58). |
| `voucher` | object | Zero-charge voucher whose `cumulativeAmount` equals the server's current watermark. |
| `amount` | string | Optional requested refund amount; omitted means full unspent remainder. |

`ChannelConfig`:

| Field | Type | Notes |
|---|---|---|
| `payer` | string | Client wallet and channel payer. |
| `payerAuthorizer` | string | Client-controlled Ed25519 voucher signer; maps to channel `authorized_signer`. MAY equal `payer`. |
| `receiver` | string | MUST equal `payTo`. Included so the client can verify the derived distribution. |
| `receiverAuthorizer` | string | MUST equal `extra.receiverAuthorizer`; maps to channel `payee`. |
| `mint` | string | MUST equal `asset`. |
| `tokenProgram` | string | MUST equal `extra.tokenProgram`. |
| `salt` | string | Decimal `u64` channel salt. |
| `openSlot` | number | `u64` slot encoded in `open` and used as a channel PDA seed. |
| `depositAmount` | string | Initial deposit or top-up amount in base units. |
| `withdrawDelay` | number | MUST equal `extra.withdrawDelay`. |

`channelId` is the program-derived address:

```text
find_program_address(
  [
    "channel",
    channelConfig.payer,
    channelConfig.receiverAuthorizer,
    channelConfig.mint,
    channelConfig.payerAuthorizer,
    u64(channelConfig.salt).to_le_bytes(),
    u64(channelConfig.openSlot).to_le_bytes()
  ],
  CANONICAL_PAYMENT_CHANNELS_PROGRAM_ID
)
```

The `open` instruction MUST encode:

- `salt == channelConfig.salt`
- `deposit == channelConfig.depositAmount`
- `grace_period == extra.withdrawDelay`
- `open_slot == channelConfig.openSlot`
- `rent_payer == extra.feePayer`
- `payee == extra.receiverAuthorizer`
- `authorized_signer == channelConfig.payerAuthorizer`
- the distribution derived from `payTo` as specified in section 4.1

`BatchVoucher`:

| Field | Type | Notes |
|---|---|---|
| `channelId` | string | Channel PDA (base58). |
| `cumulativeAmount` | string | Cumulative authorized total in base units. |
| `expiresAt` | number | Unix seconds. `0` means no voucher expiry; otherwise the program enforces `now < expiresAt` at `settle` / `settle_and_seal`. |
| `signer` | string | Base58 voucher signer. MUST equal `channelConfig.payerAuthorizer` / channel `authorized_signer`. |
| `signature` | string | Base58 Ed25519 signature over the voucher payload. |

The signed message is exactly:

```text
0x56 0x01 || channelId || u64(cumulativeAmount).le || i64(expiresAt).le
```

This is the payment-channels program voucher layout (`VOUCHER_MAGIC`,
`channel_id`, `cumulative_amount`, `expires_at`), 50 bytes total.

### 4.3 `SettlementResponse` (in `PAYMENT-RESPONSE`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `success` | boolean | yes |  |
| `errorReason` | string | no | Omitted on success. |
| `payer` | string | no | Channel `payer`. |
| `transaction` | string | yes | Onchain signature for deposit/top-up/refund/settlement operations; empty string for offchain voucher acceptance. |
| `network` | string | yes | CAIP-2. |
| `amount` | string | no | Amount moved onchain; empty or omitted for voucher-only acceptance. |
| `extra.commitmentId` | string | no | Non-empty commitment identifier for voucher-only acceptance, e.g. `channelId:cumulativeAmount`. |
| `extra.chargedAmount` | string | no | Per-request charge committed offchain. |
| `extra.channelState` | object | no | `{channelId, deposit, chargedCumulativeAmount, settled, paidOut, status}` snapshot. |

Scheme-specific fields are nested under `extra`, matching the EVM
`batch-settlement` profile.

## 5. Phases

### Phase 1 - Open or Top Up

The client builds an `open` transaction for a new channel or a `top_up`
transaction for an existing channel. The client signs as channel `payer`; the
sponsor later signs as transaction fee payer. For `open`, the sponsor also signs
as program `rent_payer`, because the payment-channels program debits SOL from
that account to fund the channel PDA and escrow ATA rent.

For `open`, the client MUST set `payee = extra.receiverAuthorizer`,
`authorized_signer = channelConfig.payerAuthorizer`, `rent_payer =
extra.feePayer`, `grace_period = extra.withdrawDelay`, and `open_slot =
channelConfig.openSlot`.

The sponsor MUST validate the full compiled setup transaction before co-signing,
not only the payment-channel instruction. It MUST resolve address lookup tables,
allow only the expected instruction set (payment-channel `open` or `top_up`,
optional associated-token-account creation required by `open`, and bounded
ComputeBudget instructions), confirm the canonical program id and instruction
arguments, and confirm `feePayer` is not used as an authority, source, or
writable account except for transaction fees and the intended channel/escrow
rent. Anything else MUST be rejected before broadcasting.

After confirmation, the server records the channel in its `ChannelStore` and
accepts the voucher for the request under Phase 3.

### Phase 2 - Steady-State Request

The client increments the cumulative total by the fixed per-request `amount`,
signs a new `BatchVoucher`, and sends a `voucher` payload. No onchain
transaction is required in the request path. The server verifies and stores the
voucher under Phase 3, then serves immediately.

### Phase 3 - Voucher Acceptance (before serving)

The server is the sole owner of per-channel offchain state. A separate
facilitator, if used, remains stateless for ordinary voucher acceptance; it only
needs onchain state plus a voucher when it later settles.

For every voucher, the server MUST:

1. Verify the Ed25519 signature over the 50-byte message and confirm `signer`
   equals the channel `authorized_signer` / `channelConfig.payerAuthorizer`.
2. Confirm `channelId` matches the PDA derived from `channelConfig` and the
   canonical payment-channels program id.
3. Confirm the channel exists, is `Open`, has `mint == asset`,
   `payee == extra.receiverAuthorizer`, `authorized_signer ==
   channelConfig.payerAuthorizer`, `rent_payer == extra.feePayer`,
   `grace_period == extra.withdrawDelay`, `open_slot ==
   channelConfig.openSlot`, and a distribution to `payTo` matching section 4.1.
4. **Expiry, accounting for async settlement.** `expiresAt` is re-checked
   onchain when `settle` or `settle_and_seal` executes. Because redemption is
   delayed, the server MUST require either `expiresAt == 0` or
   `expiresAt >= now + withdrawDelay + a settlement buffer`. A voucher that
   could expire before redemption MUST be rejected.
5. Enforce deposit cap: `cumulativeAmount <= channel.deposit`.
6. Enforce monotonicity against the server's stored watermark:
   - `cumulativeAmount < watermark`: reject as stale.
   - `cumulativeAmount == watermark`: idempotent retry only. Return the cached
     response for `(channelId, cumulativeAmount)` and do not execute the
     resource handler again.
   - `cumulativeAmount > watermark`: fresh charge.
     `cumulativeAmount == watermark + PaymentRequirements.amount` and the
     increment is at least `minVoucherDelta` when set.
7. For a fresh charge, atomically advance the stored watermark, store the latest
   voucher, serve the resource, and return `PAYMENT-RESPONSE` with
   `transaction == ""`, `extra.commitmentId`, `extra.chargedAmount`, and
   `extra.channelState`.

On any failure, the server returns `402` without serving the resource. If the
server has local channel state and the client submits the wrong cumulative
amount, the server SHOULD return a corrective 402 with
`accepts[].extra.channelState` and `accepts[].extra.voucherState`, following the
EVM profile's recovery convention.

### Phase 4 - Batched Redemption (out of band)

The server or facilitator redeems accumulated vouchers asynchronously, outside
the request path:

- **Settle.** For each channel, build an Ed25519 precompile instruction for the
  latest stored voucher followed by `settle`. Pack as many channels into one
  transaction as the transaction size permits; do not silently drop channels
  from a full batch. `settle` advances onchain `settled` to the voucher's exact
  cumulative amount.
- **Distribute while open.** Call `distribute` to pay the newly settled delta to
  `payTo` and advance `payout_watermark`. The channel remains open.
- **Cooperative close/refund.** For a `refund` payload or server-initiated
  close, `receiverAuthorizer` signs `settle_and_seal` with the final voucher
  (or no voucher for a zero-charge close), then `distribute` pays any remaining
  settled delta, refunds `deposit - settled` to the payer, closes the escrow
  token account, and moves the channel to its cleanup state.
- **Rent cleanup.** If final `distribute` leaves the channel in `Distributed`,
  anyone can later call `reclaim` after the open-slot window to return remaining
  PDA rent to `rent_payer`.

The server SHOULD redeem with enough buffer before `withdrawDelay` can elapse
after a client starts forced close. If the payer calls `request_close`, the
server can still `settle_and_seal` during the grace period. After the grace
period, anyone can call `seal`; the payer can then recover unspent deposit via
`withdraw_payer` or the sealed `distribute` refund branch, and vouchers not yet
settled are forfeited by the server.

## 6. Error Codes

Standard x402 codes apply. Scheme-specific failures surface as `402` with an
`errorReason`:

- `invalid_batch_settlement_svm_voucher_signature` - signature invalid or signer
  does not match channel `authorized_signer`.
- `invalid_batch_settlement_svm_channel_id_mismatch` - `channelId` does not
  match the canonical PDA derivation.
- `invalid_batch_settlement_svm_receiver_authorizer_mismatch` - channel `payee`
  does not match `extra.receiverAuthorizer`.
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

## 7. Security Properties

- **No overcharge.** Onchain `settle` rejects vouchers above `deposit` and sets
  the exact cumulative amount signed by the client.
- **No redirection.** `distribution_hash` is fixed at `open` and re-checked at
  `distribute`; the derived distribution sends settled funds to `payTo`.
- **Facilitator isolation.** `feePayer` sponsors fees/rent only. It is not
  `payee` and not `authorized_signer`, so it cannot sign vouchers or
  cooperative closes.
- **Server-controlled close.** `receiverAuthorizer` is the channel `payee`, so a
  hot server key can sign `settle_and_seal` while funds still route to cold
  `payTo`.
- **No replay / no rollback.** Server offchain watermark plus onchain
  `settled` monotonicity reject old vouchers. Equality is accepted only as an
  idempotent replay of a cached response.
- **Client escape hatch.** `withdrawDelay` is fixed at `open`; if the server
  does not settle, the payer can start forced close and recover unspent escrow
  after the grace period.
- **Time-bounded commitments.** Nonzero voucher `expiresAt` is checked both at
  server acceptance and onchain redemption. `expiresAt == 0` means no voucher
  expiry; in that case the channel's forced-close path bounds the commitment.
- **Metering trust.** Each fresh request charges the advertised
  `PaymentRequirements.amount`. The client trusts the server to return the
  resource once the voucher is accepted; the server trusts itself to redeem
  before voucher expiry or forced-close expiry.

## 8. Out of Scope

- Dynamic per-request pricing below `PaymentRequirements.amount`.
- A durable background channel manager, redemption scheduler, and forced-close
  watchdog.
- Delegated passkey or secp256r1 voucher signers.
