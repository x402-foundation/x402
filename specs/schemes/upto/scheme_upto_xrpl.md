# Upto Payment Scheme for XRP Ledger (XRPL) (`upto`)

> Status: **draft**. Companion to the network-agnostic
> [`scheme_upto.md`](./scheme_upto.md), the EVM profile
> [`scheme_upto_evm.md`](./scheme_upto_evm.md) and the SVM profile
> [`scheme_upto_svm.md`](./scheme_upto_svm.md).

This document specifies the `upto` payment scheme for the x402 protocol v2 on the XRP
Ledger.

`upto` authorizes a transfer of up to a maximum amount; the actual charge is determined
at settlement from measured consumption. XRPL realizes it with Payment Channels, a
native ledger primitive: the payer escrows the ceiling in a channel and signs one
off-ledger claim, and the destination later claims the actual amount and closes the
channel, refunding the remainder.

## Scheme Name

`upto`

## Payment Model

| Aspect                    | Description                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Payment authorization** | The payer opens a `PayChannel` funded to at least the maximum and signs an off-ledger claim over `(channelId, maxAmount)` |
| **Settlement**            | The facilitator submits a `PaymentChannelClaim`, signed by the `payTo` account, carrying the actual amount and `tfClose`  |
| **Fee payer**             | The payer pays the channel-creation fee; the `payTo` account pays the settlement fee                                      |

The channel is opened before the payment is presented, as the `ticketSequence` asset
transfer method of [`scheme_exact_xrpl.md`](../exact/scheme_exact_xrpl.md) requires a
preflight `TicketCreate`.

XRPL charges a transaction fee to the transaction `Account`, and has no mechanism for a
second account to co-sign and pay for another account's transaction, so neither the
channel creation nor the settlement can be fee-sponsored by a facilitator. The `Sponsor`
amendment (XLS-68) would change this but is not enabled on Mainnet. `extra.areFeesSponsored`
is therefore always `false`, as in `scheme_exact_xrpl.md`.

No account sequence number is held between verification and settlement: the
authorization is the channel, so a payer may send other transactions from the same
account while the metered work runs without invalidating the payment.

## Network Identifier (CAIP-2)

| Network | Identifier |
| ------- | ---------- |
| Mainnet | `xrpl:0`   |
| Testnet | `xrpl:1`   |
| Devnet  | `xrpl:2`   |

Network identifiers MUST be canonical (`xrpl:1`, not `xrpl:01`): the duplicate-settlement
key below is derived from the network string, and a non-canonical identifier would form a
second, independent key for one channel.

> [!WARNING]
> A channel id is `SHA512Half(0x0078, source, destination, sequence)` and the signed claim
> covers only `(channelId, amount)`, so neither carries a network identifier. The same
> account pair at the same sequence yields the same channel id on every network, and one
> signed claim verifies against all of them. Wallets SHOULD use separate XRPL accounts for
> mainnet, testnet and devnet x402 payments.

## Asset

XRP only. `PaymentChannelCreate.Amount` is a drops string; the ledger rejects an
issued-currency amount with `temBAD_AMOUNT`. `asset` MUST be `"XRP"` and all amounts are
drops. A facilitator MAY reject an amount it cannot verify without loss of precision.

## Protocol Flow

The protocol flow for `upto` on XRPL is client-driven, and follows the `authorization`
payment flow of the v2 specification: verification, then the metered work, then
settlement.

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with `PaymentRequired` in the `PAYMENT-REQUIRED` header,
   with `amount` set to the maximum it may charge.
3. **Client** submits a `PaymentChannelCreate` to `payTo` with `Amount` set to that
   maximum, a `CancelAfter` expiry and a `SettleDelay` sized per verification rule 7.
4. **Client** signs an off-ledger claim over `(channelId, maxAmount)`. This is not a
   ledger transaction.
5. **Client** sends a new request with the `PAYMENT-SIGNATURE` header containing the
   `PaymentPayload`.
6. **Resource Server** forwards the payload and requirements to a **Facilitator**'s
   `/verify` endpoint, with `amount` still set to the maximum.
7. **Resource Server**, upon successful verification, runs the metered work and measures
   the actual consumption.
8. **Resource Server** signs a `PaymentChannelClaim` for the actual amount and calls the
   facilitator's `/settle` endpoint with `amount` set to that actual charge and the signed
   claim added to the payment payload as `settlementTransaction`.
9. **Facilitator** re-verifies, submits the claim, and confirms it succeeded in a
   validated ledger.
10. **Facilitator** responds with a `SettlementResponse` carrying the settled amount.
11. **Resource Server** grants access via the `PAYMENT-RESPONSE` header.

## x402 v2 Headers

| Direction                    | Header              | Content                                 |
| ---------------------------- | ------------------- | --------------------------------------- |
| Server -> Client (challenge) | `PAYMENT-REQUIRED`  | Base64-encoded JSON `PaymentRequired`   |
| Client -> Server (payment)   | `PAYMENT-SIGNATURE` | Base64-encoded JSON `PaymentPayload`    |
| Server -> Client (result)    | `PAYMENT-RESPONSE`  | Base64-encoded JSON settlement response |

## `PaymentRequirements` for `upto`

`amount` is phase-dependent, per [`scheme_upto.md`](./scheme_upto.md): the maximum the
client must authorize at verification, and the actual amount to charge at settlement.

### Verify-time Example

```json
{
  "scheme": "upto",
  "network": "xrpl:1",
  "asset": "XRP",
  "payTo": "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  "amount": "10000000",
  "maxTimeoutSeconds": 300,
  "extra": {
    "areFeesSponsored": false,
    "minSettleDelay": 600,
    "validAfter": 1754136000
  }
}
```

### Settle-time Example

```json
{
  "scheme": "upto",
  "network": "xrpl:1",
  "asset": "XRP",
  "payTo": "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  "amount": "2470000",
  "maxTimeoutSeconds": 300,
  "extra": {
    "areFeesSponsored": false,
    "minSettleDelay": 600,
    "validAfter": 1754136000
  }
}
```

### Field Definitions

| Field                         | Type    | Required    | Description                                                                                     |
| ----------------------------- | ------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `extra.areFeesSponsored`      | boolean | yes         | Always `false`; XRPL cannot sponsor either transaction                                          |
| `extra.minSettleDelay`        | number  | no          | Minimum `SettleDelay` the channel must carry, in seconds                                        |
| `extra.validAfter`            | number  | no          | Earliest activation time, Unix seconds                                                          |

## `PaymentPayload` for `upto`

```json
{
  "x402Version": 2,
  "scheme": "upto",
  "network": "xrpl:1",
  "accepted": {
    "scheme": "upto",
    "network": "xrpl:1",
    "asset": "XRP",
    "payTo": "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    "amount": "10000000",
    "maxTimeoutSeconds": 300,
    "extra": {
      "areFeesSponsored": false,
      "minSettleDelay": 600,
      "validAfter": 1754136000
    }
  },
  "payload": {
    "channelId": "C93B7DF84AC3F2C2BB69C88917451FA3980472DABEF8FFA461A0B1563BEF71AF",
    "maxAmount": "10000000",
    "signature": "496630507166941E8D6C693B0E8A45276DD6BD60...",
    "publicKey": "ED9434799226374926EDA3B54B1B461B4ABF7237962EAE18528FEA67595397FA32",
    "payer": "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH"
  }
}
```

| Field       | Description                                                                 |
| ----------- | --------------------------------------------------------------------------- |
| `channelId` | The `PayChannel` ledger object index, 64 hexadecimal characters             |
| `maxAmount` | Drops authorized by `signature`. MUST equal the verification-phase `amount` |
| `signature` | The payer's off-ledger claim signature over `(channelId, maxAmount)`        |
| `publicKey` | Channel `PublicKey`, against which the claim verifies                       |
| `payer`     | Channel `Account`                                                           |

At settle time the resource server adds one field to the payload before calling
`/settle`:

| Field                   | Description                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `settlementTransaction` | Hex blob of the `PaymentChannelClaim` signed by `payTo`; see [Settlement](#settlement) |

The field is server-authored and settle-only. It MUST be absent from the client's
`PAYMENT-SIGNATURE`, and a facilitator MUST reject a payment presenting it at `/verify`
with `invalid_upto_xrpl_payload_unexpected_settlement_transaction`.

## `SettlementResponse`

```json
{
  "success": true,
  "transaction": "6581DD581A6585E4DFBB...",
  "network": "xrpl:1",
  "payer": "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH",
  "amount": "2470000"
}
```

`amount` carries the settlement-time charge, delivered in full through the channel once
the settlement validates, and MAY be `"0"`. `transaction` is the hash
of the validated `PaymentChannelClaim`, including a zero settlement, which is still an
on-ledger close.

## Account Requirements

| Role            | Requirement                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client          | XRP for the channel `Amount`, the creation fee, and the owner reserve (currently `0.2 XRP` on Mainnet, subject to validator fee voting) held while the channel is open |
| Resource server | An XRPL account at `payTo`, funded for the settlement fee, whose key signs the settlement claim                                                                        |
| Facilitator     | An RPC endpoint. It holds no key and pays no fee                                                                                                                       |

The resource server needs an RPC endpoint to build the settlement claim, since the claim
carries a `LastLedgerSequence` derived from current ledger state.

## Facilitator Verification Rules (MUST)

At `/verify` the facilitator reads the `PayChannel` object from a validated ledger and
MUST reject unless all of the following hold. There is no transaction to simulate: the
authorization is an off-ledger claim, and these validated-ledger checks stand in for
simulation by establishing that a claim against this channel would succeed.

1. **Envelope** - `x402Version` is `2`, `scheme` is `"upto"` and `network` is a canonical
   XRPL identifier on both the accepted and required terms, and the accepted terms equal
   the required terms field by field: `asset`, `amount`, `payTo`, `maxTimeoutSeconds`,
   `extra.areFeesSponsored`, `extra.minSettleDelay` and `extra.validAfter`. Otherwise a
   client can echo terms it never agreed to. `maxTimeoutSeconds` MUST be a positive
   integer and `amount` canonical drops; a present `minSettleDelay` or `validAfter` MUST
   be a non-negative integer. A malformed value MUST be rejected rather than treated as
   absent, and an absent one MUST be accepted whether omitted or null.
2. **Channel** - the ledger object exists and is a `PayChannel`.
3. **Recipient and payer binding** - `PayChannel.Destination` equals `payTo`, and
   `PayChannel.Account` equals `payload.payer`.
4. **Maximum** - `payload.maxAmount` equals `paymentRequirements.amount` exactly and is
   no greater than `PayChannel.Amount`. The channel MAY hold more than the maximum, since
   `PaymentChannelFund` can raise `Amount` at any time and the signed claim, not the
   deposit, is what caps settlement.
5. **Claim signature** - `payload.publicKey` equals `PayChannel.PublicKey`, and
   `payload.signature` verifies against it over the claim signing message: the four-byte
   hash prefix `CLM\0` (`0x434C4D00`), the 32-byte channel id, and `maxAmount` as a
   big-endian unsigned 64-bit drops value, concatenated in that order. rippled's
   `channel_verify` RPC and xrpl.js `verifyPaymentChannelClaim` are reference verifiers
   of this message; note that `channel_verify` takes the amount in drops while
   `verifyPaymentChannelClaim` takes XRP and converts. The check MUST run here rather
   than be deferred to the ledger: a resource server that trusts `/verify` runs its
   metered work before `/settle` is called, so an unverified authorization lets a
   client obtain the metered work for free.
   For a secp256k1 key the signature MUST be fully canonical (low-`s`). XRPL signing
   produces canonical signatures, and rippled rejects a non-canonical claim signature, so
   a facilitator verifying with a generic library MUST enforce this rather than assume it.
6. **Unclaimed** - `PayChannel.Balance` is `0`. The scheme is single-use.

   A validated-ledger read cannot see a concurrent use: two in-flight payments
   presenting the same channel both pass this rule, both metered works run, and only
   one claim can settle, so the payer obtains the other work free. The
   duplicate-settlement guard below protects settlement only, not this window. A
   resource server SHOULD NOT run metered work concurrently against one channel id.

   A facilitator SHOULD also keep an advisory in-flight entry on `(network, channelId)`,
   checked and taken atomically when verification succeeds, and refuse a verification
   that finds a live entry. Once a settlement attempt arrives the entry follows the
   release rules of the duplicate-settlement entry below, whose verify-side twin it is;
   if none arrives, it expires `maxTimeoutSeconds` plus the landing margin of rule 7
   after verification. It sees only one facilitator's traffic: two payments verifying
   through different facilitators still pass, so the resource-server rule above remains
   the primary control.
7. **Time bound** - `PayChannel.CancelAfter` is present and at least
   `maxTimeoutSeconds` plus a landing margin beyond the validated ledger's close time,
   `PayChannel.Expiration` is unset, and `PayChannel.SettleDelay` is at least
   `maxTimeoutSeconds` plus that margin, and at least `extra.minSettleDelay`.
   `SettleDelay` must cover the work as well as the landing: a shorter delay would let
   the payer schedule a close mid-work and expire the channel under the claim the work
   has earned, the same free close an expired `CancelAfter` produces.
   If `extra.validAfter` is present the payment MUST
   be rejected while the ledger close time is before it. Time is compared against the
   validated ledger's `close_time`, not the facilitator's wall clock, because
   `CancelAfter` is expressed on the ledger's clock; `validAfter` is Unix seconds and MUST
   be converted.

   `CancelAfter` is required as the authorization's end bound, not as payer
   protection: the payer can always schedule its own exit, since a source-initiated
   `tfClose` sets `Expiration` to `SettleDelay` from now, but without `CancelAfter`
   the signed claim stays redeemable indefinitely, and
   [`scheme_upto.md`](./scheme_upto.md) requires explicit time bounds on every
   authorization and places open-ended allowances out of scope. The cost of
   carrying the bound is the expired-channel close described under
   [Settlement](#settlement), which the settle-time headroom re-check exists to
   catch.

   The landing margin covers the ledgers a settlement takes to land, and is fixed at
   **20 seconds**: two ledger closes at a pessimistic 10-second rate. The margin is an
   admission floor, not a landing guarantee: degraded consensus can close ledgers more
   slowly than it assumes, and the settlement transaction's `LastLedgerSequence` window
   is what bounds the actual wait. A facilitator
   MUST NOT demand more headroom than this rule states, so that a channel built
   against the spec verifies against any facilitator. A client SHOULD budget slack beyond the
   minimum, since the bound is checked against the close time when `/verify` runs, not
   when the channel was built.

   Every settle-time bound MUST also hold here, with room for the metered work in
   between: a channel admitted at `/verify` but refused at `/settle` means the work ran
   unpaid.

## Settlement

The facilitator submits exactly one transaction, built and signed by the `payTo` account
and carried in `payload.settlementTransaction`:

```
PaymentChannelClaim
  Account:            <payTo>
  Channel:            <channelId>
  Balance:            <actual>       # settlement-time requirements.amount
  Amount:             <maxAmount>    # the amount the signature authorizes
  Signature:          <payer claim signature>
  PublicKey:          <channel PublicKey>
  LastLedgerSequence: <within the settlement window>
  Flags:              tfClose
```

A zero settlement, or a nonzero charge the channel has already delivered, omits
`Balance`, `Amount`, `Signature` and `PublicKey`, leaving a bare close; see the binding
list below.

The facilitator MUST confirm the transaction succeeded in a validated ledger before
returning success. A provisional result MUST NOT be reported as settled. A result code
alone is not evidence of payment: a claim applied to a channel that has already expired
closes it without delivering and still returns `tesSUCCESS`, so for a claim settlement
a facilitator SHOULD confirm the delivered amount, the claim's `Balance` less the
balance the channel already carried, from the transaction metadata.

### Settlement Authorization

Closing a channel atomically requires the transaction to originate from the channel
`Destination`, so the facilitator cannot settle with its own key. The resource server
therefore signs the claim, being the party that knows the actual charge, and the
facilitator verifies and relays it. This mirrors the authority split of
`scheme_upto_svm.md`, where the server signs the settlement voucher and the facilitator
never holds payment authority, and it keeps the facilitator exactly where `exact` puts
it: verifying and submitting presigned blobs, holding no keys.

Before submitting, the facilitator MUST verify that the decoded blob:

- is a `PaymentChannelClaim` whose `Account` is `payTo`, carrying no `Delegate` and no
  `Signers`, with a canonical `SigningPubKey` whose transaction signature verifies and
  whose key is currently authorized for `payTo`: its configured regular key, or the
  master key pair unless disabled;
- has `Channel` equal to `payload.channelId`;
- carries `tfClose` and not `tfRenew`;
- has a `LastLedgerSequence` ahead of the validated ledger and within the settlement
  window, so the wait for a final outcome is bounded and the claim cannot outlive the
  duplicate-settlement entry below. The window MUST admit the fixed offset an SDK's
  autofill applies as well as `maxTimeoutSeconds`;
- carries no `NetworkID` on a standard network (id 1024 or below), and the network's id
  otherwise;
- for a nonzero settlement, has `Balance` equal to the settlement-time
  `paymentRequirements.amount`, `Amount` equal to `payload.maxAmount`, and `Signature`
  and `PublicKey` equal to the payload's;
- for a zero settlement, or a nonzero charge the channel has already delivered, carries
  none of `Balance`, `Amount`, `Signature` or `PublicKey`. A claim's `Balance` must
  exceed the total already delivered, so neither charge can be expressed as a claim:
  each is a bare destination close, which deletes the channel and refunds the undrawn
  remainder.

`Amount` MUST carry the originally authorized maximum, never the settlement amount. The
signature covers the maximum; substituting the settlement amount invalidates it.
`Balance` carries the actual charge, which MUST NOT exceed `payload.maxAmount`
(`invalid_upto_xrpl_payload_settlement_exceeds_amount`); `Balance` at most `Amount`
follows.

### Settle-Time Verification (REQUIRED)

Re-verification MUST run against `payload.maxAmount`, not the settlement-time
`paymentRequirements.amount`, mirroring the EVM rule that the facilitator re-verifies
against `permitted.amount`. Because `amount` is phase-dependent, a facilitator that
re-runs its verify logic against the settlement-time requirements applies
maximum-semantics checks to the actual charge, and silently accepts a channel too small
to have covered the original authorization.

Mechanically: substitute `payload.maxAmount` for `requirements.amount` in the required
terms before re-running rules 1 and 4; rule 1's field-by-field equality otherwise fails
on every nonzero settlement.

Re-verification is not the verification rules run again. Rules 6 and 7 are admission
control: they decide whether the metered work should begin, and the payer can invalidate
each of them itself once it has. Re-applying them unchanged at `/settle` refuses claims
the ledger would accept, and lets the payer obtain the work for free.

| Rule              | At `/verify`                                  | At `/settle`                                                                                                                                                                                                                               |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unclaimed (6)     | `Balance` is `0`                              | for a nonzero charge, `Balance` below the settlement amount, which is the claim's cumulative delivered total, so the claim delivers the difference; a zero settlement carries no claim. The source can deliver drops unilaterally, with or without a signed claim, so a nonzero `Balance` here only pre-pays part of the bill; a facilitator that refuses over it strands the remainder. At or above the settlement amount, the charge is already delivered and settlement is a bare close |
| Pending close (7) | `Expiration` unset                            | `Expiration` far enough out for the claim to land. A source-initiated close takes effect only when it elapses, which is what `SettleDelay` buys the destination                                                                            |
| Headroom (7)      | `maxTimeoutSeconds` plus the margin remaining | `CancelAfter` far enough out for the claim to land; the work has already run, only landing time remains                                                                                                                                    |
| `validAfter` (7)  | enforced                                      | not re-checked; the authorization already activated                                                                                                                                                                                        |

The bindings in rules 3, 4 and 5 MUST be re-checked in full, since those are properties
of the authorization rather than of the moment.

### Duplicate Settlement Mitigation (REQUIRED)

#### Vulnerability

Each settlement is a freshly signed claim, so a second attempt against a closed channel
fails with `tecNO_TARGET` rather than returning a spurious success. But a retry layer
resubmitting an identical signed blob meets XRPL's submission idempotency and would
report `tesSUCCESS` twice.

#### Required Mitigation

Facilitators MUST deduplicate settlements on `(network, channelId)`. The channel can be
drawn only once, so it is the natural settlement identity, and the key carries the
network because channel ids are network-independent. The check and record MUST be atomic
with respect to concurrent settlement requests, and the record MUST be taken only after
every local check on the settlement transaction has passed.

The entry MUST outlive the submitted claim. A transaction stays landable until its
`LastLedgerSequence`, so the retention window is derived from that horizon in ledgers and
converted at a pessimistic close rate, plus a margin.

An entry MUST be released when submission returns a definitive failure: a final result in
a validated ledger that is not `tesSUCCESS`. `scheme_exact_xrpl.md` rejects a
re-submission after a transient failure instead, because there the artifact is a
payer-presigned blob on which XRPL submission is idempotent, so a retry can land the
original payment twice. That reasoning does not carry to a claim the resource server
signs per settlement: nothing has landed that a retry could double-pay, and retaining the
entry would block the channel for the full window over one transient fault.

An ambiguous outcome, such as an exception mid-submission or a result that is not yet
validated, MUST retain the entry, since the claim may still land. A release MUST apply
only to the entry the releasing attempt itself recorded, so that an entry which expired
and was re-taken by a later attempt continues to protect that attempt's in-flight claim.

## Error Codes

Standard x402 error codes apply. Scheme-specific:

- `invalid_upto_xrpl_payload_settlement_exceeds_amount` - the settlement-time `amount`
  exceeds the signed `maxAmount`.
- `invalid_upto_xrpl_missing_settlement_transaction` - the settle-time payload carries
  no signed `PaymentChannelClaim`.
- `invalid_upto_xrpl_payload_unexpected_settlement_transaction` - the client's payload
  carries a `settlementTransaction`; the field is server-added, settle-only.
- `invalid_upto_xrpl_settlement_transaction_mismatch` - the blob decodes but violates a
  binding above.
- `invalid_upto_xrpl_settlement_signer_not_authorized` - the blob's signing key is not
  currently authorized for `payTo`.

Other faults reuse the shapes `scheme_exact_xrpl.md` established, among them:
`unsupported_scheme`, `duplicate_settlement`, `transaction_failed: <code>`, and
`invalid_upto_xrpl_facilitator_error` when the facilitator itself fails. An
infrastructure fault MUST NOT be reported with a payload-blaming code such as a missing
channel.

## Mapping the five core requirements to XRPL

| Requirement (generic spec) | XRPL mechanism                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-use authorization   | A destination-initiated claim with `tfClose` deletes the channel atomically; a repeat claim returns `tecNO_TARGET`                                                                          |
| Time-bound validity        | `CancelAfter` on the channel is the end bound, enforced in consensus; `validAfter` is verify-time policy, as in the SVM profile                                                             |
| Recipient binding          | `Destination` is fixed at `PaymentChannelCreate`, so funds can only ever reach it; a claim by an unrelated account is rejected with `tecNO_PERMISSION`                                      |
| Maximum amount enforcement | The channel `Amount` caps total delivery and the signed claim caps it further; over-claiming returns `tecUNFUNDED_PAYMENT`. A zero settlement is a close without a claim, refunding the undrawn remainder |
| Phase-dependent `amount`   | The claim is signed for the maximum and permits settlement of any lesser amount, so the client signs once, off-ledger, without knowing the price                                            |

A source-initiated `tfClose` does not close the channel immediately; it schedules expiry
after `SettleDelay`, leaving the channel claimable in the interim. Facilitators MUST
settle via a destination-initiated claim with `tfClose`, which is atomic.

## Security Considerations

### Trust Minimization

The facilitator holds no key, signs nothing, and pays no fee. It cannot redirect a
payment: `Destination` is fixed in consensus at channel creation. It cannot settle a
nonzero amount without the resource server's signed claim, and it cannot settle more than
the payer's signed maximum.

### Replay and Race Protection

Single use is enforced in consensus by the atomic close, and the duplicate-settlement
guard above covers the window before the claim validates. The cross-network warning under
[Network Identifier](#network-identifier-caip-2) applies to the claim signature, which
carries no network binding.

## Limitations and Out of Scope

**Issued currencies.** Payment Channels carry XRP only, so IOU-denominated metered
payments are not possible under this scheme. `TokenEscrow` releases all-or-nothing and
cannot express settle-for-actual.

**Checks, considered and not used.** `CheckCreate` with `CheckCash` also lets a
destination draw up to a maximum, at the same transaction count and owner reserve, and
would carry an on-ledger `InvoiceID` and support issued currencies. But a check is
uncollateralized, so the payer may spend the balance elsewhere, and `CheckCancel` is
immediate for the source with no `SettleDelay` analog: a payer can take the metered work
and then void the payment for a few drops. Neither failure is visible to `/verify`.
Escrow is not required by [`scheme_upto.md`](./scheme_upto.md), but on XRPL it costs no
extra transaction.

**Channel reuse.** A long-lived channel drawn by successive claims would amortize the
preflight cost, but settling one authorization more than once is
[`batch-settlement`](../batch-settlement/scheme_batch_settlement.md), not `upto`, as the
SVM profile also notes.

**Capital lockup.** The channel escrows the full authorized maximum on-ledger for its
lifetime; the payer recovers the unused remainder only at settlement or `CancelAfter`.

**Two on-ledger transactions per payment**, one to open the channel and one to settle,
plus the owner reserve held while the channel is open.

**Invoice binding.** `PaymentChannelClaim` has no `InvoiceID` field, so a payment is bound
by channel identity rather than on-ledger, unlike `exact`'s `invoiceId`.
`PaymentChannelCreate` does accept a `DestinationTag`, fixed at creation and visible on
the channel, but at 32 bits it can label a payment, not carry an invoice hash.

## References

- [`scheme_upto.md`](./scheme_upto.md) - network-agnostic requirements
- [`scheme_upto_evm.md`](./scheme_upto_evm.md), [`scheme_upto_svm.md`](./scheme_upto_svm.md)
- [`scheme_exact_xrpl.md`](../exact/scheme_exact_xrpl.md) - XRPL conventions and the
  preflight precedent
- [`x402-specification-v2.md`](../../x402-specification-v2.md) - core types
- XRPL: `PaymentChannelCreate`, `PaymentChannelClaim`, `PayChannel` ledger object
