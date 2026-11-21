# Scheme: `batch-settlement` on XRPL: Check sessions (`xrpl-check-session`)

## Summary

The `batch-settlement` scheme on the XRP Ledger (XRPL), binding `xrpl-check-session`, backs a
**session** of many paid requests with one validated XRPL `Check`. The payer's `CheckCreate`
commits, through its `InvoiceID`, to the session's terms and to the client's Ed25519 session key.
Each request names the most the client agrees to pay for it and is signed with that key (RFC 9421);
the facilitator reserves the request's worst case within the Check's ceiling before it runs and
commits the metered price after. At close the merchant cashes the Check once, for the committed
total.

| Property | Value |
| --- | --- |
| Network identifiers | `xrpl:{network_id}`, as in [`exact` on XRPL](../exact/scheme_exact_xrpl.md#network-identifier-caip-2) |
| Binding | `extra.binding` `xrpl-check-session`, `extra.version` `"1"` |
| Assets | XRP and issued currencies, for example RLUSD |
| Trust model | Capital-backed: a delegated authorization against the payer's balance, with a ceiling the ledger enforces; nothing is locked ([Trust model](#trust-model)) |
| Dynamic pricing | Yes: reserve the maximum, commit the actual charge |
| Payment flow | x402 `escrow`, the name of an order of calls: a settle reserves each request before it runs, a second records its charge. No funds are escrowed. |
| Facilitator interface | The standard `/verify`, `/settle` and `/supported` ([Facilitator interface](#facilitator-interface)) |
| Custody | The facilitator never holds the payer's or the merchant's keys |

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT** and **MAY** are to be
interpreted as described in BCP 14 when they appear in all capitals.

## Relationship to other XRPL bindings

A payment-channel binding for XRPL is proposed in
[x402-foundation/x402#2952](https://github.com/x402-foundation/x402/pull/2952). The two are
complementary:

| | Payment channel (`xrpl-paychan-v1`) | Check session (`xrpl-check-session`) |
| --- | --- | --- |
| Ledger object | `PayChannel` | `Check` |
| Assets | XRP only | XRP and issued currencies such as RLUSD |
| Trust model | Capital-backed: XRP is allocated to the channel (optional collector payouts are credit-backed) | Capital-backed: a delegated authorization against the payer's balance; a Check locks nothing, but the ledger caps it |
| Per-request authorization | Payer-signed cumulative channel claim | Session-key RFC 9421 signature, bound to the Check |
| Per request at the facilitator | `/verify` checks and reserves, `/settle` records the charge | A `/settle` reserves (`type` `reserve`), a second records the charge (`commit`); `/verify` holds nothing |
| Requests in flight | One active request per channel | Any number per session, each with its own reservation |
| Commitment identifier | `xrpl-paychan:…` in `SettleResponse.transaction` | `transaction` empty; `sessionId`, `requestId` and `receiptDigest` in `extra` |
| Redemption | `PaymentChannelClaim`, as often as the destination chooses, and before the channel's `Expiration` or `CancelAfter` | One `CheckCash` per session |

Checks give one mechanism for XRP and issued currencies alike. A merchant that wants the payer's
XRP allocated in advance uses the payment-channel binding. A resource server MAY offer both in
`accepts`; both are `batch-settlement` on `xrpl:*`, so clients MUST select by `extra.binding`.

## Roles

| Role | Responsibility |
| --- | --- |
| Payer | XRPL account that signs the `CheckCreate`: the client, or a service paying for it |
| Client | Holds the session key, signs every request, verifies terms and receipts |
| Resource server | Merchant whose account is `payTo`. Serves the session endpoints, prices and meters requests, forwards client proofs to the facilitator |
| Facilitator | Validates and submits the session's ledger transactions, verifies request proofs, keeps the durable session budget |
| Merchant signer | In the merchant's trust boundary; signs a `CheckCash` for the facilitator-frozen amount and nothing else |

## Amounts and assets

- **Ledger units** are what the client sees: drops for XRP, and for an issued currency its XRPL
  issued-currency `value`. They are canonical decimal strings, without sign, exponent, leading zero
  or trailing fractional zero (`(0|[1-9][0-9]*)(\.[0-9]*[1-9])?`); XRP amounts are integers.
- **Atomic units** are integers. For XRP an atomic unit is one drop, so a ledger amount is already
  atomic: `assetScale` MUST be 6, the drops in one XRP, and is never applied to drops. For an
  issued currency, atomic units are `value × 10^assetScale` exactly, with `assetScale` 0 to 15.
- `asset` is `XRP`, or an XRPL currency code: three characters from XRPL's standard set (letters,
  digits and `?!@#$%^&*<>(){}[]|`) other than `XRP` in any letter case, or 40 uppercase hex
  characters not beginning with `00`. An issued currency is identified by `(asset, issuer)`;
  matching by symbol alone is forbidden.
- A ceiling MUST be positive and at most `2^53 − 1` drops for XRP or `10^15 − 1` atomic units for an
  issued currency, so every amount round-trips exactly through the ledger.
- **Transfer fees.** Version 1 supports only `fee_free_or_exempt`: `SendMax` equals the ceiling,
  and the facilitator refuses to open or cash while the issuer charges a `TransferRate` fee, unless
  the issuer is the payer or `payTo`. XRP has no transfer fee.
- A facilitator or resource server MAY accept only some assets; a resource server offers sessions
  only in assets its facilitator accepts. A facilitator SHOULD pin known issuers per network and
  refuse the same currency code from any other issuer (for RLUSD on mainnet,
  `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`).
- Ledger times (`expiration`, `createSubmitDeadline`, `sessionExpiration`) are Ripple-epoch seconds,
  compared with validated-ledger close times. Proof and nonce times (`created`, `expires`,
  `nonceExpiresAt`) are Unix seconds, checked against the facilitator's clock.

## Protocol flow

1. The client gets `402` with a `batch-settlement` offer whose `extra.binding` is
   `xrpl-check-session`.
2. It creates an Ed25519 session key and proposes a session at `extra.sessions`. The resource server
   adds its price table, origin and route scopes and settles a `propose` step; the facilitator
   persists immutable terms and returns their canonical form and the `CheckCreate` to sign.
3. The client verifies the terms, derives the identifiers itself, and has the payer sign the
   `CheckCreate`. The resource server settles an `open` step with it; the facilitator submits it and
   opens the session after a validated `tesSUCCESS`.
4. Each request carries `PAYMENT-SIGNATURE`, `Content-Digest`, `Signature-Input` and `Signature`.
   The resource server settles a `reserve` step with the client's payload and proof; the facilitator
   verifies the proof and reserves the request's worst case. The resource server executes the
   request, settles a `commit` step with its metered usage and answers with a `PAYMENT-RESPONSE`
   receipt.
5. The client, the merchant or the facilitator closes the session (a `close` step). The facilitator
   drains in-flight requests and freezes the committed total; the merchant signer signs a `CheckCash`
   for it, which the resource server settles as a `cash` step and the facilitator submits.

Once a session is open, the client MAY sign a request without fetching a `402` first. Each request
is reserved by a settle before the resource executes and charged by a second settle after it: the
x402 `escrow` payment flow (x402 v2 §6.1), so `extra.paymentFlow` is `"escrow"`. The binding's one
asset transfer method is `sequence`, as in `exact` on XRPL: every transaction it admits uses its
account's `Sequence`, never a Ticket. That method is the default, so `extra.assetTransferMethod` is
omitted.

The flow's name describes the order of calls, not custody. x402 v2 §6.1 says the first settle
commits "a deposit or ceiling"; here it is a ceiling, the request's worst case, reserved in the
facilitator's session budget within the Check's own ceiling. Nothing is locked on the ledger
([Trust model](#trust-model)). A reservation is payment state, so a settle makes it and `/verify`
commits no payment state (x402 v2 §7.1): a session serves concurrent requests, each keeps its
reservation until it is committed or released, and a new request is admitted only within what the
others leave.

## `PaymentRequirements`

An unpaid request to a protected route gets `402` with `PAYMENT-REQUIRED`:

```json
{
  "x402Version": 2,
  "error": "payment_required",
  "resource": { "url": "https://rs.example/v1/chat/completions", "description": "" },
  "accepts": [
    {
      "scheme": "batch-settlement", "network": "xrpl:1",
      "asset": "524C555344000000000000000000000000000000", "payTo": "rfUom3iQifHWyw2KwH1fg7AKUYQBW73U5H",
      "amount": "0.001922", "maxTimeoutSeconds": 60,
      "extra": {
        "binding": "xrpl-check-session", "version": "1", "paymentFlow": "escrow",
        "issuer": "rhA4uZnenHBQM2My9mFYWjwKhu2i6DCSVA", "assetScale": 6,
        "sessions": "https://rs.example/x402/sessions", "pricingVersion": "example-2026-10",
        "ceiling": { "min": "0", "max": "15" }, "maxSessionSeconds": 86400
      }
    }
  ],
  "extensions": {
    "http-message-signatures": {
      "info": { "registrationUrl": "https://rs.example/x402/sessions", "signatureSchemes": ["ed25519"], "tags": ["x402-xrpl-session"] }
    },
    "payment-identifier": {
      "info": { "required": true },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": { "required": { "type": "boolean" }, "id": { "type": "string", "minLength": 16, "maxLength": 128 } },
        "required": ["required"]
      }
    }
  }
}
```

All addresses in the examples are test-only. An XRP offer has `"asset": "XRP"`, no `extra.issuer`,
`"assetScale": 6` and every amount in drops, for example `"amount": "1922"` and
`"ceiling": { "min": "0", "max": "15000000" }`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `scheme` | string | yes | `batch-settlement` |
| `network` | string | yes | `xrpl:{network_id}` |
| `asset` | string | yes | `XRP` or a currency code |
| `payTo` | string | yes | Merchant's classic address: the Check's `Destination` |
| `amount` | string | yes | Most this request can be charged, in ledger units: its worst case under the session price table |
| `maxTimeoutSeconds` | number | yes | As in x402 v2; not part of the session commitment |
| `extra.binding` | string | yes | `xrpl-check-session` |
| `extra.version` | string | yes | `"1"` |
| `extra.paymentFlow` | string | yes | `"escrow"` ([Protocol flow](#protocol-flow)). A client MUST NOT pay an offer with another payment flow. |
| `extra.issuer` | string | issued only | Issuer's classic address; omitted for XRP |
| `extra.assetScale` | number | yes | Decimal places of the atomic unit; 6 for XRP |
| `extra.sessions` | string | yes | Absolute `https` or `http` URL of the session endpoints |
| `extra.pricingVersion` | string | yes | Version of the price table the resource server will propose |
| `extra.ceiling` | object | yes | `min` and `max` in ledger units. A proposed ceiling MUST satisfy `min < ceiling <= max`; `min` is exclusive, and `"0"` when absent. |
| `extra.maxSessionSeconds` | number | yes | Longest session the resource server proposes |

Extensions:

- `http-message-signatures`: `registrationUrl` is the session endpoint, `signatureSchemes` is
  `["ed25519"]` and `tags` is `["x402-xrpl-session"]`. Here the session proposal is the
  registration: the public key travels in the signed terms. Unlike the extension's directory-based
  flow, there is no `/.well-known/http-message-signatures-directory` and no `Signature-Agent`
  header. Its `schema` is omitted, as that extension allows.
- `payment-identifier` with `required: true` and that extension's schema. Its `id` is the request
  ID. A payment without one is answered `400` `payment_identifier_required`, and a repeated `id`
  `409`, with the stored receipt once the request is committed, never with a cached response
  ([Replays](#replays)).

Every `PAYMENT-SIGNATURE` payload echoes these extensions, as x402 v2 §5.1.2 requires
([`PAYMENT-SIGNATURE`](#payment-signature)).

Two `402` answers correct a request without reserving anything:

- `session_nonce_stale`: the offer's `extra` also carries `sessionId`, `nonce` and
  `nonceExpiresAt`. The client retries under that nonce, with the same request ID.
- `client_max_exceeded`: `amount` is the reservation the request needs, more than the client
  signed for.

## Session endpoints

The resource server serves these at `extra.sessions` (written `{sessions}`) and turns each into a
facilitator step ([Facilitator interface](#facilitator-interface)). Amounts in every answer to the
client are ledger units.

### Propose: `POST {sessions}`

Header `Idempotency-Key`, 1 to 80 characters of `[A-Za-z0-9_-]`, is required. Body:

```json
{ "payer": "rGMTQpyhaDwWTqmw4dcYHj5NPJhtWNhtRW", "ceiling": "0.5", "sessionSeconds": 3600,
  "clientKey": { "kty": "OKP", "crv": "Ed25519", "x": "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs" } }
```

The resource server refuses with `400` and `idempotency_key_required`, `invalid_session_request`,
`invalid_payer`, `invalid_ceiling` (not canonical), `ceiling_out_of_policy` (outside
`extra.ceiling`), `session_seconds_out_of_policy` (not `0 < sessionSeconds <= maxSessionSeconds`)
or `invalid_session_key`. It MUST scope the client's `Idempotency-Key` to that client before
forwarding it, so clients cannot collide, for example by prefixing the session key's thumbprint. A
retry with the same key and body returns the same terms; the same key with another body is
`idempotency_conflict`.

The `201` answer:

```json
{
  "sessionId": "ses_0123456789abcdef0123456789abcdef",
  "sessionAuthorizationId": "sha256:9683437a5fb1df494f4427db76e9483a288d00dc6104e351f4d48c407c5a2b50",
  "canonicalTerms": "{\"binding\":\"xrpl-check-session\",\"scheme\":\"batch-settlement\",\"terms\":{…},\"version\":2}",
  "createSubmitDeadline": 846000600,
  "sessionExpiration": 846003600,
  "settlementGraceSeconds": 600,
  "checkCreate": {
    "network": "xrpl:1",
    "account": "rGMTQpyhaDwWTqmw4dcYHj5NPJhtWNhtRW",
    "destination": "rfUom3iQifHWyw2KwH1fg7AKUYQBW73U5H",
    "sendMax": { "currency": "524C555344000000000000000000000000000000", "issuer": "rhA4uZnenHBQM2My9mFYWjwKhu2i6DCSVA", "value": "0.5" },
    "expiration": 846003600,
    "invoiceId": "96FFED92D62CEF575D383682318725F734BD43E64F4C1AA24C4E274E24481E6F",
    "destinationTag": null, "sourceTag": null
  }
}
```

`checkCreate.sendMax.value` is an XRPL amount; for XRP it is drops, with `currency` `XRP` and
`issuer` `""`. [Appendix A](#appendix-a-conformance-vectors) has this example's full terms.

### Verifying the proposal

Before the payer signs anything, the client MUST check:

1. `canonicalTerms` parses as JSON and re-serializes to the identical bytes
   ([Canonical terms](#canonical-terms-version-2)).
2. Its `scheme`, `binding` and `version` are `batch-settlement`, `xrpl-check-session` and `2`.
3. `session_id` equals `sessionId`; `network`, `pay_to`, `asset`, `issuer` and `asset_scale` equal
   the offer; `payer` is its payer; `ceiling_atomic` and `send_max_atomic` both equal its ceiling in
   atomic units; `transfer_fee_policy` is `fee_free_or_exempt`; `client_key` is its public JWK; and
   `credential_audience` is the origin of the resource URL, with scheme and host in lower case and
   no default port.
4. `expiration` is the requested length from now, within a tolerance the client sets, for example
   ±300 s.
5. `pricing` is a valid price table whose `version` equals `extra.pricingVersion`, at prices the
   client accepts; `resource_scope` is a non-empty array.
6. `sessionAuthorizationId` equals `"sha256:" + hex(SHA-256(canonicalTerms))`.
7. In `checkCreate`, `sendMax` has the offer's currency and issuer and the ceiling's value;
   `account`, `destination` and `expiration` equal `payer`, `pay_to` and `expiration`; `invoiceId`
   equals `upper(hex(SHA-256(sessionAuthorizationId)))`; `destinationTag` and `sourceTag` equal the
   terms' tags.

The Check commits to the terms through `InvoiceID`, so nothing the client did not check can bind the
payer. A payer that is not the client MUST run the same checks against the client's public key
before it signs.

### Open: `POST {sessions}/{sessionId}/open`

Body: `{ "signedCheckCreateBlob": "<hex>" }`. The facilitator validates, submits and waits for a
validated result ([`CheckCreate`](#checkcreate)), then answers with the session status:

```json
{ "sessionId": "ses_0123456789abcdef0123456789abcdef", "state": "OPEN", "checkId": "<64 hex>",
  "payer": "rGMTQpyhaDwWTqmw4dcYHj5NPJhtWNhtRW", "ceiling": "0.5", "committed": "0", "reserved": "0",
  "available": "0.5", "frozen": null, "snapshotDigest": null, "closeReason": null, "version": 2,
  "nonce": "<base64url>", "nonceExpiresAt": 1792688700, "settlementTransaction": null }
```

Only `OPEN` serves requests, and an `OPEN` answer carries the first nonce. Opening is idempotent on the
signed blob: a client that lost the answer, or got `OPEN_UNKNOWN`, sends the same blob again. After a
definitive failure the session is `PROPOSED` again, and the payer may sign a new `CheckCreate` for
the same terms before `createSubmitDeadline`.

### Close: `POST {sessions}/{sessionId}/close`

The client signs an empty-bodied `POST` like a paid request whose `accepted.amount` is `"0"`, with a
fresh request ID. The answer is the session status. When its state is `SETTLED` or `CLOSED_ZERO` it
also carries `PAYMENT-RESPONSE`:

```json
{ "success": true, "transaction": "<CheckCash hash or empty>", "network": "xrpl:1",
  "payer": "rGMTQpyhaDwWTqmw4dcYHj5NPJhtWNhtRW", "amount": "0.002289",
  "extra": { "sessionId": "ses_0123456789abcdef0123456789abcdef", "state": "SETTLED" } }
```

`amount` is the frozen total. `transaction` is the `CheckCash` hash when the resource server settled
the session while answering this close, and is otherwise empty. A close without `PAYMENT-SIGNATURE`
is refused `401` `payment_required`.

### Request lookup: `GET {sessions}/{sessionId}/requests/{requestId}`

A client that lost an answer asks for that request, signed like a close: empty body,
`accepted.amount` `"0"`, and `payment-identifier` `id` equal to `requestId`. The facilitator also
requires the method `GET` and a signed path ending in `/{sessionId}/requests/{requestId}`, so the
proof names that one request. The answer has `requestId`; `status` (`RESERVED`, `COMMITTED`,
`RELEASED` or `RECONCILIATION_REQUIRED`); `reserved`; `usageReceipt` once `COMMITTED`
([Replays](#replays)), else `null`; `releaseReason` and `reconciliationReason`; `pending`, true while
`RESERVED`; and the newest `nonce` and `nonceExpiresAt`. A request the facilitator never reserved is
`404` `request_not_found`. A lookup changes nothing.

## Canonical terms (version 2)

The facilitator persists the terms before the payer signs, and returns them as:

```text
{"binding":"xrpl-check-session","scheme":"batch-settlement","terms":{…},"version":2}
```

**Serialization.** RFC 8785 (JCS), restricted to a subset in which JCS equals sorted-key compact JSON
in every language: strings of printable ASCII (`0x20` to `0x7E`), integers within ±(2^53 − 1),
booleans, `null`, arrays and objects; no floats. A verifier re-serializes the parsed value and
compares bytes.

**Identifiers.**

```text
sessionAuthorizationId = "sha256:" + lowercase_hex(SHA-256(canonicalTerms))
InvoiceID              = uppercase_hex(SHA-256(UTF-8(sessionAuthorizationId)))
```

`sessionId`, `sessionAuthorizationId` and a request ID are different identifiers and MUST NOT be
substituted for one another.

| Term | Type | Meaning |
| --- | --- | --- |
| `session_id` | string | Facilitator-chosen, 1 to 128 characters of `[A-Za-z0-9_-]`; not a secret |
| `authorization_nonce` | string | Facilitator randomness, at least 16 characters |
| `tenant_id` | string | The facilitator's identifier of the resource server's account |
| `network` | string | `xrpl:{network_id}` |
| `payer` | string | `CheckCreate.Account`; differs from `pay_to` |
| `pay_to` | string | Merchant account: `CheckCreate.Destination` and `CheckCash.Account` |
| `asset`, `issuer` | string | `issuer` is `""` for XRP |
| `asset_scale` | integer | As `extra.assetScale` |
| `ceiling_atomic`, `send_max_atomic` | integer | The ceiling, twice: equal in version 1 |
| `transfer_fee_policy` | string | `fee_free_or_exempt` |
| `create_submit_deadline` | integer | A new `CheckCreate` must reach the facilitator before this ledger time; one admitted in time may validate after it |
| `expiration` | integer | `CheckCreate.Expiration`: validated-ledger time at proposal plus the session length |
| `settlement_grace_seconds` | integer | New requests stop at `expiration − settlement_grace_seconds` |
| `resource_scope` | array | Sorted, distinct route scopes `path:<prefix>` |
| `client_key` | object | Public JWK `{"crv":"Ed25519","kty":"OKP","x":"<base64url>"}` |
| `credential_audience` | string | The resource server's serialized origin (RFC 6454): lower case, no default port |
| `pricing` | object | The price table ([Metering profile](#metering-profile-price-table)) |
| `destination_tag`, `source_tag` | integer or `null` | Tags the Check transactions carry, 0 to 2^32 − 1 |

Every key is present. `create_submit_deadline` MUST be earlier than
`expiration − settlement_grace_seconds` (`session_window_too_short`). Changing any term needs a new
Check.

## `CheckCreate`

The payer signs exactly these fields, and the facilitator MUST refuse any other (`Memos`,
`TicketSequence`, `Signers`, `AccountTxnID` and the rest):

| Field | Rule |
| --- | --- |
| `TransactionType` | `CheckCreate` |
| `Account` | `payer` |
| `Destination` | `pay_to` |
| `SendMax` | `send_max_atomic` as an XRPL amount (a drops string for XRP, otherwise `{currency, issuer, value}`), compared numerically in that exact currency and issuer |
| `Expiration` | `expiration` |
| `InvoiceID` | The session's `InvoiceID`, compared case-insensitively |
| `DestinationTag`, `SourceTag` | Equal to the terms' tags when set, absent when `null` |
| `Sequence` | Positive: the payer's next Sequence. Tickets are not supported in version 1. |
| `LastLedgerSequence` | After the validated ledger and at most the facilitator's horizon beyond it |
| `Fee` | Drops, at most the facilitator's cap |
| `Flags` | Absent, `0` or `tfFullyCanonicalSig` (`0x80000000`) |
| `NetworkID` | Omitted when `network_id <= 1024`, otherwise equal to it, as in `exact` |
| `SigningPubKey`, `TxnSignature` | Single-signed by the account's master key, not disabled, or its `RegularKey` |

Against the validated ledger the facilitator MUST also check that the blob re-encodes to itself,
that its signature is valid, and that its `Sequence` is unused unless this very blob has validated.
For an issued currency it MUST check that the issuer exists, is not globally frozen and charges no
transfer fee unless exempt. It SHOULD check that the payer can fund `SendMax`: for an issued
currency, a trust line to the issuer that the issuer has not frozen and that holds at least
`SendMax`; for XRP, a balance covering `SendMax` above the account reserve, including the new
Check's owner reserve. This only turns away a payer who could not pay at the outset.

The facilitator persists the blob and its hash before submitting. The session opens only on a
validated `tesSUCCESS` that creates the Check, whose ID is
`SHA-512Half(0x0043 ‖ AccountID ‖ UInt32(Sequence))`. A definitive failure (a validated `tec` result,
or proof that the blob can no longer apply) returns the session to `PROPOSED`. Anything else is
unknown ([Recovery](#unknown-outcomes-and-recovery)).

## Paid requests

A request inside a session carries four headers.

### `PAYMENT-SIGNATURE`

A base64 x402 `PaymentPayload`:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "batch-settlement", "network": "xrpl:1",
    "asset": "524C555344000000000000000000000000000000", "payTo": "rfUom3iQifHWyw2KwH1fg7AKUYQBW73U5H",
    "amount": "0.002", "maxTimeoutSeconds": 60,
    "extra": { "binding": "xrpl-check-session", "version": "1", "issuer": "rhA4uZnenHBQM2My9mFYWjwKhu2i6DCSVA" }
  },
  "payload": { "sessionId": "ses_0123456789abcdef0123456789abcdef" },
  "extensions": {
    "http-message-signatures": {
      "info": { "registrationUrl": "https://rs.example/x402/sessions", "signatureSchemes": ["ed25519"], "tags": ["x402-xrpl-session"] }
    },
    "payment-identifier": {
      "info": { "required": true, "id": "req_0123456789abcdef" },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": { "required": { "type": "boolean" }, "id": { "type": "string", "minLength": 16, "maxLength": 128 } },
        "required": ["required"]
      }
    }
  }
}
```

| Field | Rule |
| --- | --- |
| `accepted.scheme`, `extra.binding`, `extra.version` | `batch-settlement`, `xrpl-check-session`, `"1"`, otherwise `session_scheme_mismatch` |
| `accepted.network`, `asset`, `payTo`, `extra.issuer`, `payload.sessionId` | Equal to the session's terms (`issuer` absent or `""` for XRP), otherwise `session_payment_mismatch` |
| `accepted.amount` | The most the client agrees to pay for this request, in ledger units |
| `accepted.maxTimeoutSeconds` | A positive integer, `60` when absent; not bound to the session |
| `payment-identifier` `info.id` | The request ID: 16 to 128 characters of `[A-Za-z0-9_-]`, used once per session. Missing: `400` `payment_identifier_required` |
| Other `extensions` content | Echoed from the `402`; not bound to the session |

`accepted` is not an echo of the offer: it carries the client's own maximum, and the offer's other
`extra` keys MAY be omitted. `extensions` is an echo: every extension the `402` advertised, with its
`info` and `schema`, and the `id` added to `payment-identifier`'s `info`. A malformed payload, or a
`PAYMENT-SIGNATURE` value longer than 8,192 characters, echoed extensions included, is
`session_payment_invalid`.

### `Content-Digest`

RFC 9530 over the exact body bytes, the empty body included: `sha-256=:<base64>:`, with that one
algorithm only.

### Request proof (RFC 9421)

`Signature-Input` and `Signature` carry exactly one signature, labelled `x402`:

```text
Signature-Input: x402=("@method" "@target-uri" "content-digest" "payment-signature");created=1800000000;expires=1800000060;nonce="nonce-0";keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";tag="x402-xrpl-session"
Signature: x402=:<base64 of the 64-byte Ed25519 signature>:
```

- **Covered components**: exactly `@method`, `@target-uri`, `content-digest` and
  `payment-signature`, each once and without component parameters. `@target-uri` is the absolute
  URI the client called. Its origin MUST be spelled exactly as `credential_audience`, because the
  resource server rebuilds the URI from its public origin and the raw path and query.
- **Parameters**: `created` and `expires` (integers), `nonce`, `keyid` and `tag` (strings), and
  optionally `alg`; no others. `keyid` is the session key's RFC 7638 thumbprint, `tag` is
  `x402-xrpl-session`, and `alg`, which clients SHOULD include, is `ed25519`.
- **Signature base**: as in RFC 9421 §2.5, in the component order the client listed, followed by
  `"@signature-params"`. Structured-field features outside this profile (tokens, decimals,
  booleans, byte sequences in `Signature-Input`) are refused.
- **Freshness**: with the facilitator's clock `now`, maximum proof age `maxAge` and clock skew
  `skew`, a proof is accepted only if `created <= now + skew`, `expires > now − skew` and
  `created < expires <= created + maxAge`.

### Nonces

- A nonce is 128 random bits in base64url. The facilitator issues one per session at open and
  rotates it after half its lifetime; every unexpired nonce stays valid, so concurrent requests can
  share one. The lifetime MUST be at least twice the maximum proof age. Typical values: lifetime
  300 s, maximum proof age 60 s, clock skew 30 s.
- Answers to open, reserve, commit and lookup carry the newest nonce and its `nonceExpiresAt`. The
  resource server returns it in `PAYMENT-RESPONSE` or in a `402`. A client SHOULD keep the nonce
  that expires last.
- A stale or unknown nonce is answered `session_nonce_stale` with a fresh one, and nothing is
  reserved. A client that knows no nonce, for example after a restart, signs with any value and
  takes the fresh one from that answer.
- Rotating a nonce commits no payment state, so `/verify` may rotate it too, when it answers a
  `lookup` or a stale nonce.
- Replays are stopped by the single-use request ID, not by consuming nonces.

### Verification

The resource server MUST check `Content-Digest` against the body it received, then settle a `reserve`
step: the client's payload, with the four headers, the method, the rebuilt target URI and the body's
SHA-256 added as `proof`. Before it reserves anything, the facilitator MUST:

1. Confirm the session belongs to the calling resource server, otherwise `session_not_found`.
2. Parse `PAYMENT-SIGNATURE` and match it to the terms, and to the forwarded payload, which MUST
   name the same request ([Facilitator interface](#facilitator-interface);
   `session_payment_mismatch`). Convert `accepted.amount` to atomic units exactly
   (`invalid_amount`, `amount_precision_exceeded`); for a close or a lookup it MUST be 0.
3. Check the target. Its origin MUST equal `credential_audience` and, for a paid request, its path
   MUST lie under a `path:` scope, where `path:/p` covers `/p` and everything below `/p/`
   (`session_scope_mismatch`). User information, fragments, backslashes, dot segments and
   percent-encoded `.`, `/` or `\` are refused (`target_uri_invalid`), so a proxy cannot resolve a
   path differently from this check.
4. Match `Content-Digest` to the body hash the resource server reports (`content_digest_invalid`).
5. Verify the proof: `session_proof_malformed`, `session_proof_components`,
   `session_proof_key_mismatch`, `session_proof_expired`, `session_nonce_stale`,
   `session_proof_invalid`.
6. Compute the request's reservation from the terms' price table (`pricing_model_mismatch`,
   `invalid_usage`). It MUST equal `paymentRequirements.amount` (`amount_mismatch`, with the
   reservation in `extra.expected`). If it exceeds the client's signed maximum, refuse
   `client_max_exceeded` with `required`, the needed amount in ledger units.
7. Reserve, as below.

So a resource server cannot reserve budget for a request the client did not sign, and no request
can cost the client more than the maximum it signed.

### Reserve, execute, commit

The binding reserves the maximum and charges the actual.

**Reserve**, as one atomic operation under the session's lock:

- A reservation MUST be positive (`invalid_reservation`).
- A known request ID with another body hash, model or reservation is `idempotency_conflict`. A
  committed, released or held request is refused `request_already_committed`,
  `request_already_released` or `request_reconciliation_required`. A request still `RESERVED` is
  answered `replayed: true`, and nothing more is reserved.
- At or after `expiration`: `check_expired`. A session not `OPEN`: `session_not_open`. At or after
  `expiration − settlement_grace_seconds` the facilitator starts closing the session (reason
  `settlement_grace`) and refuses `close_in_progress`.
- `committed + reserved + reservation` MUST NOT exceed the ceiling (`insufficient_session_budget`).
- A facilitator MAY limit each payer's request rate. It then refuses `payer_rate_limited`, with
  `retryAfterSeconds`, before reserving anything.

`0 <= committed`, `0 <= reserved` and `committed + reserved <= ceiling` MUST hold in every durable
state, across every replica that can change the session.

**Execute.** The resource server MUST NOT execute a request without a reservation, MUST NOT execute
one request ID twice, and MUST enforce the output limit it reserved for.

**Commit.** The resource server settles a `commit` step with the model, the raw usage, non-empty
metering evidence (for example the upstream request ID) and the body hash, and names the charge as
`paymentRequirements.amount`. The facilitator prices the usage with the terms' table and refuses any
other figure (`amount_mismatch`, with the table's charge in `extra.expected`) before it writes
anything. A charge above the reservation moves the request to `RECONCILIATION_REQUIRED`
(`usage_exceeds_reservation`) instead of charging the reservation.
Otherwise one atomic operation moves the reservation out of `reserved`, adds the charge to
`committed` and stores an immutable receipt. An identical repeated commit returns that receipt; a
different one is `idempotency_conflict`.

**Release** (a `release` step) needs a definitive no-billable-work reason: `execution_not_started`,
`no_billable_usage`, or `reconciled_no_billable_usage` for a held request; a timeout or a client
disconnect is not one. A release of a request that is still `RESERVED` carries the `proof` it was
reserved with. One that carries another attempt's proof is refused `request_in_progress`, because
the attempt holding the reservation may be running. When usage is unknown after work may have run,
the resource server holds the request for reconciliation (a `reconcile` step), which blocks the
session's final amount until the request is committed or released.

### `PAYMENT-RESPONSE`

```json
{
  "success": true, "transaction": "", "network": "xrpl:1",
  "payer": "rGMTQpyhaDwWTqmw4dcYHj5NPJhtWNhtRW", "amount": "",
  "extra": {
    "sessionId": "ses_0123456789abcdef0123456789abcdef", "requestId": "req_0123456789abcdef",
    "chargedAmount": "0.000763", "cumulativeCommitted": "0.002289", "available": "0.497711",
    "receiptDigest": "<64 lowercase hex>", "nonce": "<base64url>", "nonceExpiresAt": 1792688700
  }
}
```

`transaction` and `amount` are empty: no ledger transaction happens per request. `chargedAmount`,
`cumulativeCommitted` and `available` are ledger units. **The commitment identifier** of a request
is its `receiptDigest`, with `sessionId` and `requestId`: a SHA-256 digest the facilitator computes
over the request's identity, body hash, model, price-table digest, raw usage, metering evidence,
charge and the digest of the client's proof headers. Like `pricingDigest` and `snapshotDigest`, it
is opaque: only the facilitator computes it, and other parties compare it. The client MUST check
that `sessionId` is its session and that `chargedAmount` does not exceed the maximum it signed.
Answers to concurrent requests arrive in any order; a client MUST NOT let its committed total move
backwards.

### Replays

A request ID is used once per session. Sent again, with the same body under a fresh proof, a request
never runs again:

- still `RESERVED`, so the first attempt may be running: `409` `request_in_progress`;
- `COMMITTED`: `409` `request_already_committed` with `usageReceipt`, the stored receipt
  (`sessionId`, `requestId`, `model`, `pricingDigest`, `inputTokens`, `outputTokens`,
  `cacheReadTokens`, `cacheWriteTokens`, `actualCost`, `cumulativeCommitted`, `receiptDigest`, and
  `available`, `nonce` and `nonceExpiresAt` as `null`). The client applies it like a fresh receipt,
  with `actualCost` as the charge;
- `RELEASED` or `RECONCILIATION_REQUIRED`: `409` `request_already_released` or
  `request_reconciliation_required`.

This is how the binding uses the `payment-identifier` extension: a repeat never runs again, and its
answer is the request's state, with the stored receipt once it is committed, never a cached body.
The extension's default, a cached response for the same `id` and payload, does not apply: the
facilitator stores receipts, not response bodies.

## Metering profile: price table

Terms version 2 carry the session's metering profile as a price table. LLM token pricing is one use;
a flat price per call is an entry with zero rates and a `fixedAtomic`. The binding does not depend
on what is metered: `model` names any metered operation.

The resource server's proposal carries the table in camelCase; the canonical terms carry it in
snake_case, with every key present and `models` sorted by `model`.

```json
{
  "version": "example-2026-10",
  "unitTokens": 1000000,
  "rounding": "ceil",
  "models": [
    { "model": "flat", "inputRateAtomic": 400000, "outputRateAtomic": 1600000,
      "cacheReadRateAtomic": 0, "cacheWriteRateAtomic": 0, "fixedAtomic": 3, "minimumAtomic": 10 },
    { "model": "long", "inputRateAtomic": 1250000, "outputRateAtomic": 10000000,
      "cacheReadRateAtomic": 125000, "cacheWriteRateAtomic": 1562500, "fixedAtomic": 0, "minimumAtomic": 0,
      "longContext": { "thresholdTokens": 200000, "inputRateAtomic": 2500000, "outputRateAtomic": 15000000,
                       "cacheReadRateAtomic": 250000, "cacheWriteRateAtomic": 3125000 } }
  ]
}
```

- Rates are atomic units per `unitTokens` tokens. `inputRateAtomic` and `outputRateAtomic` are
  required; cache rates, `fixedAtomic` and `minimumAtomic` default to 0. `longContext` is optional
  and, when present, has all five fields. `rounding` is
  `ceil` or `floor`. Model names are distinct and non-empty; integers are 0 to 2^53 − 1,
  `unitTokens` is positive, and `thresholdTokens` is 1 to 10^12.
- **Charge** for usage `(input, output, cacheRead, cacheWrite)`, each 0 to 10^12. The long-context
  rates apply when `input + output + cacheRead + cacheWrite > thresholdTokens`, else the base rates:

  ```text
  metered = input·inputRate + output·outputRate + cacheRead·cacheReadRate + cacheWrite·cacheWriteRate
  charge  = max(minimumAtomic, fixedAtomic + round(metered / unitTokens))
  ```

  where `round` is the table's rounding.
- **Reservation** for `promptTokens` and `maxOutputTokens`: in each tier the request could reach (the
  long-context tier too when `promptTokens + maxOutputTokens > thresholdTokens`), compute
  `max(minimumAtomic, fixedAtomic + ceil((promptTokens·max(inputRate, cacheReadRate, cacheWriteRate) + maxOutputTokens·outputRate) / unitTokens))`,
  and take the largest. Usage within those limits, `input + cacheRead + cacheWrite <= promptTokens`
  and `output <= maxOutputTokens`, never costs more.
- An amount above 2^63 − 1 atomic units is `insufficient_session_budget` at reservation, and holds
  the request for reconciliation at commit.

Prices never change within a session; a different table needs a new session.

## Close, settlement and expiry

### Close and freeze

Closing is asynchronous and idempotent; the first close fixes its reason and time.

1. `OPEN` becomes `CLOSING` on the client's signed close (`client_requested`), on the merchant's
   close with its own credentials, on the facilitator's policy (for example `budget_threshold`,
   `idle_timeout`, `daily_cutoff`, `expiry_margin`), or on a reservation that arrives inside the
   settlement grace (`settlement_grace`). Closing a session that never opened is
   `close_in_invalid_state`.
2. New reservations are refused. Requests reserved before the close may still commit or release, and
   count toward the total.
3. If a reservation is still unresolved at the facilitator's drain deadline, the session becomes
   `CLOSE_BLOCKED` for an operator. The final amount is never guessed.
4. Once nothing is reserved, the facilitator freezes `final = committed` exactly once, with a
   snapshot digest over the session, Check and amount: `AWAITING_MERCHANT_SIGNATURE` when positive,
   `CLOSED_ZERO` when zero.

The facilitator MUST stop admitting requests at `expiration − settlement_grace_seconds` and SHOULD
close well before then, so that signing, submission, reconciliation and a retry fit before the Check
expires.

### Redemption (`CheckCash`)

While the frozen amount can still be cashed (`AWAITING_MERCHANT_SIGNATURE`, or `SETTLEMENT_FAILED`
with a replaceable attempt, before `expiration`), the answer to a `close` step carries the frozen
intent as `extra.settlementIntent`, and a repeated close returns it again: `sessionId`,
`sessionAuthorizationId`, `snapshotDigest`, `network`, `checkId`, `account` (`pay_to`), `amount` (an
XRPL amount `{currency, issuer, value}`, `value` in drops for XRP), `sourceTag` and `expiration`. The
merchant signer signs, and the resource server settles a `cash` step with the blob and
`snapshotDigest`, for the frozen amount:

| Field | Rule |
| --- | --- |
| `TransactionType` | `CheckCash` |
| `Account` | `pay_to` |
| `CheckID` | The session's Check |
| `Amount` | Exactly the frozen amount in the session's asset and issuer; a drops string for XRP |
| `SourceTag` | The terms' `source_tag`, absent when `null` |
| `LastLedgerSequence` | Within the horizon, with a validation window that closes before the Check's `Expiration` at a pessimistic ledger interval (`last_ledger_sequence_beyond_expiration`). An admission rule, not a landing guarantee: the ledger itself refuses a cash after `Expiration` |
| `DeliverMin`, any other field | Refused |

`Sequence`, `Fee`, `Flags`, `NetworkID` and the signature follow the `CheckCreate` rules for the
`pay_to` account. The facilitator MUST also require the frozen snapshot's digest
(`snapshot_digest_mismatch`); the Check present at the validated ledger, destined to `pay_to`, with a
`SendMax` in the same asset that covers the amount (`check_not_found`, `check_mismatch`,
`amount_exceeds_send_max`); no issuer transfer fee unless exempt; and an unexpired Check
(`check_expired`). For an issued currency, `pay_to` must also be able to hold the asset when it
cashes, for example on a trust line the issuer has not frozen; otherwise the cash fails, and the
merchant signs a replacement once it can receive the asset.

The merchant signer MUST sign only an amount backed by the frozen snapshot, MUST check that its own
account is the Check's destination, and MUST serialize its account's Sequences, because concurrent
sessions settle from one account.

A validated `tesSUCCESS` is `SETTLED`. A validated `tec` result is `SETTLEMENT_FAILED`, recording
whether the Check still exists. While it does and has not expired (for example after
`tecPATH_PARTIAL`, an issued-currency payer short of funds), the merchant MAY sign a replacement that
keeps the network, `CheckID`, account, amount, asset, issuer and tag and changes only `Sequence`,
`Fee` and `LastLedgerSequence`. A successful cash consumes the Check, so a session is paid at most
once.

### Zero use and cleanup

A session frozen at zero is `CLOSED_ZERO`, with no `CheckCash`. Its Check stays on the ledger until
cancelled: before expiry by the payer or `pay_to`, after expiry by any account. The facilitator
accepts a signed cleanup `CheckCancel` (a `cancel` step, with `CheckID`, the terms' `SourceTag` and
the `CheckCreate` transaction mechanics) for a zero-use session, or for any session once it has
recorded the Check's expiry (`EXPIRED_UNSETTLED`, `EXPIRED_RECONCILIATION_REQUIRED`); otherwise
`cleanup_not_allowed`. It never accepts one while an opening or settlement outcome is unknown. Only a
validated `CheckCancel` changes the session: a zero-use session becomes `CANCELLED_ZERO`, and an
expired, unpaid session stays a receivable.

### Expiry and cancellation

A Check is expired once a validated ledger closes at or after its `Expiration`, and can then never
be cashed. Before that, the ledger lets the payer cancel it, and no merchant policy can prevent it.
On expiry, or on a validated `CheckCancel` of the session's Check, the facilitator stops new work:

- a serving session with nothing reserved freezes its committed total, which becomes
  `EXPIRED_UNSETTLED` or `CANCELLED_UNSETTLED` when positive, and `CLOSED_ZERO` or `CANCELLED_ZERO`
  when zero;
- a session with reservations becomes `EXPIRED_RECONCILIATION_REQUIRED` or
  `CANCEL_RECONCILIATION_REQUIRED`, and freezes once they are resolved;
- a frozen session not yet paid becomes `EXPIRED_UNSETTLED` or `CANCELLED_UNSETTLED`;
- a proposal past `createSubmitDeadline` becomes `ABANDONED`.

A missing Check is not proof of cancellation, since a cash also removes it: the facilitator MUST
identify the validated transaction that removed it. `EXPIRED_UNSETTLED` and `CANCELLED_UNSETTLED`
are receivables. Committed usage is never zeroed, refunded or rewritten; collecting or writing it
off happens outside the protocol.

### Unknown outcomes and recovery

- `SUCCESS` and `FAILURE` are definitive and carry validated-ledger evidence: a validated
  `tesSUCCESS`; a validated `tec`; or proof, at a validated ledger past `LastLedgerSequence`, that the
  blob's Sequence is still unused or was used by another transaction. Everything else, including
  transport errors, provisional results, `tef`, `tel` and `ter` answers and gaps in server history,
  is unknown, and is never cached as a failure.
- Every signed `CheckCreate` and `CheckCash` blob and its hash are persisted before submission. An
  unknown outcome is resolved by looking up that exact blob, and rebroadcasting it while it can
  still apply: one hash applies at most once. A cleanup `CheckCancel` moves no funds; only its hash
  is recorded, and the session changes only when the facilitator finds the validated cancel.
- A replacement `CheckCreate` needs a definitive failure of the last one
  (`opening_replacement_not_proven_safe`); a replacement `CheckCash` needs a definitive failure and
  the Check still present (`settlement_replacement_not_proven_safe`). While an outcome is unknown,
  the facilitator MUST NOT cancel the Check, change the frozen amount or sign another economic
  commitment.
- If validated evidence later contradicts a recorded failure, the ledger wins: the session becomes
  `OPEN` or `SETTLED`, and the facilitator raises an alert.
- Facilitator state is durable and shared by every replica, and a crash between steps is recovered
  from it. A resource server that loses the answer to a reservation tries to release that request
  (`execution_not_started`, with that attempt's `proof`) before answering `503`. When another
  attempt holds the reservation, the release is refused `request_in_progress` and the resource
  server answers `409` `request_in_progress` instead. If the release fails too, the request stays
  reserved until it is reconciled.

### Session states

| State | Meaning |
| --- | --- |
| `PROPOSED` | Terms fixed; no Check yet |
| `ABANDONED` | Create deadline passed without a Check (terminal) |
| `OPENING`, `OPEN_UNKNOWN` | `CheckCreate` submitted; outcome pending or unknown |
| `OPEN` | Serving requests |
| `CLOSING`, `CLOSE_BLOCKED` | Draining; blocked on an unresolved request |
| `AWAITING_MERCHANT_SIGNATURE` | Positive amount frozen |
| `SETTLING`, `SETTLEMENT_UNKNOWN`, `SETTLEMENT_FAILED` | `CheckCash` submitted; outcome unknown; definitively failed |
| `SETTLED` | Cashed for the frozen amount (terminal) |
| `CLOSED_ZERO` | Frozen at zero (terminal; cleanup makes it `CANCELLED_ZERO`) |
| `CANCEL_RECONCILIATION_REQUIRED`, `EXPIRED_RECONCILIATION_REQUIRED` | Cancelled or expired with requests to resolve |
| `CANCELLED_ZERO` | Check cancelled, nothing owed (terminal) |
| `CANCELLED_UNSETTLED`, `EXPIRED_UNSETTLED` | Check cancelled, or expired (it may stay on the ledger until cleanup), with committed usage owed (terminal receivables) |

Requests are `RESERVED`, `COMMITTED`, `RELEASED` or `RECONCILIATION_REQUIRED`.

## Facilitator interface

Sessions use the standard x402 facilitator interface: `POST /verify`, `POST /settle` and
`GET /supported`. Resource servers call it, never clients.

**Envelope.** Each call is the x402 v2 request `{x402Version, paymentPayload, paymentRequirements}`.

- `paymentRequirements` is the resource server's offer for this binding, with `amount` set for the
  step (below).
- `paymentPayload.payload.type` names the step, as in the other `batch-settlement` bindings. x402
  v2 lets a scheme settle one payment more than once and asks it to say how the settles differ
  (§7.2): here, by `type`.
- For a step that carries a client's request (`reserve`, `commit`, `release`, `reconcile`, a client's
  `close`, `lookup`), `paymentPayload` is the client's `PAYMENT-SIGNATURE` payload; the resource
  server adds the step's fields to its `payload`, beside the client's `sessionId`. Where the step
  carries a proof, the facilitator MUST check that this payload and the one in
  `proof.paymentSignature` agree on `accepted` (`scheme`, `network`, `asset`, `payTo`, `amount`,
  `maxTimeoutSeconds`, `extra.binding`, `extra.version`, `extra.issuer`), `payload.sessionId` and
  the `payment-identifier` `id`. The fields the resource server added are not compared.
- For the other steps the resource server writes `paymentPayload` itself, with `accepted` equal to
  `paymentRequirements`.

| Step | Endpoint | `paymentRequirements.amount` | `payload` fields besides `type` | Success |
| --- | --- | --- | --- | --- |
| `propose` | `/settle` | `"0"` | `payer`, `ceiling`, `sessionDurationSeconds`, `clientKey`, `pricing`, `resourceScope`, `credentialAudience`, `idempotencyKey`; optionally `destinationTag`, `sourceTag` | `extra`: the [proposal](#propose-post-sessions), and `replayed` |
| `open` | `/settle` | `"0"` | `sessionId`, `signedCheckCreateBlob` | `transaction`: the `CheckCreate` hash; `extra`: the session status with the first nonce |
| `reserve` | `/settle` | The reservation | `model`, `promptTokens`, `maxOutputTokens`, `proof` | `extra`: `sessionId`, `requestId`, `reserved`, `available`, `replayed`, `nonce`, `nonceExpiresAt` |
| `commit` | `/settle` | The charge | `requestBodyHash`, `model`, `usage`, `meteringEvidence` | `extra`: the receipt |
| `release` | `/settle` | `"0"` | `requestBodyHash`, `reason`; `proof` while the request is reserved | `extra`: the session status |
| `reconcile` | `/settle` | `"0"` | `requestBodyHash`, `reason` | `extra`: the session status |
| `close` | `/settle` | `"0"` | `sessionId`, `reason`; `proof` when the client asked | `extra`: the session status, with `settlementIntent` while the frozen amount can be cashed |
| `cash` | `/settle` | The frozen amount | `sessionId`, `snapshotDigest`, `signedCheckCashBlob` | `transaction`: the `CheckCash` hash; `amount`: the frozen amount; `extra`: the session status |
| `cancel` | `/settle` | `"0"` | `sessionId`, `signedCheckCancelBlob` | `transaction`: the `CheckCancel` hash; `extra`: the session status |
| `reserve` | `/verify` | The reservation | As for `/settle` | `extra`: `sessionId`, `requestId`, `reservation`. Runs [Verification](#verification) steps 1 to 6 and holds nothing, so it does not promise the reserve |
| `lookup` | `/verify` | `"0"` | `proof` | `extra`: the [request's record](#request-lookup-get-sessionssessionidrequestsrequestid) and the newest nonce |

- `proof` is `{method, targetUri, contentDigest, bodySha256, paymentSignature, signatureInput,
  signature}`. `bodySha256` and `requestBodyHash` are the lowercase hex SHA-256 of the body the
  resource server received.
- `usage` is `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`, and
  `meteringEvidence` a non-empty map of strings.
- The request ID is the client's `payment-identifier` `id`.
- The session status is `sessionId`, `state`, `checkId`, `payer`, `ceiling`, `committed`,
  `reserved`, `available`, `frozen`, `snapshotDigest`, `closeReason`, `version`, and, where the step
  has them, `nonce`, `nonceExpiresAt` and `settlementTransaction`.
- The receipt is the `usageReceipt` of [Replays](#replays), with `available` and the newest nonce.

**Amounts.** Every amount on this interface is in ledger units: drops for XRP, the issued-currency
value otherwise.

- `paymentRequirements.amount` is what the step reserves, charges or transfers, and `"0"` for the
  others.
- The session's terms decide that amount. A facilitator MUST refuse another figure with
  `amount_mismatch`, putting its own in `extra.expected`, before it writes anything. A resource server
  whose prices changed after a session began therefore still charges that session the session's own
  table.

**Answers.**

- A success is `isValid: true` or `success: true`, with `extra` as above.
- A settle that records an off-ledger commitment (`propose`, `reserve`, `commit`, `release`,
  `reconcile`, `close`) has `transaction` and `amount` empty, as `transaction` names a ledger
  transaction only (x402 v2 §5.3).
- Every successful settle carries its non-empty commitment identifier in `extra`: the `sessionId`
  for every step, with the `requestId` for `reserve` and `commit`, and the receipt's
  `receiptDigest` for `commit`. `open`, `cash` and `cancel` also return their transaction's hash in
  `transaction`.
- A refusal is `isValid: false` or `success: false`, with the binding's code in `invalidReason` or
  `errorReason`. Its `extra` carries what the resource server needs to answer its client:
  - `nonce` and `nonceExpiresAt` for `session_nonce_stale`;
  - `required` for `client_max_exceeded`;
  - `retryAfterSeconds` for `payer_rate_limited`;
  - `usageReceipt` for `request_already_committed`;
  - `expected` for `amount_mismatch`.
- A `CheckCreate`, `CheckCash` or `CheckCancel` that was broadcast but whose outcome is not known is
  `settlement_pending` (x402 v2 §9), with its hash in `transaction` and the session status in
  `extra`. A `CheckCreate` or `CheckCash` the ledger refused is `invalid_transaction_state`, also
  with the session status; a refused `CheckCancel` is `cleanup_failed`, without it.
- A refusal is HTTP `200`; a missing or unknown resource-server credential is `401`, and an
  unavailable ledger `503`.

A `reserve` settle for the request in [`PAYMENT-SIGNATURE`](#payment-signature), abridged:

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { "scheme": "batch-settlement", "network": "xrpl:1", "asset": "524C555344000000000000000000000000000000",
                  "payTo": "rfUom3iQifHWyw2KwH1fg7AKUYQBW73U5H", "amount": "0.002", "maxTimeoutSeconds": 60,
                  "extra": { "binding": "xrpl-check-session", "version": "1", "issuer": "rhA4uZnenHBQM2My9mFYWjwKhu2i6DCSVA" } },
    "payload": {
      "sessionId": "ses_0123456789abcdef0123456789abcdef",
      "type": "reserve", "model": "flat", "promptTokens": 700, "maxOutputTokens": 1024,
      "proof": { "method": "POST", "targetUri": "https://rs.example/v1/chat/completions", "contentDigest": "sha-256=:…:",
                 "bodySha256": "<64 hex>", "paymentSignature": "<the client's header>",
                 "signatureInput": "x402=(…)", "signature": "x402=:…:" }
    },
    "extensions": {
      "http-message-signatures": {
        "info": { "registrationUrl": "https://rs.example/x402/sessions", "signatureSchemes": ["ed25519"], "tags": ["x402-xrpl-session"] }
      },
      "payment-identifier": {
        "info": { "required": true, "id": "req_0123456789abcdef" },
        "schema": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "type": "object",
          "properties": { "required": { "type": "boolean" }, "id": { "type": "string", "minLength": 16, "maxLength": 128 } },
          "required": ["required"]
        }
      }
    }
  },
  "paymentRequirements": {
    "scheme": "batch-settlement", "network": "xrpl:1", "asset": "524C555344000000000000000000000000000000",
    "payTo": "rfUom3iQifHWyw2KwH1fg7AKUYQBW73U5H", "amount": "0.001922", "maxTimeoutSeconds": 60,
    "extra": { "binding": "xrpl-check-session", "version": "1", "paymentFlow": "escrow", "assetScale": 6,
               "issuer": "rhA4uZnenHBQM2My9mFYWjwKhu2i6DCSVA" }
  }
}
```

```json
{ "success": true, "transaction": "", "network": "xrpl:1", "payer": "rGMTQpyhaDwWTqmw4dcYHj5NPJhtWNhtRW", "amount": "",
  "extra": { "sessionId": "ses_0123456789abcdef0123456789abcdef", "requestId": "req_0123456789abcdef",
             "reserved": "0.001922", "available": "0.498078", "replayed": false,
             "nonce": "<base64url>", "nonceExpiresAt": 1792688700 } }
```

**Authentication.** Every call requires the resource server's own credentials, never the client's,
for example a bearer API key per resource-server account.

- The facilitator binds each session to that account (`tenant_id`).
- It refuses another account's session as `session_not_found`.
- It lets each account use only its own `payTo` accounts, origins and route scopes
  (`tenant_not_authorized`).

**Discovery.** `GET /supported` lists the binding as one entry in `kinds`, beside the response's
`extensions` and `signers` (x402 v2 §7.3):

```json
{"x402Version": 2, "scheme": "batch-settlement", "network": "xrpl:<id>", "extra": {"binding": "xrpl-check-session", "version": "1"}}
```

A facilitator MUST include `extra.binding`, because two XRPL bindings share `batch-settlement` on
`xrpl:*`. Clients still pick a binding from the `402` offer. A facilitator MAY offer further
endpoints of its own, such as a list of sessions waiting for the merchant's signature; they are
outside this binding.

## Error codes

The resource server answers the client:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 402 | `payment_required`, `session_payment_invalid`, `session_scheme_mismatch`, `session_proof_malformed`, `content_digest_invalid` | Missing or malformed payment headers; another scheme, binding or version; a body that does not match its digest |
| 402 | `session_nonce_stale` | `extra` carries a fresh `nonce`; retry with the same request ID |
| 402 | `client_max_exceeded` | `amount` carries the reservation the request needs |
| 402 | any other verification or budget refusal | For example `insufficient_session_budget`, `session_not_open`, `check_expired`, `close_in_progress` |
| 409 | `request_in_progress`, `request_already_committed`, `request_already_released`, `request_reconciliation_required` | [Replays](#replays) |
| 429 | `payer_rate_limited` | With `retryAfterSeconds` and `Retry-After`; nothing was reserved |
| 400 | `request_not_priced` | The resource server cannot price the request |
| 400 | `payment_identifier_required` | The payload has no `payment-identifier` `id` |
| 503 | `facilitator_unavailable` | With `Retry-After`; nothing ran. Retry, under a new request ID if the same one is answered `409` |

On the close and lookup endpoints, a missing `PAYMENT-SIGNATURE` or an unusable proof is refused
`401` before the facilitator, a payload without a `payment-identifier` `id` `400`
`payment_identifier_required`, and a payload that does not parse or names another session or request
`422`. A stale nonce is `401` `session_nonce_stale` with `nonce` and `nonceExpiresAt` at the top
level. The propose endpoint adds the `400` refusals listed under [Propose](#propose-post-sessions).
Otherwise the session endpoints relay a refused step's code with the status listed below. A paid
request is answered as in the table above, and an open whose outcome is pending or failed answers
the session status.

The facilitator returns these codes in `invalidReason` or `errorReason`, each with the prefix
`invalid_batch_settlement_xrpl_check_` before it, as the other `batch-settlement` bindings prefix
theirs. The codes x402 itself defines (`invalid_payload`, `invalid_payment_requirements`,
`unsupported_scheme`, `invalid_network`, `invalid_transaction_state`, `settlement_pending`,
`unexpected_verify_error`, `unexpected_settle_error`) carry no prefix. The resource server answers
its client and the session endpoints answer theirs with the code alone. The status after each is the
one a session endpoint gives its client: `422` unless a status follows the code, and a status in
parentheses covers the codes back to the previous semicolon.

- **Any step**: `invalid_request_body`, `invalid_payload` (also for step fields that fail
  validation, such as an empty `meteringEvidence`), `invalid_payment_requirements`,
  `unsupported_scheme`, `invalid_network`, `amount_mismatch`; `tenant_unauthenticated` (401);
  `tenant_not_authorized` (403); `session_not_found` (404); `idempotency_conflict` (409);
  `ledger_unavailable` (503). The facilitator itself answers `tenant_unauthenticated` with `401` and
  `ledger_unavailable` with `503`.
- **Proposal**: `ceiling_out_of_policy`,
  `session_duration_out_of_policy`, `session_window_too_short`, `invalid_network`,
  `invalid_credential_audience`, `invalid_session_key`, `non_canonical_terms`,
  `payer_is_destination`, `invalid_currency_code`,
  `non_canonical_currency_code`, `issuer_required`, `invalid_asset_scale`, `invalid_xrp_terms`,
  `invalid_ceiling`, `invalid_send_max`, `invalid_tag`, `invalid_amount`,
  `amount_precision_exceeded`, `invalid_pricing_identity`, `invalid_pricing_unit`,
  `invalid_pricing_amount`, `invalid_pricing_rounding`, `invalid_pricing_threshold`,
  `mainnet_asset_not_supported`, `rlusd_issuer_not_official`; and the payer admission checks,
  repeated at open: `payer_not_allowed`, `payer_has_unpaid_receivable` (403); `payer_ceiling_limit`,
  `payer_session_limit`, `tenant_exposure_limit` (409).
- **Open**: `signed_blob_invalid`, `transaction_type_mismatch`, `unsupported_transaction_fields`,
  `unsupported_transaction_flags`, `sequence_required`, `last_ledger_sequence_required`,
  `fee_too_high`, `network_id_mismatch`, `signature_invalid`, `account_not_found`,
  `master_key_disabled`, `signing_key_not_authorized`, `last_ledger_sequence_beyond_horizon`,
  `signed_blob_economic_intent_mismatch`, `issuer_not_found`, `issuer_transfer_fee_unsupported`;
  `sequence_already_used`, `last_ledger_sequence_passed`, `issuer_globally_frozen`,
  `payer_trust_line_missing`, `payer_trust_line_frozen`, `payer_balance_insufficient`,
  `session_not_proposed`, `opening_status_unknown`, `opening_replacement_not_proven_safe`,
  `create_deadline_passed`, `attempt_identity_conflict`, `stale_attempt`, `settlement_pending`,
  `invalid_transaction_state` (409). Settlement and cleanup blobs get the same transaction checks,
  and a `CheckCash` the same `attempt_identity_conflict` and `stale_attempt`.
- **Request**: `session_payment_invalid`, `session_scheme_mismatch`, `session_payment_mismatch`,
  `target_uri_invalid`, `content_digest_invalid`, `session_proof_malformed`,
  `pricing_model_mismatch`, `invalid_usage`, `invalid_reservation`; `session_scope_mismatch` (403);
  `session_proof_components`, `session_proof_key_mismatch`, `session_proof_expired`,
  `session_nonce_stale`, `session_proof_invalid` (401); `client_max_exceeded`,
  `request_already_committed`, `request_already_released`, `request_reconciliation_required`,
  `check_expired`, `session_not_open`, `close_in_progress`, `insufficient_session_budget` (409);
  `payer_rate_limited` (429); and, for a lookup, `request_not_found` (404).
- **Commit, release, reconcile**: `release_reason_not_allowed`; `reservation_unknown`,
  `usage_exceeds_reservation`, `request_not_reserved`, `request_in_progress` (409).
- **Close and cash**: `check_mismatch`, `amount_exceeds_send_max`,
  `last_ledger_sequence_beyond_expiration`; `close_in_invalid_state`, `settlement_not_frozen`,
  `snapshot_digest_mismatch`, `settlement_already_complete`, `settlement_status_unknown`,
  `settlement_not_ready`, `settlement_replacement_not_proven_safe`, `check_not_found`,
  `check_expired`, `settlement_pending`, `invalid_transaction_state` (409).
- **Cancel**: `cancel_account_not_permitted`; `cleanup_not_allowed`, `check_not_open`,
  `cleanup_failed`, `settlement_pending` (409).

Facilitators MAY return other codes for internal faults.

## Trust model

This binding is **capital-backed**, as the generic scheme defines it
([Capital-backed](./scheme_batch_settlement.md#capital-backed)): the commitment is a delegated
authorization against the payer's wallet balance, and no intermediary underwrites it. A Check is
the payer's on-ledger authorization for `pay_to` to collect up to `SendMax` until `Expiration`.
`CheckCreate` locks no funds, so the merchant carries the risk of every committed request until its
`CheckCash` validates, within the ceiling the ledger enforces.

The ledger guarantees that only `pay_to` can cash the Check, for at most `SendMax` in the Check's
asset and issuer, only before `Expiration`, and only once; `InvoiceID` binds the Check to the terms,
including the client's session key. It does not guarantee that the payer still has the funds when
the merchant cashes, that the payer will not cancel the Check before expiry, or, for an issued
currency, that the issuer will not freeze the payer's trust line or claw back its balance. Each
leaves committed usage unpaid.

Merchants and facilitators SHOULD bound that risk:

- **Short sessions.** Bound `maxSessionSeconds`, stop new work at the settlement grace, and close on
  idle, at a budget threshold or on a schedule, so value at risk settles quickly.
- **Payer admission and caps.** Size `extra.ceiling.max` to the exposure the merchant accepts.
  Facilitators MAY admit only listed payers (`payer_not_allowed`); cap each payer's session ceiling
  (`payer_ceiling_limit`), live sessions (`payer_session_limit`) and request rate
  (`payer_rate_limited`); cap the sum of a resource server's open ceilings per asset
  (`tenant_exposure_limit`); and refuse payers with unpaid receivables
  (`payer_has_unpaid_receivable`).
- **Balance and reserve checks** at open ([`CheckCreate`](#checkcreate)). They reduce the risk; they
  do not remove it.

Documentation and interfaces MUST describe a Check as an authorized ceiling, never as funded,
locked, escrowed or prepaid; the flow name `escrow` names an order of calls
([Protocol flow](#protocol-flow)).

The payer is exposed to at most `SendMax` per session. Within it, a request costs at most its signed
maximum, and the cash the facilitator submits is the frozen committed total. Because `pay_to` can
cash up to `SendMax` directly on the ledger, a merchant could take more than the committed total by
bypassing the facilitator. The facilitator detects such a cash, a `CheckCash` it did not submit, but
cannot prevent it: it stops an open session's new requests, raises an alert and leaves the outcome
to an operator. Payers SHOULD size ceilings to the merchant they trust.

## Security considerations

- **Proof of possession, not a bearer credential.** The session ID is not a secret. Authority comes
  from the session key, whose public JWK is in the terms and so in the Check's `InvoiceID`; the
  private key never leaves the client. A payer service that signs `CheckCreate` for a client binds
  the client's key, not its own.
- **Request binding and replay.** A proof covers the method, the absolute target URI, the body
  digest and the payment payload, so it cannot move to another route, body, session or maximum. It
  expires within the maximum proof age and needs a live nonce, and a request ID is reserved once.
- **Target confusion.** Resource servers MUST rebuild the target URI from their public origin and
  the raw path and query, never from the client's `Host` header; the facilitator refuses paths a
  proxy might normalize differently before it checks scopes.
- **The resource server's authority.** It cannot reserve without the client's proof or charge more
  than the client signed for, and every charge is recomputed from the signed price table. Usage
  reports remain trusted financial input, so the facilitator authenticates the resource server and
  records its evidence in the receipt.
- **No facilitator custody.** The facilitator never holds the payer's or the merchant's keys. It
  validates every blob against the persisted intent before submitting it.
- **Transport.** Session and facilitator endpoints SHOULD use HTTPS; plain `http` is for local
  development. Receipts and session answers are not signed, so their integrity rests on the
  connection to the resource server.
- **Key compromise.** A stolen session key can sign requests up to the session's remaining ceiling,
  and nonce rotation does not revoke it: close the session, and open a new one for a new key.
  Whoever holds the merchant's signing key can cash the Check up to `SendMax`
  ([Trust model](#trust-model)).
- **Network binding.** As with `exact`, `NetworkID` is omitted on networks with `network_id <= 1024`,
  so payers SHOULD use separate accounts on mainnet, testnet and devnet.
- **Assets and issuers.** Facilitators MUST compare currency and issuer, never a symbol. Freezes,
  clawback and transfer-fee changes can make an unexpired Check uncollectible; version 1 refuses to
  cash while a fee applies, rather than debit the payer more than the session charged.
- **Cost of abuse.** An unused Check costs the payer an owner reserve until cleanup, and whoever
  submits the cleanup `CheckCancel`, usually the merchant, pays its fee. Facilitators SHOULD
  rate-limit proposals and openings.

## Network requirements

The [generic scheme](./scheme_batch_settlement.md#network-requirements) requires every binding to
specify:

| Requirement | This binding |
| --- | --- |
| 1. Commitment format | Per session, a validated `CheckCreate` whose `InvoiceID` commits to the canonical terms, the session key included. Per request, the `PAYMENT-SIGNATURE` payload (session, request ID, signed maximum) under an RFC 9421 Ed25519 signature with that key. |
| 2. Verification rules | `CheckCreate` admission and a validated `tesSUCCESS`; per request, the payload, target, digest, proof, nonce, freshness and maximum checks the `reserve` settle makes ([Verification](#verification)). |
| 3. Storage behavior and commitment identifier | The facilitator stores each reservation and receipt durably, under the session's lock. A request's commitment identifier is its `receiptDigest` with `sessionId` and `requestId`, returned by the `commit` settle; a session's is its `CheckID` and `sessionAuthorizationId`. Every other successful settle names its session, and a `reserve` its request ([Answers](#facilitator-interface)). |
| 4. Double-spend prevention | Single-use request IDs; reservations within the signed maximum; `committed + reserved <= ceiling` enforced atomically; one `CheckCash`, which consumes the Check; exact-blob rebroadcast, with replacements only after proven failure. |
| 5. Commitment expiry | Proofs expire within the maximum proof age and nonces within their lifetime. New requests stop at `expiration − settlement_grace_seconds` and the Check expires at `expiration`; usage committed but not cashed by then is a receivable. Unopened proposals lapse at `createSubmitDeadline`. |
| 6. Redemption | After the close and drain, the merchant signer signs a `CheckCash` for the frozen total, and the resource server settles it as a `cash` step, which the facilitator validates and submits. The client, the merchant or the facilitator's policy closes the session. |
| 7. Trust model | Capital-backed: a delegated authorization against the payer's balance, with a ledger-enforced ceiling ([Trust model](#trust-model)). The seller holds a validated Check payable only to it, up to `SendMax`, until `Expiration`; that the payer can fund it when cashed is not assured. |

## Out of scope

Tickets (`TicketSequence`); multi-signed payers or merchants; issuers that charge transfer fees; a
`CheckCreate` held unsubmitted until close; topping up or extending a session (open another);
partial-delivery rules for streamed responses; transports other than HTTP.

## Appendix A: conformance vectors

Computed with an implementation of this binding and recomputed independently. All addresses come
from test-only keys.

### A.1 Canonical terms and identifiers

The session key is RFC 9421 Appendix B.1.4's `test-key-ed25519`: JWK `x`
`JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs`, RFC 7638 thumbprint
`poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U`. An issued-currency session with ceiling 0.5:

```text
{"binding":"xrpl-check-session","scheme":"batch-settlement","terms":{"asset":"524C555344000000000000000000000000000000","asset_scale":6,"authorization_nonce":"0123456789abcdef0123456789abcdef","ceiling_atomic":500000,"client_key":{"crv":"Ed25519","kty":"OKP","x":"JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs"},"create_submit_deadline":846000600,"credential_audience":"https://rs.example","destination_tag":null,"expiration":846003600,"issuer":"rhA4uZnenHBQM2My9mFYWjwKhu2i6DCSVA","network":"xrpl:1","pay_to":"rfUom3iQifHWyw2KwH1fg7AKUYQBW73U5H","payer":"rGMTQpyhaDwWTqmw4dcYHj5NPJhtWNhtRW","pricing":{"models":[{"cache_read_rate_atomic":0,"cache_write_rate_atomic":0,"fixed_atomic":3,"input_rate_atomic":400000,"long_context":null,"minimum_atomic":10,"model":"flat","output_rate_atomic":1600000}],"rounding":"ceil","unit_tokens":1000000,"version":"example-2026-10"},"resource_scope":["path:/v1/chat/completions"],"send_max_atomic":500000,"session_id":"ses_0123456789abcdef0123456789abcdef","settlement_grace_seconds":600,"source_tag":null,"tenant_id":"rs-example","transfer_fee_policy":"fee_free_or_exempt"},"version":2}
```

```text
sessionAuthorizationId = sha256:9683437a5fb1df494f4427db76e9483a288d00dc6104e351f4d48c407c5a2b50
InvoiceID              = 96FFED92D62CEF575D383682318725F734BD43E64F4C1AA24C4E274E24481E6F
SendMax                = {"currency":"524C555344000000000000000000000000000000","issuer":"rhA4uZnenHBQM2My9mFYWjwKhu2i6DCSVA","value":"0.5"}
```

The same session in XRP, ceiling 2 XRP, differs in `"asset":"XRP"`, `"ceiling_atomic":2000000`,
`"issuer":""`, `"send_max_atomic":2000000` and `"session_id":"ses_fedcba9876543210fedcba9876543210"`:

```text
sessionAuthorizationId = sha256:8b819ad30b8aa31976a8959e00dfc35d3afefcba55dd623b39bed574ac6cac60
InvoiceID              = F4E86408445FD72C306AFA2C69B1BE00E96B6CC327C25FFB8ECD331692D4259A
SendMax                = "2000000"
```

### A.2 A signed request

A signature-construction vector: its nonce and times are synthetic and would fail the session's
freshness and nonce checks. `POST https://rs.example/v1/chat/completions?stream=false` with body
`{"q":1}`, signed with the key above at `created` 1800000000, `expires` 1800000060 and nonce
`nonce-0`. `PAYMENT-SIGNATURE` is the [example payload](#payment-signature) with `accepted.amount`
`"0.0002"`, as sorted-key compact JSON:

```text
Content-Digest: sha-256=:auD2YARtrc9f6EYsDgCgYttMjWe+gvQJjF6kII0ZsHY=:
PAYMENT-SIGNATURE: eyJhY2NlcHRlZCI6eyJhbW91bnQiOiIwLjAwMDIiLCJhc3NldCI6IjUyNEM1NTUzNDQwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJleHRyYSI6eyJiaW5kaW5nIjoieHJwbC1jaGVjay1zZXNzaW9uIiwiaXNzdWVyIjoicmhBNHVabmVuSEJRTTJNeTltRllXandLaHUyaTZEQ1NWQSIsInZlcnNpb24iOiIxIn0sIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwibmV0d29yayI6InhycGw6MSIsInBheVRvIjoicmZVb20zaVFpZkhXeXcyS3dIMWZnN0FLVVlRQlc3M1U1SCIsInNjaGVtZSI6ImJhdGNoLXNldHRsZW1lbnQifSwiZXh0ZW5zaW9ucyI6eyJodHRwLW1lc3NhZ2Utc2lnbmF0dXJlcyI6eyJpbmZvIjp7InJlZ2lzdHJhdGlvblVybCI6Imh0dHBzOi8vcnMuZXhhbXBsZS94NDAyL3Nlc3Npb25zIiwic2lnbmF0dXJlU2NoZW1lcyI6WyJlZDI1NTE5Il0sInRhZ3MiOlsieDQwMi14cnBsLXNlc3Npb24iXX19LCJwYXltZW50LWlkZW50aWZpZXIiOnsiaW5mbyI6eyJpZCI6InJlcV8wMTIzNDU2Nzg5YWJjZGVmIiwicmVxdWlyZWQiOnRydWV9LCJzY2hlbWEiOnsiJHNjaGVtYSI6Imh0dHBzOi8vanNvbi1zY2hlbWEub3JnL2RyYWZ0LzIwMjAtMTIvc2NoZW1hIiwicHJvcGVydGllcyI6eyJpZCI6eyJtYXhMZW5ndGgiOjEyOCwibWluTGVuZ3RoIjoxNiwidHlwZSI6InN0cmluZyJ9LCJyZXF1aXJlZCI6eyJ0eXBlIjoiYm9vbGVhbiJ9fSwicmVxdWlyZWQiOlsicmVxdWlyZWQiXSwidHlwZSI6Im9iamVjdCJ9fX0sInBheWxvYWQiOnsic2Vzc2lvbklkIjoic2VzXzAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmIn0sIng0MDJWZXJzaW9uIjoyfQ==
Signature-Input: x402=("@method" "@target-uri" "content-digest" "payment-signature");created=1800000000;expires=1800000060;nonce="nonce-0";keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";tag="x402-xrpl-session"
Signature: x402=:wE9kTLhd/keQWAMRvec2IhpOY8Rvb/SsFlbzIMYTps6eazQLVHs2d3pFJve52+4aJe/0FJ79D356uO09wVSyAQ==:
```

The signature base, lines joined by `\n` with none after the last:

```text
"@method": POST
"@target-uri": https://rs.example/v1/chat/completions?stream=false
"content-digest": sha-256=:auD2YARtrc9f6EYsDgCgYttMjWe+gvQJjF6kII0ZsHY=:
"payment-signature": <the PAYMENT-SIGNATURE value above>
"@signature-params": ("@method" "@target-uri" "content-digest" "payment-signature");created=1800000000;expires=1800000060;nonce="nonce-0";keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";tag="x402-xrpl-session"
```

### A.3 Price table

With the [example table](#metering-profile-price-table), in atomic units. Charges:

| Usage `(input, output, cacheRead, cacheWrite)` | `flat` | `long` |
| --- | --- | --- |
| (0, 0, 0, 0) | 10 | 0 |
| (999, 1, 0, 0) | 405 | 1259 |
| (150000, 40000, 9000, 1000) | 124003 | 590188 |
| (180000, 30000, 0, 0) | 120003 | 900000 |

Reservations:

| `promptTokens`, `maxOutputTokens` | `flat` | `long` |
| --- | --- | --- |
| 0, 0 | 10 | 0, refused as `invalid_reservation` |
| 700, 1024 | 1922 | 11334 |
| 190000, 20000 | 108003 | 893750 |

## Appendix B: Version history

| Version | Date | Changes |
| --- | --- | --- |
| `1` | 2026-10 | Initial binding, canonical terms version 2 |
