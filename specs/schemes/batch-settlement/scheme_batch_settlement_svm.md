# SVM `batch-settlement` Scheme: High-Throughput Channel Payments on Solana

> Status: **draft**. Companion to the network-agnostic
> [`scheme_batch_settlement.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md)
> and the EVM profile
> [`scheme_batch_settlement_evm.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md).
> This document specifies how the `batch-settlement` scheme is realized on Solana
> Virtual Machine (SVM) networks.

## 1. Purpose

`batch-settlement` is the high-throughput x402 scheme: a client **deposits once**
into an escrow channel, then signs a stream of **cumulative Ed25519 vouchers**
(one per request). The server verifies each voucher **off-chain** and serves the
resource immediately — no on-chain transaction in the request path — and the
operator **redeems the latest voucher per channel later, in batches**. This
amortizes one on-chain settlement across many paid requests, so per-request cost
and latency approach zero.

Where `upto` settles **at most once** per authorization, `batch-settlement` is
its multi-voucher generalization: the channel is long-lived and each request
advances a monotonic cumulative counter. On SVM this is the same model as the MPP
**`session`** intent, surfaced over the x402 wire and backed by the **same**
payment-channels program and 48-byte voucher already used by
[`upto`](../upto/scheme_upto_svm.md).

## 2. Mapping the core requirements to SVM

| Requirement (generic spec) | EVM mechanism | SVM mechanism (this spec) |
|---|---|---|
| One-time escrow deposit | ERC-20 `approve` + channel contract | `payment-channels` program: `open` deposits the escrow and fixes `payee` / `authorizedSigner` / `distribution_hash`. |
| Per-request authorization | Cumulative signed voucher | 48-byte Ed25519 voucher `channel_id ‖ cumulative_amount_le ‖ expires_at_le`, signed by the channel's `authorizedSigner`. |
| Monotonic amount | `cumulativeAmount` strictly increases | Off-chain watermark in the **server's** `ChannelStore` (`cumulative`), capped by on-chain `deposit`; on-chain `SettlementWatermarks.settled` enforces it at redemption. |
| Batched redemption | One `claim` per channel, up to N | `settle` per channel draws the voucher's **exact** cumulative; multiple channels packed per transaction (tx-size-bounded). |
| Recipient binding | Channel `recipient` fixed at open | `channel.payee` + `distribution_hash` fixed at `open`. |
| Refund of unused deposit | `close` / cooperative close | `settle_and_finalize` + `distribute`: pays the settled amount and refunds `deposit − settled` to the payer, closing the channel. |

**Decisive SVM divergence.** The SVM `settle` instruction draws the voucher's
**exact** cumulative (`settled = voucher.cumulativeAmount`, after
`settled < cumulative ≤ deposit`), not EVM's "claim up to a ceiling." So an SVM
voucher commits the **actual** cumulative charged, and EVM's `claim`/`settle`
split maps to our `settle` (advance the on-chain watermark) and `distribute`
(sweep settled funds to `payee`/splits) instructions. Consequently v1 ships a
**fixed per-request price** (each request advances the cumulative by exactly the
advertised `amount`); dynamic pricing below the advertised amount would need a
commit round-trip and is deferred.

## 3. Profile

A server advertises supported profiles in `extra.profiles`. v1 defines a single
normative profile:

### 3.1 `payment-channel` (normative, v1)

Backed by the on-chain payment-channels program (advertised via
`extra.channelProgram`; a canonical deployment is assumed when omitted). The
escrow **deposit is the ceiling**; the client signs cumulative vouchers
off-chain; the operator settles the latest voucher per channel in batches and
finalizes with a refund of the unused remainder.

Unlike `upto`, where the **operator** is the `authorizedSigner` (it fills in
`actual ≤ ceiling` after metering), here the **client** is the `authorizedSigner`
— the client signs each cumulative voucher itself (this is the `session` /
client-voucher model). The operator fills the remaining channel roles: it is the
fee payer, the `rentPayer`, **and the channel `payee`** — which the program
requires as the `settle_and_finalize` merchant (`merchant == channel.payee`). The
x402 `payTo` is realized as that `payee` when the server self-facilitates
(`payTo == operator`), or as a program-enforced `distributionSplits` entry when a
separate facilitator is the `payee`. The operator only ever submits on-chain
`settle` / `distribute` / `finalize`; it can never exceed the on-chain `deposit`
(the client signs the cumulative) or redirect funds away from the sealed
distribution.

Strengths: per-request cost approaches zero (no on-chain tx per request); every
requirement is enforced on-chain by the program. Cost: the client locks the
deposit for the channel's lifetime, and the operator must settle before the
forced-close grace period elapses to capture funds.

> **Reference-implementation status.** The v1 reference implements the
> **self-facilitating** case (`operator == payTo`), where the operator is both
> the settlement authority (`channel.payee`) and the recipient. Separate-facilitator
> operation — `payTo` as a program-enforced `distributionSplits` entry, the
> facilitator as `channel.payee` — is specified but not yet implemented.

## 4. Wire format

`batch-settlement` reuses the x402 v2 transport: a `402` response carries
`PAYMENT-REQUIRED`; each paid request carries `PAYMENT-SIGNATURE`; the response
carries `PAYMENT-RESPONSE`. Only the `scheme` value and the payload shape change
relative to `exact`. The core `PaymentRequirements`, `PaymentPayload`, and
`SettlementResponse` types are defined in
[`x402-specification-v2.md`](../../x402-specification-v2.md).

### 4.1 `PaymentRequirements` (in `PAYMENT-REQUIRED.accepts[]`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `scheme` | string | ✓ | `"batch-settlement"` |
| `network` | string | ✓ | CAIP-2, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet) |
| `amount` | string | ✓ | Per-request price, base units (fixed in v1) |
| `asset` | string | ✓ | The concrete SPL / Token-2022 mint pubkey (base58), e.g. USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` — not a symbol |
| `payTo` | string | ✓ | Base58 recipient. Realized as the channel `payee` when the server self-facilitates (`payTo == operator`), or as a `distributionSplits` entry when a separate facilitator is the `payee`. |
| `maxTimeoutSeconds` | number | ✓ | Completion window |
| `extra` | object | ✓ | See below |

`extra` (`BatchExtra`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `profiles` | string[] | ✓ | Subset of `["payment-channel"]`, in server preference order |
| `channelProgram` | string | ✓ | Channel program id (base58) |
| `gracePeriodSeconds` | number | ✓ | Forced-close grace period (non-zero) |
| `feePayer` | string | ✓ | Operator key that sponsors fees (co-signs/broadcasts `open`) and submits settlement (base58) |
| `decimals` | number | – | Token decimals |
| `tokenProgram` | string | – | `Tokenkeg…` or `TokenzQ…` (Token-2022); the client SHOULD verify it against the on-chain mint owner |
| `recentBlockhash` | string | – | Pre-fetched blockhash so the client can build `open`/`topUp` without an extra RPC round-trip |
| `suggestedDeposit` | string | – | Suggested initial deposit (base units) |
| `minimumDeposit` | string | – | HTTP-enforced minimum initial deposit (base units) |
| `minVoucherDelta` | string | – | Minimum cumulative increment between accepted vouchers (base units) |
| `distributionSplits` | `{recipient, shareBps}[]` | – | Merchant-side splits committed at open; payee gets the remainder |

### 4.2 `BatchPayload` (in `PAYMENT-SIGNATURE.payload`)

A tagged union on `type`:

**`deposit`** — open a channel (or top up) and authorize the first voucher:

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"deposit"` |
| `channelConfig` | object | `{payer, payee, mint, authorizedSigner, salt, depositAmount, gracePeriodSeconds, distributionSplits[]}`. The channel id is the PDA `["channel", payer, payee, mint, authorizedSigner, salt]`. |
| `transaction` | string | Base64 client-signed `open`/`topUp` transaction for the operator to co-sign as fee payer + broadcast |
| `voucher` | object? | First cumulative `BatchVoucher` (omitted on a pure top-up) |

**`voucher`** — steady-state paid request (no on-chain transaction):

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"voucher"` |
| `channelId` | string | Channel PDA (base58) |
| `voucher` | object | A new cumulative `BatchVoucher` |

**`refund`** — cooperative close (the application route is bypassed):

| Field | Type | Notes |
|---|---|---|
| `type` | string | `"refund"` |
| `channelId` | string | Channel PDA (base58) |
| `voucher` | object? | Optional final voucher to settle before refunding |

`BatchVoucher`:

| Field | Type | Notes |
|---|---|---|
| `channelId` | string | Channel PDA (base58) |
| `cumulativeAmount` | string | Cumulative authorized total (base units), monotonically increasing |
| `expiresAt` | number | Voucher expiry (Unix seconds); MUST be a future time |
| `signer` | string | Base58 voucher signer = the channel's `authorizedSigner` (the client) |
| `signature` | string | Base58 Ed25519 signature over the 48-byte voucher payload |

The signed message is exactly `channel_id (32) ‖ cumulative_amount (u64 le) ‖
expires_at (i64 le)`, identical to `upto` and the MPP `session` voucher.

### 4.3 `SettlementResponse` (in `PAYMENT-RESPONSE`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `success` | boolean | ✓ | |
| `errorReason` | string | – | Omitted on success |
| `payer` | string | – | Channel `payer` |
| `transaction` | string | ✓ | On-chain signature; **empty `""` for an off-chain voucher acceptance** (the common case) |
| `network` | string | ✓ | CAIP-2 |
| `amount` | string | – | Amount moved on-chain (`""` / omitted for a voucher-only acceptance) — optional, per the core `SettleResponse` |
| `extra.chargedAmount` | string | – | The per-request charge committed off-chain |
| `extra.channelState` | object | – | `{channelId, deposit, settled, paidOut, status}` snapshot |

Scheme-specific fields are nested under `extra` and `amount` is optional, matching
the core `SettleResponse` and the EVM `batch-settlement` profile
(`extra.chargedAmount`, `extra.channelState`).

## 5. Phases

### Phase 1 — Open (once per channel)

The client builds an `open` transaction depositing `depositAmount` (≥
`extra.minimumDeposit`), with `authorizedSigner = payer` (client-voucher model),
`payee = operator` (the settlement authority — equal to `payTo` when the server
self-facilitates; see §3.1), `rentPayer = operator`, and `distributionSplits`
matching `extra.distributionSplits`.
The client sends a `deposit` payload carrying the base64 client-signed
transaction plus the first cumulative voucher.

The operator MUST validate the **full compiled** `open` transaction before
co-signing as fee payer — not only the payment-channel instruction. Following the
`exact` SVM scheme's fee-payer guard
([`scheme_exact_svm.md`](../exact/scheme_exact_svm.md)): resolve any
address-lookup tables; allow only the expected instruction set (the channel
`open`, plus an optional ComputeBudget instruction); confirm the program id and
`open` discriminator and that accounts/args match `channelConfig`; and confirm
the fee payer (the operator) is never used as an authority, source, or writable
account except to pay transaction fees. Anything else is rejected before
broadcasting, so a malicious client cannot make the operator co-sign more than
fee payment. The operator then co-signs, broadcasts, confirms, binds the on-chain
channel into the server's `ChannelStore`, and accepts the first voucher
(Phase 3). Only then is the resource served.

### Phase 2 — Steady state (per request)

The client increments the cumulative total by the per-request `amount`, signs a
new `BatchVoucher`, and sends a `voucher` payload. No on-chain transaction. The
operator accepts the voucher off-chain (Phase 3) and serves immediately.

### Phase 3 — Voucher acceptance (before serving)

For every voucher the operator MUST (the off-chain watermark and channel snapshot
are the **resource server's** per-channel state — a separate facilitator, if used,
stays stateless for this verification, per x402):

1. Verify the Ed25519 `signature` over the 48-byte message against `signer`, and
   confirm `signer` equals the channel's `authorizedSigner`.
2. **Expiry, accounting for async settlement.** `expiresAt` is re-checked
   **on-chain** when `settle` / `settleAndFinalize` execute (the program rejects
   `expires_at != 0 && now ≥ expires_at`), not only at HTTP acceptance. Because
   redemption is batched and out-of-band, the operator MUST require `expiresAt`
   to outlast the redemption window: either `expiresAt == 0` (the program treats
   `0` as no-expiry, so the channel is time-bounded only by its forced-close
   grace period) or `expiresAt ≥ now + gracePeriodSeconds + a settlement buffer`.
   A voucher whose `expiresAt` could lapse before settlement MUST be rejected —
   it would be served but never redeemable.
3. Enforce **monotonicity**: reject any `cumulativeAmount` **below** the stored
   watermark — a stale or replayed voucher. The `cumulativeAmount` is itself the
   per-request nonce: each served response maps one-to-one to a unique cumulative
   level, so replay protection is intrinsic to the amount.
4. Enforce the **deposit cap**: `cumulativeAmount ≤ channel.deposit`.
5. **Charge-worthy (new) request** — `cumulativeAmount > watermark`: in
   fixed-price v1 the increment MUST equal the advertised price exactly
   (`cumulativeAmount == watermark + amount`, and ≥ `minVoucherDelta` when set).
   The operator atomically advances the stored watermark (compare-and-set),
   serves the resource, and caches the response keyed by
   `(channelId, cumulativeAmount)`.
6. **Idempotent retry** — `cumulativeAmount == watermark`: necessarily a retry of
   the request already paid for at that level (a genuinely new request carries a
   strictly higher cumulative). The operator returns the **cached response** for
   that `(channelId, cumulativeAmount)` and does **not** serve a fresh resource,
   re-charge, or advance the watermark. Accepting an equal voucher MUST NOT
   produce a new response — otherwise a client could replay its latest voucher to
   buy further responses without paying.

On any failure the operator returns `402` without serving the resource. A fresh
acceptance (step 5) returns `200` with a `PAYMENT-RESPONSE` carrying an empty
`transaction` and the `chargedAmount`; an idempotent retry (step 6) replays that
cached `200` response.

### Phase 4 — Batched settlement (operator-driven, out of band)

The operator redeems accumulated vouchers asynchronously — **not** in the request
path:

- **Batched `settle`.** For each channel the operator builds
  `[ed25519_verify(latest voucher), settle]` from the stored highest voucher and
  packs as many channels into one transaction as fit (**transaction-size-bounded**
  — a few per transaction today, more as the runtime allows). Any channel dropped
  from a full batch MUST be logged (no silent truncation). `settle` advances
  on-chain `SettlementWatermarks.settled` to the voucher's exact cumulative.
- **`distribute`.** Sweep settled-but-unpaid funds to the `payee` and the
  committed `distributionSplits`.
- **`settle_and_finalize` + `distribute`** on a `refund` payload (or when
  closing): settle the final voucher, pay out, refund `deposit − settled` to the
  payer, and close the channel.

The operator MUST settle before the forced-close `gracePeriodSeconds` elapses
after a client requests close, or it forfeits the unsettled remainder. Because
redemption is asynchronous, the operator SHOULD settle with a comfortable buffer
ahead of that deadline, and SHOULD advertise a `gracePeriodSeconds` long enough
to cover its batch cadence — consistent with the `expiresAt` window in §5
Phase 3.

## 6. Error codes

Standard x402 codes apply. Scheme-specific failures surface as `402` with an
`errorReason`:

- voucher signature invalid / signer ≠ `authorizedSigner`
- voucher expired (`expiresAt ≤ now`)
- non-monotonic cumulative (below the watermark)
- cumulative exceeds the on-chain `deposit`
- increment below `minVoucherDelta`
- `open` transaction failed the SOL-drain guard (rejected before co-signing)

## 7. Security properties

- **No overcharge.** Each voucher is capped on-chain by `deposit`; `settle` draws
  the voucher's exact cumulative and can never exceed it.
- **No redirection.** `channel.payee` / `distribution_hash` are fixed at `open`.
- **No replay / no rollback.** Off-chain monotonic watermark plus on-chain
  monotonic `SettlementWatermarks.settled`; an old voucher cannot settle after a
  newer one.
- **No fee-payer drain.** The operator validates the full compiled `open`
  transaction before co-signing — allowed instruction set only, address-lookup
  tables resolved, and the fee payer never used as an authority, source, or
  writable account except to pay fees (§5 Phase 1).
- **Time-bounded.** `expiresAt` is checked off-chain at acceptance and re-checked
  on-chain at `settle`/`settleAndFinalize`. Because the **client** signs each
  voucher (it is the `authorizedSigner`), `expiresAt` is a genuine client
  commitment here — unlike `upto`, where the operator signs and the field is
  operator-attested. Since redemption is asynchronous, the operator only accepts
  vouchers whose `expiresAt` is `0` (no-expiry) or outlasts the settlement window
  (§5 Phase 3), so an accepted voucher cannot expire before it is redeemed.
- **Bounded loss.** The client trusts the operator to settle before grace; the
  operator trusts the client only up to the escrowed `deposit`. Everything above
  the deposit, the destination, and replay are enforced cryptographically /
  on-chain.

## 8. Out of scope (follow-ups)

- Automatic background channel manager (settle/distribute cadence) and
  forced-close watchdog (settle before grace elapses); durable `ChannelStore`.
- Metered / dynamic per-request pricing below the advertised `amount` (needs the
  commit round-trip; SVM `settle` draws the voucher's exact cumulative).
- `secp256r1` / passkey delegated voucher signers.
