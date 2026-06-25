# SVM `upto` Scheme: Usage-Based Payment Authorization on Solana

> Status: **draft**. Companion to the network-agnostic
> [`scheme_upto.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md)
> and the EVM profile
> [`scheme_upto_evm.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md).
> This document specifies how the `upto` scheme is realized on Solana Virtual
> Machine (SVM) networks.

## 1. Purpose

`upto` lets a client authorize a **maximum** amount while the server settles for
**actual** usage (`actual ≤ max`), with the final charge determined after the
resource is consumed. Same target use cases as the generic spec: LLM token
billing, per-byte metering, dynamic compute pricing.

The hard part on Solana: a normal signed transfer commits to an *exact* amount
and exact instruction data, so the server cannot lower the amount after the
client signs without invalidating the signature. `upto` therefore requires an
authorization that commits the client to a **ceiling** and lets the
**facilitator** choose the actual amount at settlement. SVM offers two
mechanisms that decouple "client authorizes a max" from "facilitator executes
the actual," expressed here as two **profiles**.

## 2. Mapping the five core requirements to SVM

| Requirement (generic spec) | EVM mechanism | SVM mechanism (this spec) |
|---|---|---|
| Single-use authorization | Permit2 nonce | `payment-channel`: `finalize` makes the channel terminal (`ChannelStatus::Finalized`). `permit`: a one-shot nonce PDA consumed at settle. |
| Time-bound validity (`validAfter`, `deadline`) | Permit2 `deadline` + witness `validAfter` | Authorization `validAfter` + `expiresAt`; `expiresAt` is also signed into the on-chain voucher / permit message. |
| Recipient binding | Permit2 witness `to` | `payment-channel`: `channel.payee` + `distribution_hash` fixed at open. `permit`: `payTo` signed into the permit message and enforced by the program. |
| Maximum amount enforcement | `permitted.amount` ceiling | `payment-channel`: on-chain `deposit` ceiling, `cumulative_amount ≤ deposit`. `permit`: `maxAmount` signed into the permit message, `actual ≤ maxAmount` enforced by the program. |
| Phase-dependent amount semantics | `amount` = max at verify, actual at settle | Identical. `amount` in `PaymentRequirements` is the max during verification and the actual charge during settlement. |

The facilitator MUST always verify against the client-signed ceiling, never
against the settlement-time `amount`.

## 3. Profiles

A server advertises one or more profiles in `extra.profiles`. The client picks
one and signals it back in the payload's `profile` field.

### 3.1 `payment-channel` (normative, v1)

Backed by the on-chain payment-channels program (a `pay-kit`-controlled program;
program id `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` on the current
deployment). The escrow **deposit is the ceiling**; a single signed voucher
settles the actual amount; `finalize` closes the channel and refunds the unused
remainder to the payer in the same transaction.

Strengths: every requirement is enforced on-chain by a program we control. The
facilitator cannot overcharge (capped by `deposit`), cannot redirect funds
(`channel.payee` / `distribution_hash` are fixed at open), and cannot replay
(channel is terminal after `finalize`).

Cost: the client locks `max` in escrow for the lifetime of the request, and the
flow needs two on-chain transactions (open, then settle-and-finalize). Channel
rent is reclaimed at finalize.

### 3.2 `permit` (optional, v2 — requires a new program)

Backed by an Ed25519-signed one-shot delegated transfer — the closest analog to
EVM's `permitWitnessTransferFrom`. The client `approve`s a program-owned
delegate on its token account (reusable across requests, like a one-time Permit2
approval), then signs an off-chain **permit message** committing to a ceiling and
a witness. At settlement the facilitator submits one transaction; a small
on-chain program verifies the Ed25519 signature (via the Ed25519 precompile +
instructions sysvar, the same pattern the payment-channels program already uses
for vouchers), checks the witness, enforces `actual ≤ maxAmount`, transfers the
actual amount to `payTo`, and consumes a nonce PDA for replay protection.

Strengths: no escrow lockup; a single settlement transaction; reusable approval.
Matches EVM ergonomics.

Cost: requires a new, audited on-chain program. Until that program ships and is
audited, `payment-channel` is the only normative profile.

> Multi-delegator is explicitly **not** an `upto` backend. Its `FixedDelegation`
> is a standing, multi-pull cap that binds the *delegatee* (operator), not the
> final `payTo`, and offers no on-chain single-use guarantee. It is the right
> primitive for `session`/streaming, not for one-shot `upto`. Using it here
> would downgrade the recipient-binding and single-use requirements to
> "trust the facilitator," defeating the scheme.

## 4. Wire format

`upto` reuses the x402 v2 transport: a `402` response carries `PAYMENT-REQUIRED`;
the paid retry carries `PAYMENT-SIGNATURE`; the response carries
`PAYMENT-RESPONSE`. Only the `scheme` value and the payload shape change relative
to `exact`. The core `PaymentRequirements`, `PaymentPayload`, and
`SettlementResponse` types are defined in
[`x402-specification-v2.md`](../../x402-specification-v2.md).

### 4.1 `PaymentRequirements` (in `PAYMENT-REQUIRED.accepts[]`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `scheme` | string | ✓ | `"upto"` |
| `network` | string | ✓ | CAIP-2, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet) |
| `amount` | string | ✓ | **Phase-dependent**: max authorized at verification; actual charge at settlement. Base units. |
| `asset` | string | ✓ | SPL mint address (or `"SOL"` — discouraged for `upto`; stablecoins recommended) |
| `payTo` | string | ✓ | Base58 recipient |
| `maxTimeoutSeconds` | number | ✓ | Completion window; also the basis for the authorization `expiresAt` |
| `extra` | object | ✓ | See below |

`extra`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `profiles` | string[] | ✓ | Subset of `["payment-channel","permit"]`, in server preference order |
| `feePayer` | string | ✓ | Base58 operator key that sponsors fees (co-signs the setup transaction as fee payer) and settles |
| `channelProgram` | string | – | Channel/permit program id; defaults to the canonical deployment |
| `decimals` | number | ✓ | Token decimals |
| `tokenProgram` | string | ✓ | `Tokenkeg…` or `TokenzQ…` (Token-2022); the client SHOULD verify it against the on-chain mint owner |
| `recentBlockhash` | string | – | Pre-fetched blockhash so the client can build setup transactions without an extra RPC round-trip |
| `validAfter` | number | – | Earliest activation time (Unix seconds); default = now |
| `splits` | `{recipient,bps}[]` | – | `payment-channel` only; distributed at finalize |

### 4.2 `UptoPayload` (in `PAYMENT-SIGNATURE.payload`)

Common fields:

| Field | Type | Notes |
|---|---|---|
| `profile` | string | `"payment-channel"` or `"permit"` |
| `from` | string | Payer wallet (base58) |
| `maxAmount` | string | The signed ceiling (base units). MUST equal verification-phase `amount`. |
| `expiresAt` | number | Deadline (Unix seconds); signed into the on-chain message |
| `validAfter` | number | Activation time (Unix seconds) |
| `nonce` | string | Unique per authorization |

`payment-channel` profile adds:

| Field | Type | Notes |
|---|---|---|
| `channelId` | string | Channel PDA (base58) |
| `deposit` | string | On-chain escrow = the ceiling; MUST equal `maxAmount` |
| `authorizedSigner` | string | The **operator/facilitator** key (base58). The operator — not the client — signs the single settlement voucher (see §5 Phase 2). |
| `openTransaction` | string | Base64 signed `open` transaction for the facilitator to broadcast if the channel is not yet open (pull-style). Omitted if the client already broadcast `open` (push-style) and `signature` is set. |
| `signature` | string | Base58 signature of the broadcast `open` transaction (push) |

> The voucher is **not** carried in the payload. Because the actual amount is
> only known after the resource is consumed, and the client's protection is the
> on-chain `deposit` ceiling plus the fixed `payee`, the operator (set as the
> channel's `authorizedSigner` at open) signs the single voucher for the metered
> amount at settlement. This keeps `upto` a single HTTP round-trip with a
> handler-determined amount, matching the EVM trust model where the server fills
> in `actual ≤ ceiling`.

`permit` profile adds:

| Field | Type | Notes |
|---|---|---|
| `tokenAccount` | string | Payer ATA being delegated (base58) |
| `approveTransaction` | string | Base64 signed `approve` transaction for the facilitator to broadcast if no sufficient delegation exists |
| `permitSignature` | string | Base58 Ed25519 signature by `from` over the permit message |

Permit message (Borsh, signed by `from`):

```
nonce_pda: [u8;32]          // PDA(["upto", from, mint, nonce])
mint:      [u8;32]
pay_to:    [u8;32]
facilitator:[u8;32]
max_amount: u64 (le)
valid_after: i64 (le)
expires_at: i64 (le)
```

### 4.3 `SettlementResponse` (in `PAYMENT-RESPONSE`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `success` | boolean | ✓ | |
| `errorReason` | string | – | Omitted on success |
| `payer` | string | – | `from` |
| `transaction` | string | ✓ | Settle (or settle-and-finalize) signature; empty string if the actual charge is `0` |
| `network` | string | ✓ | CAIP-2 |
| `amount` | string | ✓ | Actual base units charged (may be `0`) |

## 5. Phases

### Phase 1 — Setup (gas/approval)

- `payment-channel`: the client builds an `open` transaction depositing
  `maxAmount`. Push: the client broadcasts it and sends `signature`. Pull: the
  client sends `openTransaction` and the facilitator broadcasts it (the
  facilitator may co-sign as fee payer, matching `exact`'s fee-sponsorship).
- `permit`: the client ensures a program-owned delegate is approved on
  `tokenAccount` for at least `maxAmount`. If absent, the facilitator returns
  `412 Precondition Failed` with `errorReason = APPROVAL_REQUIRED` and the
  required `approve` transaction, mirroring EVM's `PERMIT2_ALLOWANCE_REQUIRED`.

### Phase 2 — Authorization signature

- `payment-channel` (normative v1): the client's signature on the `open`
  transaction **is** the authorization — it commits the `deposit` ceiling, the
  `payee`, and the `mint`, with `authorizedSigner` set to the **operator**. The
  client does not sign a voucher. After metering, the operator signs the single
  voucher for `cumulativeAmount = actual` (Ed25519 over
  `channel_id ‖ cumulative_amount_le ‖ expires_at_le`) and settles it. The
  client is protected by the on-chain ceiling (the operator cannot exceed
  `deposit`) and the fixed `payee` (the operator cannot redirect) — the same
  trust model as EVM `upto`, in a single round-trip.
- `permit`: sign the permit message with `from`.

### Phase 3 — Verification (before serving the resource)

The facilitator MUST, in order:

1. Confirm `payload.maxAmount` equals verification-phase `requirements.amount`.
2. Confirm `network`, `asset` (mint), `tokenProgram`, and `payTo` match the requirements.
3. Confirm `feePayer` in `extra` is this server's key.
4. `payment-channel`: confirm the channel exists (or the `openTransaction` is valid and broadcastable), `channel.deposit ≥ maxAmount`, `channel.payee` and `distribution_hash` match `payTo`/`splits`, `channel.status == Open`, and `channel.mint == asset`. `permit`: recover `permitSignature`, confirm signer is `from`; confirm the delegate allowance and the payer token balance both cover `maxAmount`.
5. Validate `validAfter ≤ now ≤ expiresAt`.
6. Simulate the settlement instruction(s).

On failure the server returns `402` (or `412` for the approval/open
precondition) without serving the resource.

### Phase 4 — Settlement (after serving the resource)

At settlement `paymentRequirements.amount` carries the **actual** metered amount.
The facilitator MUST:

1. Re-verify the authorization against the **signed ceiling**
   (`maxAmount` / `deposit`), NOT against `paymentRequirements.amount`.
2. Assert `paymentRequirements.amount ≤ maxAmount`. On violation, fail with
   `invalid_upto_svm_payload_settlement_exceeds_amount`.
3. Execute:
   - `payment-channel`: `settle_and_finalize` with the single voucher for the
     actual cumulative amount, then `distribute` to `payTo`/`splits`. Finalize
     refunds `deposit − actual` to the payer and closes the channel.
   - `permit`: submit the verify+settle transaction; the program checks the
     Ed25519 signature and witness, enforces `actual ≤ maxAmount`, transfers
     `actual` to `payTo`, and consumes the nonce PDA.
4. A `0`-amount settlement requires no transfer. `payment-channel` still
   finalizes (full refund, channel closed); `permit` still consumes the nonce.
   `transaction` MAY be empty when no token movement occurred.

## 6. Error codes

Standard x402 codes apply. Scheme-specific:

- `invalid_upto_svm_payload_settlement_exceeds_amount` — actual > signed ceiling.
- `APPROVAL_REQUIRED` (`permit`, with `412`) — delegate approval missing/insufficient.
- `CHANNEL_REQUIRED` (`payment-channel`, with `412`) — no open channel and no broadcastable `openTransaction`.

## 7. Security properties

- **No overcharge.** `payment-channel`: capped by on-chain `deposit`. `permit`:
  capped by the signed `maxAmount` enforced inside the program.
- **No redirection.** `payment-channel`: `channel.payee`/`distribution_hash`
  fixed at open. `permit`: `payTo` is in the signed message and checked on-chain.
- **No replay.** `payment-channel`: terminal `ChannelStatus::Finalized` plus
  monotonic `SettlementWatermarks.settled`. `permit`: one-shot nonce PDA.
- **Time-bounded.** `validAfter`/`expiresAt` checked off-chain at verify and
  signed into the on-chain message so a stale authorization cannot settle.
- **Trust model.** As in the generic spec, the client trusts the server to meter
  honestly within the ceiling. Everything above the ceiling, the destination,
  and replay are enforced cryptographically/on-chain.

## 8. Out of scope

Multi-settlement streaming and recurring auto-pay are served by the `session`
and `subscription` intents, not `upto`. `upto` settles **at most once** per
authorization.
