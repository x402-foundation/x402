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
| **Payment authorization** | The payer signs a `PaymentChannelCreate` offline (not submitted), derives `channelId`, and signs an off-ledger claim over `(channelId, maxAmount)` |
| **Deposit settlement**    | The facilitator decodes `openTransaction`, verifies every field and the claim signature, rejects if the channel already exists, deduplicates on `(network, channelId)`, submits the create, waits for validation, and re-reads the `PayChannel` |
| **Claim settlement**      | The facilitator submits a `PaymentChannelClaim`, signed by the `payTo` account, carrying the actual amount and `tfClose`  |
| **Fee payer**             | The payer pays the channel-creation fee; the `payTo` account pays the settlement fee                                      |

XRPL `upto` uses the core `escrow` payment flow
([x402 v2 §6.1](../../x402-specification-v2.md)): `settle(deposit)` → resource →
`settle(claim)` → respond. Funds are not committed on ledger until the deposit settle.
`extra.paymentFlow` MUST be `"escrow"` in `PAYMENT-REQUIRED` so clients can distinguish
this profile from authorization-first schemes.

XRPL charges a transaction fee to the transaction `Account`, and has no mechanism for a
second account to co-sign and pay for another account's transaction, so neither the
channel creation nor the settlement can be fee-sponsored by a facilitator. The `Sponsor`
amendment (XLS-68) would change this but is not enabled on Mainnet. `extra.areFeesSponsored`
is therefore always `false`, as in `scheme_exact_xrpl.md`.

The signed `PaymentChannelCreate` fixes the sequence used in `channelId`. The payer MAY
send other transactions from the same account before deposit settle only when they do not
consume that sequence; after the channel exists, the authorization is the channel itself.

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

The protocol flow for `upto` on XRPL is client-driven and follows the `escrow` payment
flow of the v2 specification: deposit settle, then the metered work, then claim settle.
Facilitator `/verify` is not part of this ordering; it MAY be offered as a read-only
preflight of the same static checks as deposit settle without submitting `openTransaction`.

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with `PaymentRequired` in the `PAYMENT-REQUIRED` header,
   with `amount` set to the maximum it may charge and `extra.paymentFlow` set to `"escrow"`.
3. **Client** signs a `PaymentChannelCreate` to `payTo` with `Amount` set to that maximum,
   a `CancelAfter` expiry, a `SettleDelay` sized per [Time bounds](#time-bounds), an optional
   `DestinationTag` matching `extra.destinationTag` when present, and a bounded
   `LastLedgerSequence`. The client does not submit this transaction.
4. **Client** derives `channelId` as `SHA512Half(0x0078, Account, Destination, Sequence)`
   from the signed create fields and signs an off-ledger claim over `(channelId, maxAmount)`.
   This is not a ledger transaction.
5. **Client** sends a new request with the `PAYMENT-SIGNATURE` header containing the
   `PaymentPayload`, including the hex-encoded signed create as `openTransaction`.
6. **Resource Server** calls the facilitator's `/settle` endpoint with deposit-phase
   requirements (`amount` still the maximum), `payload.type` set to `"deposit"` (via
   `enrichSettlementPayload` or equivalent), and the client authorization unchanged.
7. **Facilitator** validates `openTransaction`, verifies the claim signature, rejects if the
   channel already exists, deduplicates on `(network, channelId)`, submits the create,
   waits for validation, and re-reads the `PayChannel`.
8. **Resource Server** runs the metered work and measures the actual consumption.
9. **Resource Server** signs a `PaymentChannelClaim` for the actual amount and calls
   `/settle` again with `amount` set to the actual charge, `payload.type` `"claim"`, and the
   signed claim in `settlementTransaction`.
10. **Facilitator** re-verifies against the signed maximum, submits the claim, and confirms
    it succeeded in a validated ledger.
11. **Facilitator** responds with a `SettlementResponse` carrying the settled amount.
12. **Resource Server** grants access via the `PAYMENT-RESPONSE` header.

If metered work fails after a successful deposit settle, the resource server SHOULD settle
`0` (bare close) promptly rather than leaving the channel funded. See
[Client recovery](#client-recovery).

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
    "paymentFlow": "escrow",
    "areFeesSponsored": false,
    "minSettleDelay": 600,
    "validAfter": 1754136000,
    "destinationTag": 12345
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
    "paymentFlow": "escrow",
    "areFeesSponsored": false,
    "minSettleDelay": 600,
    "validAfter": 1754136000,
    "destinationTag": 12345
  }
}
```

### Field Definitions

| Field                         | Type    | Required    | Description                                                                                     |
| ----------------------------- | ------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `extra.paymentFlow`           | string  | yes         | MUST be `"escrow"` for this profile                                                             |
| `extra.areFeesSponsored`      | boolean | yes         | Always `false`; XRPL cannot sponsor either transaction                                          |
| `extra.minSettleDelay`        | number  | no          | Minimum `SettleDelay` the channel must carry, in seconds                                        |
| `extra.validAfter`            | number  | no          | Earliest activation time, Unix seconds                                                          |
| `extra.destinationTag`        | number  | no          | When present, the signed `PaymentChannelCreate` and on-ledger `PayChannel` MUST carry this `DestinationTag` so hosted `payTo` accounts can be paid correctly |

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
      "paymentFlow": "escrow",
      "areFeesSponsored": false,
      "minSettleDelay": 600,
      "validAfter": 1754136000,
      "destinationTag": 12345
    }
  },
  "payload": {
    "channelId": "C93B7DF84AC3F2C2BB69C88917451FA3980472DABEF8FFA461A0B1563BEF71AF",
    "maxAmount": "10000000",
    "signature": "496630507166941E8D6C693B0E8A45276DD6BD60...",
    "publicKey": "ED9434799226374926EDA3B54B1B461B4ABF7237962EAE18528FEA67595397FA32",
    "payer": "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH",
    "openTransaction": "1200002280000000240000001D61B0F8EDB7FD46CBB8E5E762BDAE7BAF3D9C9..."
  }
}
```

| Field              | Description                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `channelId`        | `SHA512Half(0x0078, Account, Destination, Sequence)` from the signed create, 64 hexadecimal characters |
| `maxAmount`        | Drops authorized by `signature`. MUST equal the deposit-phase `amount`      |
| `signature`        | The payer's off-ledger claim signature over `(channelId, maxAmount)`        |
| `publicKey`        | `PublicKey` in the signed create; against which the claim verifies          |
| `payer`            | `Account` in the signed create (channel payer)                              |
| `openTransaction`  | Hex blob of the signed `PaymentChannelCreate`; not submitted by the client  |

At settle time the resource server adds fields to the payload before calling `/settle`:

| Field                   | Description                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `type`                  | `"deposit"` or `"claim"`. Set per settle via `enrichSettlementPayload` or equivalent; distinguishes the two escrow settles ([x402 v2 §7.2](../../x402-specification-v2.md)). |
| `settlementTransaction` | Claim settle only. Hex blob of the `PaymentChannelClaim` signed by `payTo`; see [Claim settlement](#claim-settlement) |

`type` and `settlementTransaction` are server-authored and settle-only. They MUST be absent
from the client's `PAYMENT-SIGNATURE`. A facilitator MUST reject a client payload
presenting either field with `invalid_upto_xrpl_payload_unexpected_settlement_transaction`
or `invalid_upto_xrpl_payload_unexpected_claim_transaction` respectively, and MUST reject
a client-supplied `type` with `invalid_upto_xrpl_payload_type`.

When `type` is absent, the facilitator MAY infer deposit vs claim from payload shape and
ledger state ([x402 v2 §7.2](../../x402-specification-v2.md)): no `settlementTransaction`,
deposit-phase `amount == payload.maxAmount`, and no open channel → deposit; otherwise
claim. `type` is REQUIRED when the resource server delegates settlement enrichment to a
facilitator that cannot infer the step reliably.

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
the claim settlement validates, and MAY be `"0"`. `payer` is the channel `Account` from
the opened `PayChannel`, not the `PaymentChannelClaim` transaction `Account` (`payTo`).
`transaction` is the hash of the validated ledger transaction for the settle step: the
`PaymentChannelCreate` on deposit settle, or the `PaymentChannelClaim` on claim settle
(including a zero settlement bare close).

## Account Requirements

| Role            | Requirement                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client          | XRP for the channel `Amount`, the creation fee, and the owner reserve (currently `0.2 XRP` on Mainnet, subject to validator fee voting) held while the channel is open |
| Resource server | An XRPL account at `payTo`, funded for the settlement fee, whose key signs the settlement claim                                                                        |
| Facilitator     | An RPC endpoint. It holds no key and pays no fee                                                                                                                       |

The resource server needs an RPC endpoint to build the settlement claim, since the claim
carries a `LastLedgerSequence` derived from current ledger state.

## Facilitator checks (MUST)

Escrow `upto` performs authorization at deposit `/settle`. The facilitator MAY expose the
same static checks at `/verify` as a read-only preflight; `/verify` MUST NOT submit
`openTransaction` or open a channel.

### Shared envelope and claim checks

These apply to deposit settle (against the decoded create) and claim settle (against the
opened `PayChannel`).

1. **Envelope** — `x402Version` is `2`, `scheme` is `"upto"`, `network` is a canonical XRPL
   identifier on both sides, and accepted terms equal required terms field by field:
   `asset`, `amount`, `payTo`, `maxTimeoutSeconds`, `extra.paymentFlow` (`"escrow"`),
   `extra.areFeesSponsored`, `extra.minSettleDelay`, `extra.validAfter`, and
   `extra.destinationTag` (present or absent together). `maxTimeoutSeconds` MUST be a
   positive integer and `amount` canonical drops; present numeric `extra` fields MUST be
   non-negative integers. Malformed values MUST be rejected; absent optional fields MUST
   match whether omitted or null.
2. **Maximum** — at deposit settle, `payload.maxAmount` MUST equal requirements `amount`
   exactly. At claim settle, re-verify against `payload.maxAmount`, not the settlement-time
   `amount` (phase-dependent semantics; see [Claim settle-time verification](#claim-settle-time-verification)).
3. **Claim signature** — `payload.signature` MUST verify against `payload.publicKey` over
   the claim signing message: prefix `CLM\0` (`0x434C4D00`), 32-byte `channelId`, and
   `maxAmount` as big-endian unsigned 64-bit drops. rippled `channel_verify` and xrpl.js
   `verifyPaymentChannelClaim` are reference verifiers. For secp256k1 the signature MUST be
   fully canonical (low-`s`).
4. **Destination tag** — when `extra.destinationTag` is present, the signed create MUST
   include the same `DestinationTag`, and after opening the `PayChannel` MUST carry it.
   Mismatch MUST fail with `invalid_upto_xrpl_destination_tag_mismatch`.

### Time bounds

`CancelAfter` on the create MUST be present and MUST leave at least `maxTimeoutSeconds`
plus the landing margin beyond the validated ledger close time when deposit settle runs.
`SettleDelay` MUST be at least `maxTimeoutSeconds` plus that margin and at least
`extra.minSettleDelay` when present. If `extra.validAfter` is present, deposit settle
MUST be rejected while ledger close time is before it (`validAfter` is Unix seconds;
`CancelAfter` uses ledger time).

The landing margin is **20 seconds** (two 10-second ledger closes). `LastLedgerSequence`
on the signed create MUST be strictly greater than the validated ledger index and MUST NOT
exceed validated ledger index + `openLedgerWindow`, where `openLedgerWindow` MUST be at
least `ceil((maxTimeoutSeconds + 20) / 10)` ledgers. Violations MUST fail with
`invalid_upto_xrpl_create_last_ledger_sequence`. The same margin bounds claim
`LastLedgerSequence` in [Claim settlement](#claim-settlement).

`CancelAfter` bounds how long a signed claim stays redeemable;
[`scheme_upto.md`](./scheme_upto.md) requires explicit time bounds. A client SHOULD
budget slack beyond the minimum checked at deposit settle.

### Deposit settlement (before resource execution)

On `/settle` with `payload.type` `"deposit"` (or inferred deposit), the facilitator MUST,
in order:

1. Reject client-supplied `settlementTransaction` or `type` (see [PaymentPayload](#paymentpayload-for-upto)).
2. Run [Shared envelope and claim checks](#shared-envelope-and-claim-checks) for deposit-phase
   `amount`.
3. Fully decode `payload.openTransaction` as a signed `PaymentChannelCreate` and verify every
   binding: `Account` equals `payload.payer`; `Destination` equals `payTo`; `Amount` equals
   `payload.maxAmount`; `PublicKey` equals `payload.publicKey`; `SettleDelay` and `CancelAfter`
   satisfy [Time bounds](#time-bounds); no disallowed fields; transaction signature valid;
   derived `channelId` equals `payload.channelId`. Any violation MUST fail with
   `invalid_upto_xrpl_open_transaction_mismatch`.
4. Confirm no `PayChannel` exists for `payload.channelId`. If one exists, MUST fail with
   `invalid_upto_xrpl_channel_already_open`.
5. Atomically take the deposit duplicate-settlement entry on `(network, channelId)` (see
   [Duplicate settlement mitigation](#duplicate-settlement-mitigation)).
6. Submit `openTransaction`, wait until it appears in a validated ledger, and re-read the
   `PayChannel`. The opened channel MUST match the decoded create and challenge
   (`invalid_upto_xrpl_channel_state` on mismatch). `Balance` MUST be `0`.

If the resource server cannot obtain a deposit settle (missing `openTransaction`, failed
validation, or facilitator unavailable), it SHOULD respond with `412` and
`CHANNEL_REQUIRED` before serving the resource, matching the SVM `upto` precondition.

Concurrent deposit settles for the same `channelId` MUST NOT each unlock the resource: the
already-open check and deposit deduplication are authoritative. A resource server SHOULD NOT
run metered work until deposit settle succeeds.

### Claim settlement

On `/settle` with `payload.type` `"claim"` (or inferred claim), the facilitator submits the
`PaymentChannelClaim` built and signed by `payTo` in `payload.settlementTransaction`:

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
returning success, except when returning non-terminal `settlement_pending` (below). A
provisional result MUST NOT be reported as settled. A result code alone is not evidence
of payment: a claim applied to a channel that has already expired closes it without
delivering and still returns `tesSUCCESS`, so for a claim settlement a facilitator SHOULD
confirm the delivered amount, the claim's `Balance` less the balance the channel already
carried, from the transaction metadata.

If a settlement transaction broadcasts successfully but its confirmation cannot be
established (for example an RPC error or timeout while waiting for validation), the
facilitator MAY return `settlement_pending` (see [§9 Error Handling](../../x402-specification-v2.md#9-error-handling))
with the broadcast hash in `transaction`, so the caller can reconcile on ledger before
retrying. This applies to both deposit and claim settles, as in
[`scheme_upto_evm.md`](./scheme_upto_evm.md).

### Claim authorization

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

### Claim settle-time verification (REQUIRED)

Before submitting the claim, the facilitator MUST re-read the `PayChannel` and confirm
recipient/payer binding, `payload.maxAmount` against channel `Amount`, and the claim
signature against channel `PublicKey` ([Shared envelope and claim checks](#shared-envelope-and-claim-checks)).

Re-verification is not deposit admission replayed unchanged. At claim settle:

| Check | Deposit settle | Claim settle |
| ----- | -------------- | ------------ |
| Channel exists, bindings | from decoded create | from `PayChannel` |
| Unclaimed / deliverable | `Balance` is `0` after open | for a nonzero charge, `Balance` below settlement amount so the claim delivers the difference; zero settlement is a bare close |
| Pending close | n/a (channel new) | `Expiration` far enough out for the claim to land |
| Headroom | `CancelAfter` / `SettleDelay` on create | `CancelAfter` far enough out for the claim to land |
| `validAfter` | enforced | not re-checked |

The facilitator MUST take the claim duplicate-settlement entry on `(network, channelId)`
after local claim checks pass and before broadcast.

### Duplicate settlement mitigation (REQUIRED)

#### Vulnerability

Each settlement is a freshly signed claim, so a second attempt against a closed channel
fails with `tecNO_TARGET` rather than returning a spurious success. But a retry layer
resubmitting an identical signed blob meets XRPL's submission idempotency and would
report `tesSUCCESS` twice.

#### Required mitigation

Facilitators MUST deduplicate **both** escrow settles on `(network, channelId)` using
distinct keys for deposit and claim (for example `upto:deposit:<network>:<channelId>` and
`upto:claim:<network>:<channelId>`), so a successful deposit does not block the later
claim for the same authorization. The check and record MUST be atomic with respect to
concurrent requests in the same phase, and the record MUST be taken only after every
local check for that phase has passed.

Each entry MUST outlive the submitted transaction. A transaction stays landable until its
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

## Client recovery

If metered work fails after deposit settle, the resource server SHOULD claim-settle `0`
(bare close) promptly. The payer MAY also recover funds without server cooperation: a
source-initiated `PaymentChannelClaim` with `tfClose` schedules expiry after `SettleDelay`;
after `Expiration` or `CancelAfter` elapses, a final transaction deletes the channel and
returns the escrowed remainder and owner reserve to the payer.

## Error Codes

Standard x402 error codes apply. Scheme-specific:

- `invalid_upto_xrpl_payload_settlement_exceeds_amount` — settlement-time `amount` exceeds
  signed `maxAmount`.
- `invalid_upto_xrpl_missing_settlement_transaction` — claim settle payload has no signed
  `PaymentChannelClaim`.
- `invalid_upto_xrpl_payload_unexpected_settlement_transaction` — client payload carries
  `settlementTransaction` (server-added, claim-only).
- `invalid_upto_xrpl_payload_unexpected_claim_transaction` — deposit settle carries
  `settlementTransaction`, or client payload includes it at authorization time.
- `invalid_upto_xrpl_payload_type` — client supplied `type`, or delegated settle missing
  `type`.
- `invalid_upto_xrpl_open_transaction_mismatch` — `openTransaction` decodes but violates a
  deposit binding (payer, payTo, amount, keys, time bounds, signature, or `channelId`).
- `invalid_upto_xrpl_destination_tag_mismatch` — `DestinationTag` does not match
  `extra.destinationTag`.
- `invalid_upto_xrpl_create_last_ledger_sequence` — signed create `LastLedgerSequence` is
  missing, not ahead of the ledger, or outside the allowed open window.
- `invalid_upto_xrpl_channel_already_open` — deposit settle found an existing `PayChannel`
  for `payload.channelId`.
- `invalid_upto_xrpl_channel_state` — post-create `PayChannel` missing or does not match
  the challenge.
- `invalid_upto_xrpl_claim_signature_invalid` — off-ledger claim signature verification
  failed.
- `invalid_upto_xrpl_settlement_transaction_mismatch` — claim blob decodes but violates a
  binding in [Claim authorization](#claim-authorization).
- `invalid_upto_xrpl_settlement_signer_not_authorized` — claim blob signing key is not
  authorized for `payTo`.
- `CHANNEL_REQUIRED` (with `412`) — no open channel and no valid `openTransaction` that can
  be submitted and confirmed before serving the resource.

Other faults reuse the shapes `scheme_exact_xrpl.md` established, among them:
`unsupported_scheme`, `duplicate_settlement`, `settlement_pending`, `transaction_failed: <code>`,
and `invalid_upto_xrpl_facilitator_error` when the facilitator itself fails. An
infrastructure fault MUST NOT be reported with a payload-blaming code such as a missing
channel.

## Mapping the five core requirements to XRPL

| Requirement (generic spec) | XRPL mechanism                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-use authorization   | Deposit settle opens the channel for this authorization and MUST reject an already-open `channelId`; a destination claim with `tfClose` deletes the channel atomically; a repeat claim returns `tecNO_TARGET` |
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

**Two on-ledger transactions per payment** — `PaymentChannelCreate` at deposit settle and
`PaymentChannelClaim` at claim settle — plus the owner reserve held while the channel is
open between those steps.

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
