# SVM `upto` Scheme: Usage-Based Payment Authorization on Solana

> Status: **draft**. Companion to the network-agnostic
> [`scheme_upto.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md)
> and the EVM profile
> [`scheme_upto_evm.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md).
> This document specifies how the `upto` scheme is realized on Solana Virtual
> Machine (SVM) networks.

## 1. Purpose

`upto` lets a client authorize a **maximum** amount while the server settles for
**actual** usage (`actual <= max`), with the final charge determined after the
resource is consumed. Same target use cases as the generic spec: LLM token
billing, per-byte metering, and dynamic compute pricing.

A normal signed SVM transfer commits to an exact amount and exact instruction
data, so the server cannot lower the amount after the client signs without
invalidating the signature. SVM `upto` therefore uses the
[payment-channels program](https://github.com/solana-foundation/payment-channels):
the client escrows the ceiling in an onchain channel, and the server later
settles the actual amount with a signed cumulative voucher.

The x402 roles map to the payment-channel program as follows:

- **Client**: channel `payer`; signs the `open` transaction and funds the
  stablecoin deposit.
- **Server**: resource provider; receives funds at `payTo`; determines the
  actual metered charge after serving the resource.
- **Receiver authorizer**: server-controlled hot key advertised as
  `extra.receiverAuthorizer`; set as both channel `payee` and
  `authorized_signer`; signs the settlement voucher and the cooperative close
  instruction. It does not need to hold SOL or token funds.
- **Facilitator / sponsor**: account advertised as `extra.feePayer`; sponsors
  transaction fees and channel rent by co-signing the channel `open` as
  transaction fee payer and program `rent_payer`. The server MAY self-facilitate
  by using its own key as `feePayer`.

This keeps the facilitator out of the payment authority path. A third-party
facilitator cannot close or refund the channel on its own, because
`settle_and_seal` requires the channel `payee` signature and vouchers must be
signed by `authorized_signer`; in this scheme both are `receiverAuthorizer`.

## 2. Mapping the five core requirements to SVM

| Requirement (generic spec) | SVM mechanism |
|---|---|
| Single-use authorization | The x402 authorization is a one-request channel. Settlement uses `settle_and_seal` followed by a final `distribute`; after sealing and final distribution, the authorization cannot be used again for `upto`. |
| Time-bound validity (`validAfter`, `expiresAt`) | `expiresAt` is signed by `receiverAuthorizer` into the voucher and enforced by the program (`now < expiresAt`). Although the program supports `expires_at == 0` as no expiry, SVM `upto` MUST reject `expiresAt == 0`. `validAfter` is offchain verify-time policy. Neither value is client-bound; the client signs only `open`. |
| Recipient binding | The `open` transaction fixes `distribution_hash`. For this scheme the distribution sends 100% of settled funds to `payTo`, unless `payTo == receiverAuthorizer`, where the channel payee's implicit remainder is sufficient. The program re-checks the distribution at `distribute`. |
| Maximum amount enforcement | Onchain `deposit` is the ceiling and vouchers must satisfy `settled < cumulative_amount <= deposit`; the verifier pins `deposit == maxAmount` so the x402 ceiling is exact, not advisory. |
| Phase-dependent amount semantics | `amount` in `PaymentRequirements` is the max during verification and the actual charge during settlement. |

The facilitator MUST always verify against the client-signed ceiling, never
against the settlement-time `amount`.

## 3. Payment-channel Method

SVM `upto` v1 defines a single payment method backed by the payment-channels
program. Because there is only one method, the wire format does not include an
`extra.assetTransferMethod` discriminator.

The canonical program id is a network/SDK constant, not a server-provided wire
field. For the current mainnet deployment:

```text
CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX
```

Implementations MUST target the canonical payment-channels program id for the
selected `network` and MUST NOT trust or negotiate a `channelProgram` value from
`extra`. Program documentation and instruction references live in the
[payment-channels repository](https://github.com/solana-foundation/payment-channels).

The v1 flow uses these program instructions:

1. `open`: creates a channel PDA, escrows `maxAmount`, stores
   `grace_period == extra.withdrawDelay`, and commits the payout distribution.
2. `settle_and_seal`: payee-signed cooperative close. It optionally applies the
   final voucher, locks the settled watermark, and moves the channel to
   `Sealed`.
3. `distribute`: pays `payTo`, refunds `deposit - actual` to the client, closes
   the escrow token account, and either deallocates the channel PDA immediately
   or marks it `Distributed` until `reclaim` is allowed.
4. `reclaim`: permissionless cleanup for `Distributed` channels once
   `clock.slot > open_slot + OPEN_SLOT_WINDOW`; it returns the remaining PDA
   rent to the recorded `rent_payer`.

The fee/rent sponsor is `extra.feePayer`. It funds the channel PDA and escrow
ATA rent at `open`; that rent is returned to the recorded `rent_payer` during
final cleanup (`distribute` fast path, or later `reclaim`). A sponsor MAY keep a
local channel index, but it MUST be able to rediscover the channels it funded
onchain as specified in [Asynchronous Recovery and Channel Discovery](#6-asynchronous-recovery-and-channel-discovery).
Token payouts and client refunds are not delayed by `reclaim`.

The client has an escape hatch if the server never settles. The client can call
`request_close`, which moves the channel to `Closing` and starts the
`withdrawDelay` grace period fixed at `open`. The server can still
`settle_and_seal` during that grace period. After the grace period, anyone can
call `seal`; the payer can then call `withdraw_payer` to recover
`deposit - settled`, and `distribute`/`reclaim` can finish cleanup.

## 4. Wire Format

`upto` reuses the x402 v2 transport: a `402` response carries
`PAYMENT-REQUIRED`; the paid retry carries `PAYMENT-SIGNATURE`; the response
carries `PAYMENT-RESPONSE`. Only the `scheme` value and payload shape differ
from `exact`.

### 4.1 `PaymentRequirements` (in `PAYMENT-REQUIRED.accepts[]`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `scheme` | string | yes | `"upto"` |
| `network` | string | yes | CAIP-2, e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| `amount` | string | yes | Phase-dependent: max authorized at verification; actual charge at settlement. Base units. |
| `asset` | string | yes | SPL mint address, e.g. USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `payTo` | string | yes | Base58 final payment recipient. This is normally a server cold wallet, not the hot `receiverAuthorizer`. |
| `maxTimeoutSeconds` | number | yes | Completion window; basis for `expiresAt` |
| `extra` | object | yes | See below |

`extra`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `feePayer` | string | yes | Base58 sponsor key that co-signs `open` as transaction fee payer and channel `rent_payer`, and co-signs settlement transactions as fee payer. MAY equal `receiverAuthorizer` for self-facilitation. |
| `receiverAuthorizer` | string | yes | Base58 server-controlled key set as channel `payee` and `authorized_signer`; signs vouchers and `settle_and_seal`. |
| `withdrawDelay` | number | yes | Server-defined `grace_period` in seconds. The client MUST encode this exact value in `open`; the verifier MUST reject any other value. MUST be an integer greater than zero. |
| `tokenProgram` | string | yes | `Tokenkeg...` or `TokenzQ...` (Token-2022); the client SHOULD verify it against the onchain mint owner. |
| `recentBlockhash` | string | no | Pre-fetched blockhash so the client can build `openTransaction` without an RPC round trip. |
| `recentSlot` | number | no | Recent slot the client MAY use as `openSlot` when it does not fetch its own slot. The `open` instruction still enforces the program's slot window. |
| `validAfter` | number | no | Earliest activation time (Unix seconds); default = now. |

The x402 wire format does not expose program-specific split arrays. The client
derives the payment-channel accounts and distribution from the x402 fields:

```text
rent_payer = extra.feePayer
payee = extra.receiverAuthorizer
authorized_signer = extra.receiverAuthorizer
grace_period = extra.withdrawDelay

if payTo == extra.receiverAuthorizer:
  recipients = []
  payee_implicit_remainder_bps = 10000
else:
  recipients = [{ recipient: payTo, bps: 10000 }]
  payee_implicit_remainder_bps = 0
```

Any facilitator commercial fee is outside this wire contract or included in the
server's pricing. The channel distribution for `upto` MUST NOT assign any
portion of the settled amount away from `payTo`, except when `payTo` is itself
the channel payee via the implicit remainder path above.

Example: server self-facilitates while using a hot receiver key and cold payout
wallet:

```json
{
  "scheme": "upto",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "10000",
  "asset": "<mint>",
  "payTo": "<server-cold-wallet>",
  "maxTimeoutSeconds": 300,
  "extra": {
    "feePayer": "<server-hot-wallet>",
    "receiverAuthorizer": "<server-hot-wallet>",
    "withdrawDelay": 3600,
    "tokenProgram": "<token-program>",
    "recentBlockhash": "<cached>",
    "recentSlot": 341000000
  }
}
```

Example: server uses an external facilitator for fee/rent sponsorship:

```json
{
  "scheme": "upto",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "10000",
  "asset": "<mint>",
  "payTo": "<server-cold-wallet>",
  "maxTimeoutSeconds": 300,
  "extra": {
    "feePayer": "<facilitator>",
    "receiverAuthorizer": "<server-hot-wallet>",
    "withdrawDelay": 3600,
    "tokenProgram": "<token-program>",
    "recentBlockhash": "<cached>",
    "recentSlot": 341000000
  }
}
```

### 4.2 `UptoPayload` (in `PAYMENT-SIGNATURE.payload`)

| Field | Type | Notes |
|---|---|---|
| `from` | string | Payer wallet (base58). |
| `maxAmount` | string | Signed ceiling in base units. MUST equal verification-phase `amount`. |
| `expiresAt` | number | Nonzero deadline (Unix seconds); signed into the server voucher. |
| `validAfter` | number | Activation time (Unix seconds). |
| `nonce` | string | Unique decimal `u64` salt encoded in the `open` instruction. |
| `openSlot` | number | `u64` slot encoded in the `open` instruction and used as a channel PDA seed. |
| `channelId` | string | Channel PDA (base58), derived before `open` from the fields below. |
| `deposit` | string | Onchain escrow amount. MUST equal `maxAmount`. |
| `authorizedSigner` | string | MUST equal `extra.receiverAuthorizer`; included for explicit payload validation. |
| `openTransaction` | string | Base64 partially signed `open` transaction. The client signature is present; the `feePayer`/`rent_payer` signature is still required before broadcast. |

`channelId` is the program-derived address:

```text
find_program_address(
  [
    "channel",
    from,
    extra.receiverAuthorizer,
    asset,
    extra.receiverAuthorizer,
    u64(nonce).to_le_bytes(),
    u64(openSlot).to_le_bytes()
  ],
  CANONICAL_PAYMENT_CHANNELS_PROGRAM_ID
)
```

The client MUST derive `channelId` before signing `openTransaction`, include the
same PDA as the writable `channel` account in the `open` instruction, and set
`payload.channelId` to that address. The server/facilitator MUST rederive the
PDA from the decoded `openTransaction` and reject the payload if it differs from
either the decoded `channel` account or `payload.channelId`.

The `open` instruction MUST encode:

- `salt == u64(payload.nonce)`
- `deposit == payload.maxAmount`
- `grace_period == extra.withdrawDelay`
- `open_slot == payload.openSlot`
- `rent_payer == extra.feePayer`
- `payee == extra.receiverAuthorizer`
- `authorized_signer == extra.receiverAuthorizer`
- the distribution derived from `payTo` as specified in section 4.1

The voucher is not carried in the client payload. After metering, the server
signs an Ed25519 voucher with `receiverAuthorizer`. The signed message is:

```text
0x56 0x01 || channelId || u64(cumulativeAmount).le || i64(expiresAt).le
```

where `cumulativeAmount == actual` for `upto`. The voucher is supplied to the
program through the Ed25519 native-program instruction immediately preceding
`settle_and_seal`.

### 4.3 `SettlementResponse` (in `PAYMENT-RESPONSE`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `success` | boolean | yes |  |
| `errorReason` | string | no | Omitted on success. |
| `payer` | string | no | `from`. |
| `transaction` | string | yes | Base58 transaction signature for the confirmed transaction containing the final `distribute` instruction. MUST NOT be empty, including when `amount` is `0`. |
| `network` | string | yes | CAIP-2. |
| `amount` | string | yes | Actual base units charged, which MAY be `0`. |

If final `distribute` marks the channel `Distributed` because the reclaim gate
has not elapsed, the later `reclaim` transaction is not the x402 settlement
transaction. `distribute` is sufficient for x402 success because it moves the
settled funds, refunds the client, and closes the escrow token account.

## 5. Phases

### Phase 1 - Setup

The server returns `feePayer`, `receiverAuthorizer`, and `withdrawDelay` in the
402 response. The client builds an `open` transaction against the canonical
payment-channels program, deposits `maxAmount`, sets `rent_payer` to
`extra.feePayer`, sets `payee` and `authorized_signer` to
`extra.receiverAuthorizer`, and signs as channel `payer`.

The client sends only a partially signed `openTransaction`. The
server/facilitator validates it, signs it as transaction fee payer and as
program `rent_payer`, broadcasts it during verification, and waits until the
channel account is confirmed `Open` before the protected resource is served.
The open transaction MUST NOT be deferred until settlement.

### Phase 2 - Authorization

The client's signature on `openTransaction` is the client's authorization: it
commits the deposit ceiling, mint, `withdrawDelay`, `openSlot`, and fixed
distribution to `payTo`.

The server's later settlement authorization is separate. The
`receiverAuthorizer` key signs the voucher for the actual amount and signs the
`settle_and_seal` transaction. That transaction may be constructed by the server
or by the facilitator, but the `receiverAuthorizer` signature MUST cover the
`settle_and_seal` instruction before the facilitator co-signs and broadcasts.
This signature also authenticates the otherwise unauthenticated facilitator
`settle/` HTTP request: the facilitator MUST NOT settle, seal, or refund a
channel unless the submitted settlement is authorized by `receiverAuthorizer`.

### Phase 3 - Verification (before serving the resource)

The server/facilitator MUST, in order:

1. Confirm `payload.maxAmount` equals verification-phase `requirements.amount`.
2. Confirm `network`, `asset` (mint), `tokenProgram`, and `payTo` match the
   selected requirements.
3. Confirm `extra.feePayer` is the sponsor key that will co-sign the
   transaction, `extra.receiverAuthorizer` is the server's configured receiver
   authorizer, and `extra.withdrawDelay` is an integer greater than zero.
4. Confirm the channel is open:
   - If it does not yet exist, validate that `openTransaction` targets the
     canonical payment-channels program, names `rent_payer == extra.feePayer`
     with `rent_payer` marked as a required signer, names
     `payee == authorized_signer == extra.receiverAuthorizer`, encodes
     `grace_period == extra.withdrawDelay`, encodes
     `open_slot == payload.openSlot`, seals the distribution derived from
     `payTo`, and is otherwise valid for the requirements; then co-sign,
     broadcast, and wait until the channel account is confirmed `Open`.
   - After the channel is open, confirm `channel.deposit == maxAmount` (exact,
     not `>=`: `top_up` can raise an open channel's deposit, so equality keeps
     the x402 ceiling enforced), `channel.status == Open`,
     `channel.mint == asset`, `channel.rent_payer == extra.feePayer`,
     `channel.payee == channel.authorized_signer == extra.receiverAuthorizer`,
     `channel.open_slot == payload.openSlot`, and `distribution_hash` matches
     the intended `payTo` distribution.
5. Confirm `payload.channelId` equals the PDA derived from `from`, `asset`,
   `extra.receiverAuthorizer`, `nonce`, and `openSlot` under the canonical
   program id.
6. Validate `validAfter <= now < expiresAt` and reject `expiresAt == 0`.
7. Simulate the expected settlement instructions before accepting the payment.

On failure the server returns `402` (or `412` for the open precondition) without
serving the resource.

### Phase 4 - Settlement (after serving the resource)

At settlement, `paymentRequirements.amount` carries the actual metered amount.
The server/facilitator MUST:

1. Re-verify the authorization against the signed ceiling (`maxAmount` /
   `deposit`), not against `paymentRequirements.amount`.
2. Assert `paymentRequirements.amount <= maxAmount`. On violation, fail with
   `invalid_upto_svm_payload_settlement_exceeds_amount`.
3. Require server authorization from `receiverAuthorizer`:
   - For `actual > 0`, a voucher signed by `receiverAuthorizer` for
     `cumulativeAmount == actual` and the agreed `expiresAt`.
   - For `actual == 0`, no voucher; the `settle_and_seal` instruction uses
     `has_voucher = 0`.
   In both cases, the `settle_and_seal` transaction MUST be signed by
   `receiverAuthorizer` as channel `payee`.
4. Co-sign as transaction `feePayer`, broadcast the final transaction, and
   confirm a successful `distribute`. The usual bundle is Ed25519 precompile
   (for nonzero actual), `settle_and_seal`, then `distribute`.

`settle_and_seal` only locks the settled watermark and moves status to
`Sealed`. `distribute` is the instruction that pays `payTo`, refunds
`deposit - actual` to the payer, closes the escrow token account, and advances
the channel to its cleanup state. `SettlementResponse.transaction` MUST identify
the confirmed transaction containing that final `distribute`.

## 6. Asynchronous Recovery and Channel Discovery

Channel discovery is onchain. A client can discover channels for which it
provided the deposit by querying channel accounts whose `payer` equals the
client key. A facilitator or other fee/rent sponsor can discover every channel
for which it fronted rent by querying accounts whose `rent_payer` equals its
key. A server can similarly query `payee` or `authorized_signer` to find
channels it is able to settle. Local storage is therefore an optimization, not
the source of truth for channel lifecycle or rent recovery.

Implementations MAY retain a local index for request correlation, worker leases,
and response history. They MUST be able to rebuild the onchain portion of that
index after local state loss, including at worker startup and periodically while
they sponsor rent or operate channels.

### 6.1 Discovery RPC

Implementations MUST use `getProgramAccounts` against the canonical
payment-channels program for the selected network. The channel account layout
targeted by this version is fixed at 256 bytes. Its public-key field offsets are:

| Channel field | Offset | Discovery use |
|---|---:|---|
| `payer` | 88 | Client deposit/channel recovery |
| `payee` | 120 | Server/operator channel recovery |
| `authorized_signer` | 152 | Server settlement-authority recovery |
| `rent_payer` | 216 | Facilitator/sponsor rent recovery |

For example, a facilitator discovers channels for which it paid rent using a
base58-encoded public key in a `memcmp` filter:

```json
{
  "encoding": "base64",
  "commitment": "confirmed",
  "filters": [
    { "dataSize": 256 },
    { "memcmp": { "offset": 216, "bytes": "<feePayer>" } }
  ]
}
```

The client uses the same request with `offset: 88` and its payer key. An
implementation MAY add one of the other listed filters to narrow its result
set. It MUST decode each returned account with the program's supported channel
codec and reject an account whose owner, discriminator, version, length, or PDA
does not match the selected program and its decoded channel fields. In
particular, the implementation MUST rederive the PDA from `payer`, `payee`,
`mint`, `authorized_signer`, `salt`, and `open_slot` before treating the account
as a recovered channel. Implementations MUST NOT rely on these byte offsets for
an unsupported future channel-account version.

### 6.2 Asynchronous recovery flow

The scan is asynchronous maintenance work, not part of the paid HTTP request.
An implementation that has lost its local state, or that resumes after a
restart, MUST perform the following flow:

1. Query and decode its matching channel accounts as described above, then
   upsert the validated account address and its current status into a local work
   queue. The queue is disposable; a later scan is always able to reconstruct
   it from chain state.
2. Before submitting an action, refetch the channel and revalidate its status.
   Multiple workers and normal user activity can change a channel between the
   scan and submission. A transition failure caused by stale state MUST cause
   the worker to refetch and reclassify the channel, rather than assuming that
   cleanup failed.
3. For an `Open` channel, the server may resume settlement only when it has
   recovered the application metering result and can obtain the required
   `receiverAuthorizer` signatures. Otherwise it MUST NOT invent a nonzero
   charge. The server may perform the no-voucher, zero-charge close path; the
   client may instead begin its `request_close` escape hatch.
4. For a `Closing` channel, schedule a recheck when the recorded grace period
   expires. The server can still settle during that period; after it, the normal
   `seal`, payer withdrawal, and distribution path applies.
5. For a `Sealed` channel, submit or relay the remaining distribution/withdrawal
   actions permitted by the channel state. For a `Distributed` channel, schedule
   `reclaim` after its open-slot reclaim gate. `reclaim` is permissionless, but
   the program returns the recovered SOL rent only to the recorded `rent_payer`.

A fee/rent sponsor has discovery and relay capability, not payment authority:
it cannot create a nonzero settlement or close a channel by itself without the
server-controlled `receiverAuthorizer` authorization required elsewhere in this
spec. Likewise, onchain recovery does not reconstruct application-specific
metering, request/response correlation, or an unpersisted settlement voucher.
Those records MAY be kept offchain; if they are lost, the server MUST take the
conservative no-charge or client-initiated close path rather than charging based
on a guess.

## 7. Error Codes

Standard x402 codes apply. Scheme-specific:

- `invalid_upto_svm_payload_settlement_exceeds_amount` - actual amount exceeds
  the signed ceiling.
- `CHANNEL_REQUIRED` (with `412`) - no open channel and no valid
  `openTransaction` that can be co-signed, broadcast, and confirmed before
  serving the resource.

## 8. Security Properties

- **No overcharge.** Capped by the onchain `deposit`; verifier requires
  `deposit == maxAmount`.
- **No redirection.** The distribution fixed at `open` sends settled funds to
  `payTo`, and the program re-checks `distribution_hash` at `distribute`.
- **Authenticated settlement.** A third-party facilitator is only `feePayer` /
  `rent_payer`. It cannot sign vouchers or `settle_and_seal`; those require the
  server-controlled `receiverAuthorizer`.
- **No replay.** Vouchers are scoped to `channelId`, monotonic in
  `cumulativeAmount`, and the x402 flow seals and distributes the channel once
  for the request. `openSlot` is part of the channel PDA derivation for the
  current program version.
- **Client gaslessness.** The client supplies the stablecoin deposit and signs
  `open`; `feePayer` signs the transaction and funds SOL fees/rent. The
  verifier MUST ensure the client-signed `open` cannot debit `feePayer` beyond
  fees and the intended channel/escrow rent.
- **Client escape hatch.** `withdrawDelay` is server-defined and fixed at
  `open`. If the server does not settle, the payer can start forced close with
  `request_close`, wait the grace period, then recover unspent deposit through
  `seal` and `withdraw_payer` / `distribute`.
- **Time-bounded settlement.** `expiresAt` is enforced by the program for
  nonzero vouchers; `validAfter` is offchain verification policy. These bound
  when a metered settlement may land, but they are not client-signed terms.
- **Metering trust.** As in the generic `upto` spec, the client trusts the
  server to meter honestly within the ceiling. The ceiling, recipient, and
  replay properties are enforced by signatures and the onchain program.

## 9. Out of Scope

Multi-settlement streaming or long-lived channels reused across many requests
are served by [`batch-settlement`](../batch-settlement/scheme_batch_settlement.md)
or a session-oriented payment-channel protocol, not `upto`. `upto` settles at
most once per authorization.
