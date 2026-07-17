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
  `extra.receiverAuthorizer`; set as channel `authorized_signer`; signs the
  settlement voucher that authorizes any nonzero charge. It does not need to
  hold SOL or token funds, and it never signs a transaction: the voucher
  message binds only values known at build time, so signing it requires no
  fresh blockhash.
- **Facilitator / sponsor**: account advertised as `extra.feePayer`; sponsors
  transaction fees and channel rent by co-signing the channel `open` as
  transaction fee payer and program `rent_payer`, and is set as the channel
  `payee` with a zero share of the distribution. The server MAY
  self-facilitate by using its own key as `feePayer`.

The facilitator-as-zero-share-payee shape splits channel authority in two:

- The facilitator, as `payee`, holds the **lifecycle** authority: it signs
  `settle_and_seal` and can therefore always drive a channel to closure and
  recover the rent it fronted (`settle_and_seal` with `has_voucher = 0`, then
  `distribute`, then `reclaim`), even if the client and server both
  disappear. A client/server pair cannot strand the facilitator's rent by
  leaving a channel open.
- The server, as `authorized_signer`, holds the **payment** authority: every
  nonzero settlement requires a voucher signed by `receiverAuthorizer`, the
  distribution committed at `open` sends 100% of settled funds to `payTo`,
  and the payer refund is program-bound to the client. The facilitator can
  close a channel at its current settled watermark; it cannot redirect funds
  or settle any nonzero amount on its own.

The residual trust assumption is facilitator honesty and liveness at closure:
a facilitator that seals early (`has_voucher = 0`) freezes the watermark, and
the unsettled remainder is refunded to the client. The server MUST therefore
treat unsettled voucher value as facilitator credit risk and settle promptly.
See [Security Properties](#8-security-properties).

## 2. Mapping the five core requirements to SVM

| Requirement (generic spec) | SVM mechanism |
|---|---|
| Single-use authorization | The x402 authorization is a one-request channel. Settlement uses `settle_and_seal` followed by a final `distribute`; after sealing and final distribution, the authorization cannot be used again for `upto`. |
| Time-bound validity (`validAfter`, `expiresAt`) | `expiresAt` is signed by `receiverAuthorizer` into the voucher and enforced by the program (`now < expiresAt`). Although the program supports `expires_at == 0` as no expiry, SVM `upto` MUST reject `expiresAt == 0`. `validAfter` is offchain verify-time policy. Neither value is client-bound; the client signs only `open`. |
| Recipient binding | The `open` transaction fixes `distribution_hash`. For this scheme the distribution is always the single explicit entry `[{ recipient: payTo, bps: 10000 }]`; the channel payee (the facilitator) holds the implicit remainder, which is zero. The program re-checks the distribution at `distribute`. |
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
2. `settle_and_seal`: payee-signed (facilitator-signed) cooperative close. It
   optionally applies the final server voucher, locks the settled watermark,
   and moves the channel to `Sealed`.
3. `distribute`: pays `payTo`, refunds `deposit - actual` to the client, closes
   the escrow token account, and either deallocates the channel PDA immediately
   or marks it `Distributed` until `reclaim` is allowed.
4. `reclaim`: permissionless cleanup for `Distributed` channels once
   `clock.slot > open_slot + OPEN_SLOT_WINDOW`; it returns the remaining PDA
   rent to the recorded `rent_payer`.

The fee/rent sponsor is `extra.feePayer`. It funds the channel PDA and escrow
ATA rent at `open`; that rent is returned to the recorded `rent_payer` during
final cleanup (`distribute` fast path, or later `reclaim`). Because the
sponsor is also the channel `payee`, it never depends on the client or the
server to reach that cleanup: it can seal an abandoned channel itself with a
zero-charge `settle_and_seal` and recover its rent. A sponsor MAY keep a
local channel index, but it MUST be able to rediscover the channels it funded
onchain as specified in [Asynchronous Recovery and Channel Discovery](#6-asynchronous-recovery-and-channel-discovery).
Token payouts and client refunds are not delayed by `reclaim`.

The client has an escape hatch if the server never settles. The client can call
`request_close`, which moves the channel to `Closing` and starts the
`withdrawDelay` grace period fixed at `open`. During that grace period only
the payee — the facilitator — can act: it can still `settle_and_seal`,
carrying the server's final voucher if the server has produced one. The
server cannot rescue an unsettled voucher by itself during `Closing`
(`settle` requires `Open`), so it depends on the facilitator's liveness for
mid-grace settlement. After the grace period, anyone can call `seal`; the
payer can then call `withdraw_payer` to recover `deposit - settled`, and
`distribute`/`reclaim` can finish cleanup.

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
| `feePayer` | string | yes | Base58 sponsor key set as channel `payee` (zero share) and `rent_payer`. Co-signs `open` as transaction fee payer, and signs settlement transactions as both fee payer and channel `payee`. MAY equal `receiverAuthorizer` for self-facilitation. |
| `receiverAuthorizer` | string | yes | Base58 server-controlled key set as channel `authorized_signer`; signs settlement vouchers. |
| `withdrawDelay` | number | yes | Server-defined `grace_period` in seconds. The client MUST encode this exact value in `open`; the verifier MUST reject any other value. MUST be an integer greater than zero. |
| `tokenProgram` | string | yes | `Tokenkeg...` or `TokenzQ...` (Token-2022); the client SHOULD verify it against the onchain mint owner. |
| `recentBlockhash` | string | no | Pre-fetched blockhash so the client can build `openTransaction` without an RPC round trip. |
| `recentSlot` | number | no | Recent slot the client MAY use as `openSlot` when it does not fetch its own slot. The `open` instruction still enforces the program's slot window. |
| `validAfter` | number | no | Earliest activation time (Unix seconds); default = now. |

The x402 wire format does not expose program-specific split arrays. The client
derives the payment-channel accounts and distribution from the x402 fields:

```text
rent_payer = extra.feePayer
payee = extra.feePayer            # facilitator: zero-share payee
authorized_signer = extra.receiverAuthorizer
grace_period = extra.withdrawDelay

recipients = [{ recipient: payTo, bps: 10000 }]
payee_implicit_remainder_bps = 0
```

The explicit single-entry distribution is REQUIRED in all cases, including
when `payTo` equals `extra.receiverAuthorizer` or `extra.feePayer`: the payee
implicit remainder MUST be zero so that the facilitator in the payee seat has
no claim on settled funds.

Any facilitator commercial fee is outside this wire contract or included in the
server's pricing. The channel distribution for `upto` MUST NOT assign any
portion of the settled amount away from `payTo`.

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
    extra.feePayer,           # payee seed slot
    asset,
    extra.receiverAuthorizer, # authorized_signer seed slot
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
- `payee == extra.feePayer`
- `authorized_signer == extra.receiverAuthorizer`
- the single-entry 100% `payTo` distribution specified in section 4.1

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
payment-channels program, deposits `maxAmount`, sets `payee` and `rent_payer`
to `extra.feePayer`, sets `authorized_signer` to `extra.receiverAuthorizer`,
and signs as channel `payer`.

The client sends only a partially signed `openTransaction`. The
server/facilitator validates it, signs it as transaction fee payer and as
program `rent_payer`, broadcasts it during verification, and waits until the
channel account is confirmed `Open` before the protected resource is served.
The open transaction MUST NOT be deferred until settlement.

### Phase 2 - Authorization

The client's signature on `openTransaction` is the client's authorization: it
commits the deposit ceiling, mint, `withdrawDelay`, `openSlot`, and fixed
distribution to `payTo`.

The server's later settlement authorization is separate and voucher-only. For
a nonzero actual amount, the `receiverAuthorizer` key signs the Ed25519
voucher; the facilitator constructs the `settle_and_seal` transaction itself,
signs it as channel `payee` and transaction fee payer, and broadcasts it. The
server never signs a settlement transaction. The voucher signature
authenticates the otherwise unauthenticated facilitator `settle/` HTTP
request: the facilitator MUST NOT settle a nonzero amount unless the
submitted voucher is signed by `receiverAuthorizer`. The zero-charge close
(`has_voucher = 0`) carries no server authorization: it moves no settled
funds, refunds the full deposit to the client, and is the facilitator's own
cleanup authority.

### Phase 3 - Verification (before serving the resource)

#### Client-supplied `openTransaction` acceptance policy

The facilitator adds its `feePayer` signature to transaction bytes constructed
by the client. Before signing, it MUST statically inspect the complete message
and enforce the rules in this section. Simulation or eventual onchain failure
MUST NOT replace these checks: either occurs only after the facilitator's
signature has already authorized the transaction.

These rules apply only to the client-supplied `openTransaction`. The settlement
transaction is constructed by the facilitator and is governed by Phase 4.

##### Message and signer rules

- The message MAY be legacy or version `0`, but it MUST NOT contain Address
  Lookup Table lookups. The canonical `open` fits entirely in static account
  keys, and rejecting lookups ensures that every program and account is visible
  before the facilitator signs.
- The transaction fee payer MUST equal `extra.feePayer`.
- The complete required-signer set MUST equal the distinct addresses in
  `{ payload.from, extra.feePayer }`. No other signature may be required.
- The `payload.from` signature MUST be present and valid before the facilitator
  signs. The facilitator MUST add or replace only its own `extra.feePayer`
  signature slot.
- Outside the canonical `open` account positions defined below,
  `extra.feePayer` MUST NOT appear in any instruction's account list or as an
  invoked program. If two requirements-bound roles intentionally have the same
  address (for example `feePayer == receiverAuthorizer`), each occurrence in
  its prescribed `open` position is permitted.

##### Top-level instruction layout

The top-level instructions MUST consist only of the following ordered regions:

1. An optional Compute Budget prefix containing at most one
   `SetComputeUnitLimit` instruction and at most one `SetComputeUnitPrice`
   instruction. If both are present, `SetComputeUnitLimit` MUST precede
   `SetComputeUnitPrice`.
2. Exactly one payment-channels `open` instruction.
3. An optional suffix of at most three Lighthouse instructions, each invoking
   `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`.

No other top-level instruction or program is allowed. In particular, another
payment-channels instruction, an SPL Memo instruction, an arbitrary wallet
program, or a duplicate `open` MUST cause rejection.

When present, Compute Budget instructions:

- MUST invoke `ComputeBudget111111111111111111111111111111`;
- MUST use only discriminator `2` (`SetComputeUnitLimit`, exactly 5 data bytes)
  or discriminator `3` (`SetComputeUnitPrice`, exactly 9 data bytes);
- MUST set a compute-unit limit no greater than `400000`; and
- MUST set a compute-unit price no greater than `5000000` microlamports per
  compute unit (5 lamports per compute unit).

Lighthouse instructions are allowed only for Phantom/Solflare transaction
assertions and MUST NOT reference `extra.feePayer` as an account. A sponsor MAY
apply a stricter local policy, including rejecting all optional instructions,
but MUST NOT admit instructions outside this allowlist or relax the limits
above.

##### Canonical `open` instruction

The `open` instruction MUST invoke the canonical payment-channels program for
the selected network, use discriminator `1`, contain exactly the following 14
account positions in order, and contain no remaining accounts:

| Position | Account role | Required binding | Required privileges |
|---:|---|---|---|
| 0 | `payer` | `payload.from` | writable, signer |
| 1 | `rent_payer` | `extra.feePayer` | writable, signer |
| 2 | `payee` | `extra.feePayer` | read-only role |
| 3 | `mint` | `requirements.asset` | read-only |
| 4 | `authorized_signer` | `extra.receiverAuthorizer` | read-only role |
| 5 | `channel` | `payload.channelId` | writable |
| 6 | `payer_token_account` | ATA derived from `payload.from`, `asset`, and `extra.tokenProgram` | writable |
| 7 | `channel_token_account` | ATA derived from `payload.channelId`, `asset`, and `extra.tokenProgram` | writable |
| 8 | `token_program` | `extra.tokenProgram` | read-only |
| 9 | `system_program` | `11111111111111111111111111111111` | read-only |
| 10 | `rent` | `SysvarRent111111111111111111111111111111111` | read-only |
| 11 | `associated_token_program` | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | read-only |
| 12 | `event_authority` | canonical event-authority PDA for the payment-channels program | read-only |
| 13 | `self_program` | canonical payment-channels program id | read-only |

Solana message compilation deduplicates equal public keys and unions their
privileges. Therefore a read-only role at position 2 or 4 MAY be effectively
writable and/or a signer when it equals another requirements-bound role (as
`payee == rent_payer` always does in this profile); that expected privilege
union MUST NOT itself cause rejection. No account outside the writable roles in
the table (including an intentional equal-key union) may be writable.

The facilitator MUST fully decode the canonical `open` instruction data, reject
truncated data or trailing bytes, and enforce every field binding defined in
section 4.2, including the exact deposit, salt, open slot, grace period,
distribution, and rederived channel PDA.

The server/facilitator MUST, in order:

1. Confirm `payload.maxAmount` equals verification-phase `requirements.amount`.
2. Confirm `network`, `asset` (mint), `tokenProgram`, and `payTo` match the
   selected requirements.
3. Confirm `extra.feePayer` is the sponsor key that will co-sign the
   transaction, `extra.receiverAuthorizer` is the server's configured receiver
   authorizer, and `extra.withdrawDelay` is an integer greater than zero.
4. Confirm the channel is open:
   - If it does not yet exist, validate `openTransaction` against the complete
     acceptance policy above; then co-sign, broadcast, and wait until the
     channel account is confirmed `Open`.
   - After the channel is open, confirm `channel.deposit == maxAmount` (exact,
     not `>=`: `top_up` can raise an open channel's deposit, so equality keeps
     the x402 ceiling enforced), `channel.status == Open`,
     `channel.mint == asset`,
     `channel.payee == channel.rent_payer == extra.feePayer`,
     `channel.authorized_signer == extra.receiverAuthorizer`,
     `channel.open_slot == payload.openSlot`, and `distribution_hash` matches
     the intended `payTo` distribution.
5. Confirm `payload.channelId` equals the PDA derived from `from`,
   `extra.feePayer`, `asset`, `extra.receiverAuthorizer`, `nonce`, and
   `openSlot` under the canonical program id.
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
3. Require server authorization for any nonzero charge:
   - For `actual > 0`, a voucher signed by `receiverAuthorizer` for
     `cumulativeAmount == actual` and the agreed `expiresAt`.
   - For `actual == 0`, no voucher and no server authorization; the
     `settle_and_seal` instruction uses `has_voucher = 0`.
   In both cases, the `settle_and_seal` transaction MUST be signed by
   `extra.feePayer` as channel `payee`; the server signs nothing but the
   voucher.
4. Sign as transaction `feePayer` and channel `payee`, broadcast the final
   transaction, and confirm a successful `distribute`. The usual bundle is
   Ed25519 precompile (for nonzero actual), `settle_and_seal`, then
   `distribute`.

`settle_and_seal` only locks the settled watermark and moves status to
`Sealed`. `distribute` is the instruction that pays `payTo`, refunds
`deposit - actual` to the payer, closes the escrow token account, and advances
the channel to its cleanup state. `SettlementResponse.transaction` MUST identify
the confirmed transaction containing that final `distribute`.

## 6. Asynchronous Recovery and Channel Discovery

Channel discovery is onchain. A client can discover channels for which it
provided the deposit by querying channel accounts whose `payer` equals the
client key. A facilitator or other fee/rent sponsor can discover every channel
for which it fronted rent by querying accounts whose `rent_payer` (or,
equivalently in this scheme, `payee`) equals its key. A server can query
`authorized_signer` to find channels it is able to settle. Local storage is
therefore an optimization, not the source of truth for channel lifecycle or
rent recovery.

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
| `payee` | 120 | Facilitator/sponsor lifecycle recovery (`payee == feePayer` in this scheme) |
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
   recovered the application metering result and can produce the required
   `receiverAuthorizer` voucher. Otherwise it MUST NOT invent a nonzero
   charge. The facilitator, as payee, may perform the no-voucher, zero-charge
   close path (`settle_and_seal` with `has_voucher = 0`, then `distribute`,
   then `reclaim`) on its own; before doing so it SHOULD apply a
   policy-defined notice or timeout that gives the server a chance to submit
   a final voucher. The client may instead begin its `request_close` escape
   hatch.
4. For a `Closing` channel, schedule a recheck when the recorded grace period
   expires. The facilitator can still `settle_and_seal` during that period,
   carrying the server's final voucher if one exists; after it, the normal
   `seal`, payer withdrawal, and distribution path applies.
5. For a `Sealed` channel, submit or relay the remaining distribution/withdrawal
   actions permitted by the channel state. For a `Distributed` channel, schedule
   `reclaim` after its open-slot reclaim gate. `reclaim` is permissionless, but
   the program returns the recovered SOL rent only to the recorded `rent_payer`.

A fee/rent sponsor has discovery, relay, and lifecycle capability, but no
payment authority: as `payee` it can close a channel at its current settled
watermark, but it cannot create a nonzero settlement or redirect funds — those
require the server-controlled `receiverAuthorizer` voucher and the
distribution committed at `open`. Likewise, onchain recovery does not
reconstruct application-specific
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
- **Authenticated settlement.** A third-party facilitator is `feePayer` /
  `rent_payer` / zero-share `payee`. It cannot sign vouchers, so it cannot
  settle any nonzero amount; that requires the server-controlled
  `receiverAuthorizer`. Its `settle_and_seal` authority only freezes the
  watermark and triggers the program-fixed payout to `payTo` and refund to
  the client.
- **Facilitator rent recovery.** Because the facilitator is the channel
  `payee`, it can always run `settle_and_seal` (`has_voucher = 0`), then
  `distribute`, then `reclaim` on its own. A colluding client/server pair
  cannot strand the facilitator's rent by opening channels and leaving them
  unsealed.
- **Facilitator early-close exposure (server side).** A facilitator that
  seals before the server settles freezes the watermark, and the unsettled
  remainder is refunded to the client — a facilitator colluding with the
  client could claw back payment for a served resource. The server already
  trusts the facilitator to co-sign and broadcast its settlements; this
  extends that trust to settlement liveness. The server MUST bound its
  exposure by settling promptly after serving the resource, and SHOULD treat
  unsettled voucher value as facilitator credit risk. During a
  client-initiated `Closing` grace period, only the facilitator can commit
  the final voucher.
- **No replay.** Vouchers are scoped to `channelId`, monotonic in
  `cumulativeAmount`, and the x402 flow seals and distributes the channel once
  for the request. `openSlot` is part of the channel PDA derivation for the
  current program version.
- **Client gaslessness.** The client supplies the stablecoin deposit and signs
  `open`; `feePayer` signs the transaction and funds SOL fees/rent. The
  verifier MUST enforce the Phase 3 `openTransaction` acceptance policy so the
  client-signed transaction cannot debit `feePayer` beyond fees and the
  intended channel/escrow rent.
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
