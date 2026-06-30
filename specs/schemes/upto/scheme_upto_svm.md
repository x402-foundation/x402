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

A normal signed transfer commits to an *exact* amount
and exact instruction data, so the server cannot lower the amount after the
client signs without invalidating the signature. `upto` therefore requires an
authorization that commits the client to a **ceiling** and lets the
**operator** choose the actual amount at settlement. On SVM this is realized with
an on-chain **payment channel**: the client escrows the ceiling, and the operator
settles the actual amount against it with a single signed voucher.

The **operator** is the party that co-signs the channel `open` as fee payer and
submits settlement — the **server itself, or a facilitator it delegates to**
(advertised as `extra.feePayer`). Nothing in `upto` requires a *separate*
facilitator: a server can self-facilitate, running verify and settle directly.
"Server/facilitator" below denotes whichever fills the operator role.

The operator fills every channel role that must act without the client: the
`open` fee payer and `rentPayer`, the voucher `authorizedSigner`, **and the
channel `payee`** — which the program requires as the `settle_and_finalize`
signer (the program checks `merchant == channel.payee`). The x402 `payTo` (the
resource server's revenue address) is realized as a **program-enforced
distribution split** fixed at `open`: when the server self-facilitates it simply
*is* the operator/payee and receives the settled amount directly; when a
separate facilitator is the operator, `payTo` is a locked split recipient the
facilitator cannot redirect or shortchange (the facilitator MAY keep a fee via
the payee's implicit remainder). This is why a third-party facilitator needs no
program change — see §3 and §5.

## 2. Mapping the five core requirements to SVM

| Requirement (generic spec) | SVM mechanism |
|---|---|
| Single-use authorization | `finalize` makes the channel terminal (`ChannelStatus::Finalized`). |
| Time-bound validity (`validAfter`, `expiresAt`) | `expiresAt` is signed by the operator into the on-chain voucher and enforced by the program (settle rejected once `now ≥ expiresAt`); `validAfter` is off-chain verify-time policy only. Neither is client-bound — the client signs only `open`. |
| Recipient binding | `channel.payee` (the operator) + `distribution_hash` (the `payTo`/`splits`) fixed at open; the program re-checks the splits at `distribute`. |
| Maximum amount enforcement | On-chain `deposit` ceiling, `cumulative_amount ≤ deposit`; the verifier pins `deposit == maxAmount` so the ceiling is exact, not advisory. |
| Phase-dependent amount semantics | `amount` in `PaymentRequirements` is the max during verification and the actual charge during settlement. |

The server/facilitator MUST always verify against the client-signed ceiling,
never against the settlement-time `amount`.

## 3. Payment-channel profile

v1 defines a single profile, `payment-channel`, carried in the payload's
`profile` field. It is backed by the on-chain payment-channels program
(advertised via `extra.channelProgram`). The escrow **deposit is the ceiling**;
a single operator-signed
voucher locks the actual amount via `settle_and_finalize`, and `distribute` then
moves the funds — paying out the `payTo`/`splits`, refunding the unused
`deposit − actual` to the payer, returning the fronted rent to the operator, and
closing (tombstoning) the channel. Note `settle_and_finalize`/`finalize` only
advance channel *status*; the token movement, refund, and close all happen in
`distribute` (the two can be bundled in one transaction).

Strengths: every requirement is enforced on-chain by the program. The operator
cannot overcharge (capped by `deposit`), cannot redirect funds (the `payTo`
split and `distribution_hash` are fixed at open and re-checked by the program at
`distribute`), and cannot replay (channel is terminal after `finalize`).
Conversely, because the operator is the channel `payee` (hence the
`settle_and_finalize` merchant) **and** the voucher `authorizedSigner`, it can
settle and finalize **at any time** — locking the metered amount, refunding the
client's unused deposit, and closing the channel — without the client's
cooperation. The channel-account rent is fronted by the operator: the `open`
instruction's `rentPayer` account (the operator's own key) funds the PDA and
escrow-ATA rent, and `distribute` **returns it to that `rentPayer`** on close —
so the client moves only stablecoin and never needs SOL. The operator can settle
a stale channel at will, reclaiming the rent it fronted; its only exposure is the
cheap settle-and-finalize + distribute transaction.

Cost: the client locks `max` in escrow for the lifetime of the request, and the
flow needs two on-chain transactions (open, then settle-and-finalize). The
channel-account rent is funded by the operator (the `open` `rentPayer` account)
and reclaimed at finalize; the client supplies only the stablecoin deposit and
never needs SOL.

> **Reference-implementation status.** The v1 reference implements the
> **self-facilitating** case (`operator == payTo`), where the operator is both
> the settlement authority (`channel.payee`) and the recipient. Separate-facilitator
> operation — where `payTo` is a program-enforced distribution split and the
> facilitator is the `channel.payee` — is specified (§4.1) but not yet implemented;
> the reference rejects an open whose `payTo` is not the operator.

## 4. Wire format

`upto` reuses the x402 v2 transport: a `402` response carries `PAYMENT-REQUIRED`;
the paid retry carries `PAYMENT-SIGNATURE`; the response carries
`PAYMENT-RESPONSE`. Only the `scheme` value and the payload shape change relative
to `exact`.

### 4.1 `PaymentRequirements` (in `PAYMENT-REQUIRED.accepts[]`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `scheme` | string | ✓ | `"upto"` |
| `network` | string | ✓ | CAIP-2, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet) |
| `amount` | string | ✓ | **Phase-dependent**: max authorized at verification; actual charge at settlement. Base units. |
| `asset` | string | ✓ | SPL mint address (e.g. USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) |
| `payTo` | string | ✓ | Base58 recipient. Realized on-chain as the channel `payee` when the server self-facilitates (`payTo == operator`), or as a program-enforced distribution split when a separate facilitator is the `payee`. |
| `maxTimeoutSeconds` | number | ✓ | Completion window; also the basis for the authorization `expiresAt` |
| `extra` | object | ✓ | See below |

`extra`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `profiles` | string[] | ✓ | `["payment-channel"]` (the only v1 profile) |
| `feePayer` | string | ✓ | Base58 operator key that sponsors fees (co-signs the setup transaction as fee payer) and settles |
| `channelProgram` | string | ✓ | Base58 payment-channels program id. Clients and facilitators MUST reject unsupported program ids for the selected `network`. |
| `tokenProgram` | string | ✓ | `Tokenkeg…` or `TokenzQ…` (Token-2022); the client SHOULD verify it against the on-chain mint owner |
| `recentBlockhash` | string | – | Pre-fetched blockhash so the client can build setup transactions without an extra RPC round-trip |
| `validAfter` | number | – | Earliest activation time (Unix seconds); default = now |
| `splits` | `{recipient,bps}[]` | – | Distribution splits sealed at open; distributed at finalize |

`channelProgram` is discovery, not a trust anchor. The client consumes it to
derive the channel address and build the `open` transaction; the
server/facilitator consumes it to verify and settle the channel. Implementations
MUST maintain a supported-program set per `network` and reject any
`channelProgram` outside that set. The server/facilitator MUST verify that the
`openTransaction`, settlement, and distribution instructions target exactly
`extra.channelProgram`.

### 4.2 `UptoPayload` (in `PAYMENT-SIGNATURE.payload`)

Common fields:

| Field | Type | Notes |
|---|---|---|
| `profile` | string | `"payment-channel"` (the only v1 profile) |
| `from` | string | Payer wallet (base58) |
| `maxAmount` | string | The signed ceiling (base units). MUST equal verification-phase `amount`. |
| `expiresAt` | number | Deadline (Unix seconds); signed into the on-chain message |
| `validAfter` | number | Activation time (Unix seconds) |
| `nonce` | string | Unique per authorization. For `payment-channel`, interpreted as the decimal `u64` `salt` encoded in the `open` instruction. |

Plus the channel fields:

| Field | Type | Notes |
|---|---|---|
| `channelId` | string | Channel PDA (base58), derived before `open` from the fields below |
| `deposit` | string | On-chain escrow = the ceiling; MUST equal `maxAmount` |
| `authorizedSigner` | string | The **operator** key (base58) — the server's or facilitator's pubkey, equal to `extra.feePayer` **and** to `channel.payee`. The operator — not the client — signs the single settlement voucher (see §5 Phase 2); because it is also the channel `payee` (the `settle_and_finalize` merchant) it alone can settle and finalize the channel. |
| `openTransaction` | string | Base64 partially signed `open` transaction. The client signature is present; the operator signature is still required for the transaction fee payer and `rentPayer` before broadcast. |

`channelId` is the program-derived address:

```text
find_program_address(
  [
    "channel",
    from,
    channel_payee,
    asset,
    authorizedSigner,
    u64(nonce).to_le_bytes()
  ],
  extra.channelProgram
)
```

For this profile, `channel_payee == authorizedSigner == extra.feePayer`. Because
the channel address is a PDA, the client knows `channelId` before the channel is
opened. The client MUST derive it before signing `openTransaction`, include the
same PDA as the writable `channel` account in the `open` instruction, and set
`payload.channelId` to that address. The server/facilitator MUST rederive the
PDA from the decoded `openTransaction` and reject the payload if it differs from
either the decoded `channel` account or `payload.channelId`.

> The voucher is **not** carried in the payload. Because the actual amount is
> only known after the resource is consumed, and the client's protection is the
> on-chain `deposit` ceiling plus the fixed `payee`, the operator (set as the
> channel's `authorizedSigner` at open) signs the single voucher for the metered
> amount at settlement. This keeps `upto` a single HTTP round-trip with a
> handler-determined amount: the server fills in `actual ≤ ceiling`.

### 4.3 `SettlementResponse` (in `PAYMENT-RESPONSE`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `success` | boolean | ✓ | |
| `errorReason` | string | – | Omitted on success |
| `payer` | string | – | `from` |
| `transaction` | string | ✓ | Base58 transaction signature (tx hash) for the confirmed transaction that finalizes and distributes the channel. MUST NOT be empty, including when `amount` is `0`. |
| `network` | string | ✓ | CAIP-2 |
| `amount` | string | ✓ | Actual base units charged (may be `0`) |

## 5. Phases

### Phase 1 — Setup

The client builds an `open` transaction depositing `maxAmount`, naming the
operator as the open's `rentPayer` so the operator funds the channel rent (the
client supplies only the stablecoin deposit). Rent is paid during `open`: the
payment-channels program requires the `rentPayer` account to be a signer because
the instruction transfers SOL from that account to fund the channel PDA and
escrow ATA rent. Merely naming the operator as `rentPayer` is not sufficient.

The client therefore sends a partially signed `openTransaction`; the
server/facilitator validates it, co-signs it as transaction fee payer **and** as
`rentPayer`, then broadcasts it (one operator signature covers both, matching
`exact`'s fee-sponsorship). Without the operator signature, the transaction is
invalid and cannot charge rent to the operator.

### Phase 2 — Authorization signature

The client's signature on the `open` transaction **is** the authorization — it
commits the `deposit` ceiling, the `mint`, and the sealed distribution
(`distribution_hash` over `payTo`/`splits`), with `payee` and `authorizedSigner`
set to the **operator**. The client does not sign a voucher. After metering, the
operator signs the single voucher for `cumulativeAmount = actual` (Ed25519 over
`channel_id ‖ cumulative_amount_le ‖ expires_at_le`) and settles it. The client
is protected by the on-chain ceiling (the operator cannot exceed `deposit`) and
the sealed distribution (the operator cannot redirect or shortchange `payTo`),
in a single round-trip.

### Phase 3 — Verification (before serving the resource)

The server/facilitator MUST, in order:

1. Confirm `payload.maxAmount` equals verification-phase `requirements.amount`.
2. Confirm `network`, `asset` (mint), `tokenProgram`, `channelProgram`, and `payTo` match the requirements.
3. Confirm `feePayer` in `extra` is the operator's own key (the server's, or the facilitator's it delegates to).
4. Confirm the channel exists (or the `openTransaction` is valid and broadcastable), targets `extra.channelProgram`, **`channel.deposit == maxAmount`** (exact, not `≥`: `topUp` can raise an open channel's deposit, so only equality keeps the x402 ceiling enforced rather than advisory), `distribution_hash` matches the intended `payTo`/`splits` (so `payTo`'s payout is locked on-chain), `channel.status == Open`, `channel.mint == asset`, **`channel.payee == channel.authorizedSigner == operator`** (so the operator is both the voucher signer and the `settle_and_finalize` merchant, and alone can settle and finalize), and the open's **`rentPayer == operator`** with `rentPayer` marked as a required signer (the operator funds and reclaims the rent it co-signs for). An `open` naming any other payee, authorized signer, or rentPayer, or naming `rentPayer` without requiring the operator signature, MUST be rejected before co-signing.
5. Validate `validAfter ≤ now ≤ expiresAt`.
6. Simulate the settlement instruction(s).

On failure the server returns `402` (or `412` for the approval/open
precondition) without serving the resource.

### Phase 4 — Settlement (after serving the resource)

At settlement `paymentRequirements.amount` carries the **actual** metered amount.
The server/facilitator MUST:

1. Re-verify the authorization against the **signed ceiling**
   (`maxAmount` / `deposit`), NOT against `paymentRequirements.amount`.
2. Assert `paymentRequirements.amount ≤ maxAmount`. On violation, fail with
   `invalid_upto_svm_payload_settlement_exceeds_amount`.
3. `settle_and_finalize` with the single operator-signed voucher for the actual
   cumulative amount — this only locks `settled` and flips status to
   `Finalized`. Then `distribute`, which is what actually pays out
   `payTo`/`splits`, refunds `deposit − actual` to the payer, returns the rent to
   the operator (`rentPayer`), and closes (tombstones) the channel. The two
   instructions MAY be bundled in one transaction. `SettlementResponse.transaction`
   MUST identify the confirmed transaction containing the final `distribute`
   instruction; if settlement and distribution are not bundled, this is the
   `distribute` transaction because it moves the settled `amount` to the sealed
   `payTo`/`splits` distribution and closes the channel.
4. A `0`-amount settlement uses the **no-voucher** path: `settle_and_finalize`
   with `has_voucher = 0` (a `cumulative_amount = 0` voucher is invalid — the
   watermark must advance strictly above the initial `settled = 0`), then
   `distribute` to refund the full deposit and close.
   `SettlementResponse.transaction` MUST be the signature of that confirmed
   close/refund transaction.

## 6. Error codes

Standard x402 codes apply. Scheme-specific:

- `invalid_upto_svm_payload_settlement_exceeds_amount` — actual > signed ceiling.
- `CHANNEL_REQUIRED` (with `412`) — no open channel and no broadcastable `openTransaction`.

## 7. Security properties

- **No overcharge.** Capped by the on-chain `deposit`.
- **No redirection.** `channel.payee` (the operator) and `distribution_hash`
  (the `payTo`/`splits`) are fixed at open and re-checked by the program at
  `distribute`, so the operator cannot redirect or shortchange `payTo`.
- **No replay.** Terminal `ChannelStatus::Finalized` plus monotonic
  `SettlementWatermarks.settled`.
- **No operator griefing.** The operator is the channel `payee` (so it is the
  `settle_and_finalize` merchant, which the program requires to equal
  `channel.payee`) **and** the voucher `authorizedSigner`, so it can always
  settle the metered amount, refund the client's unused deposit, and — via
  `distribute` — close the channel and reclaim the rent it fronted, all without
  the client. The client never needs SOL and cannot strand the operator's funds;
  the operator's only exposure is the settle-and-finalize + distribute
  transaction it elects to send. The server/facilitator MUST reject any `open`
  whose `payee`, `authorizedSigner`, or `rentPayer` is not the operator before
  co-signing (§5 Phase 3).
- **Time-bounded.** `expiresAt` is signed by the operator into the voucher and
  enforced on-chain (the program rejects a settle once `now ≥ expiresAt`);
  `validAfter` is off-chain verify-time policy only. These bind the *operator's*
  voucher rather than the client (who signs only `open`): they bound when a
  metered settlement may land, not a client-side commitment.
- **Trust model.** As in the generic spec, the client trusts the server to meter
  honestly within the ceiling. Everything above the ceiling, the destination,
  and replay are enforced cryptographically/on-chain.

## 8. Out of scope

Multi-settlement streaming — a long-lived channel reused across many requests —
is served by the [`batch-settlement`](../batch-settlement/scheme_batch_settlement_svm.md)
scheme, not `upto`. `upto` settles **at most once** per authorization.
