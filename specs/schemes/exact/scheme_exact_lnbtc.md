# Scheme: `exact` on Bitcoin Lightning (`lnbtc`)

## Summary

This document specifies the x402 `exact` payment scheme for Bitcoin Lightning
networks using the `lnbtc` namespace defined here, in CAIP-2 format. The client
pays a fresh BOLT11 invoice from the resource server and returns its 32-byte
payment preimage. The facilitator verifies `SHA-256(preimage) == payment_hash`
and requires the invoice signing key to match `payTo`. This check does not require
access to the receiver's Lightning node. A client MUST NOT select this method
unless its payer Lightning node returns the preimage after payment.

This is the default `bolt11` asset transfer method. Under the `invoice` method,
for payers that cannot return the preimage, the client presents the payment hash
and the facilitator queries the receiver. Both methods use the `upfront`
payment flow. The resource server processes the request only after the facilitator
validates the proof and records the payment hash.

This scheme targets x402 protocol version 2 and uses the core
`PaymentRequirements`, `PaymentPayload`, and `SettlementResponse` types from
[x402-specification-v2.md](../../x402-specification-v2.md).

## Scheme and Networks

The `lnbtc` namespace identifies Bitcoin Lightning networks. Its reference MUST
be the first 32 characters of the underlying Bitcoin network's genesis block
hash in lowercase hexadecimal, following the
[BIP-122 CAIP-2 reference convention](https://namespaces.chainagnostic.org/bip122/caip2).
The supported networks are listed below.

- `scheme` MUST be `"exact"`.
- `asset` MUST be `"BTC"`.
- Mainnet MUST use
  `lnbtc:000000000019d6689c085ae165831e93` and BOLT11 currency `bc`.
- Bitcoin testnet MUST use
  `lnbtc:000000000933ea01ad0ee984209779ba` and BOLT11 currency `tb`.
- Messages on the wire MUST use one of these concrete network identifiers.

## Asset Transfer Methods and Payment Flow

Both asset transfer methods belong to the
[client-submitted (payment proof)](./scheme_exact.md#client-submitted-payment-proof)
family: the client pays the invoice, then presents a proof of payment.

| Method | Proof in `payload` | Settle checks | Facilitator needs receiver access |
|---|---|---|---|
| `bolt11` (default) | `preimage` | `SHA-256(preimage) == payment_hash` | No |
| `invoice` | `paymentHash` | The receiver reports the invoice as settled | Yes |

`extra.assetTransferMethod` MAY be omitted, in which case it defaults to
`"bolt11"`. Any explicit value MUST be `"bolt11"` or `"invoice"`. `bolt11` is
RECOMMENDED because its proof is self-verifying, which `scheme_exact.md` prefers,
and a client that can obtain the preimage SHOULD select it. `invoice` is a
fallback for payers that cannot return the preimage, such as a wallet on a second
device paying a QR code, some custodial wallets, and LNURL-based payers. A
resource server MAY offer both through `accepts[]` entries that differ only in
`extra.assetTransferMethod` and `extra.invoice`.

`"upfront"` is the only supported payment flow because a Lightning payment settles
before its preimage is available. The resource server MUST set
`extra.paymentFlow` to `"upfront"` in every payment requirement. Clients and
resource servers MUST reject any other value.

The request hash is the SHA-256 digest of a JSON object encoded with the JSON
Canonicalization Scheme (JCS, RFC 8785). It covers a versioned transport profile
and that profile's request inputs. The server sends it as `extra.requestHash` and
puts it in the invoice's signed BOLT11 description hash. See
[Request Binding](#request-binding) for the encoding.

The protocol sequence is:

1. The resource server computes the request hash and returns a fresh BOLT11
   invoice that commits to it in a payment requirement.
2. The client validates and pays the invoice, then constructs a payment payload
   containing the preimage (`bolt11`) or the payment hash (`invoice`).
3. The resource server sends the payload to the facilitator's `/settle` endpoint.
   It MUST NOT call `/verify` for this flow.
4. The facilitator validates the proof and atomically records the payment hash as
   used.
5. The resource server processes the protected request only after `/settle`
   succeeds.

## Terminology and Adapter Requirements

- **Receiver**: The seller-side Lightning node that creates invoices.
- **Payer**: The client-side Lightning node that pays an invoice.
- **Payment hash**: The 32-byte value committed to by the BOLT11 invoice.
- **Preimage**: The 32-byte secret whose SHA-256 digest is the payment hash.
- **Replay store**: Storage that atomically records settled network and payment-hash
  pairs and persists across facilitator restarts.
- **Invoice state**: The receiver's state for an invoice: open (unpaid, possibly
  with HTLCs held for part of the amount), accepted (HTLCs held but not settled),
  settled, or canceled (including expired unpaid).

Under `bolt11`, a payer adapter MUST return the payment preimage when it reports a
payment as paid, and a client MUST NOT use an adapter that cannot.

A receiver adapter MUST be able to create a fresh invoice for an exact
millisatoshi amount with a caller-supplied BOLT11 description hash. The resource
server MUST have exclusive invoice-issuance authority for the receiver key in
`payTo`; an untrusted party MUST NOT be able to create invoices signed by that key.
Under `invoice`, the facilitator's receiver adapter MUST report, for a payment
hash, the invoice state and the amount received.

## Amounts

`amount` MUST be a decimal string that encodes a positive integer number of
millisatoshis. It MUST NOT contain a sign, decimal point, exponent, separator, or
unit suffix. The BOLT11 invoice MUST specify an integral millisatoshi amount.

Examples:

| Meaning | Wire `amount` |
|---|---:|
| 1 millisatoshi | `"1"` |
| 1 satoshi | `"1000"` |
| 21 satoshis | `"21000"` |
| 1 bitcoin | `"100000000000"` |

User-facing SDKs MUST use explicit atomic `AssetAmount` pricing by default, for
example `{ "asset": "BTC", "amount": "21000" }` for 21 satoshis. They MAY also
accept qualified forms such as `"21 sat"` or `"21 sats"`. Parsers MUST use exact
decimal arithmetic and reject negative values and sub-millisatoshi precision.
Bare numeric prices such as `"21"` or `21` MUST NOT default to satoshis. These and
other forms, such as `$1`, `1 USD`, or `0.0001 BTC`, MUST be rejected unless the
application has registered a conversion parser. The error SHOULD direct the
caller to use an explicit atomic `AssetAmount`.

For both methods, the x402 settled amount is the invoice amount, which MUST equal
`PaymentRequirements.amount`. The preimage does not reveal the amount actually
received. Under `invoice`, the receiver reports it; the facilitator MUST require
it to be at least the invoice amount and otherwise applies the same semantics as
`bolt11`. Lightning can settle a payment above the invoice amount, as described
in [BOLT11](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md#payer--payee-interactions).
The facilitator MUST accept an otherwise valid proof at the invoice amount even
if Lightning overpayment occurred. Overpayment grants no additional resource or
credit. This scheme provides no refund path; any refund is a separate arrangement
with the receiver. Clients MUST NOT assume a refund is available.

Clients MUST instruct their payer adapter to pay the invoice amount. Routing fees
are paid by the payer in addition to that amount and do not count toward it. The
receiver MUST reject payments whose aggregate amount is below the invoice amount
without releasing the preimage. An incomplete or failed payment MUST NOT
authorize the resource. Its HTLCs follow Lightning failure or timeout handling;
there is no x402 refund transaction.

## `PaymentRequirements`

The resource server MUST generate a fresh BOLT11 invoice for each payment
challenge and place it in `extra.invoice`. A fresh invoice MUST use a new 32-byte
preimage generated with cryptographically secure randomness and a previously
unused payment hash, including across networks. The signed payment hash
identifies the invoice.

The server MUST set `extra.requestBindingProfile` and
`extra.requestBindingParams` from its transport and resource configuration, and
`extra.requestHash` to the digest of the actual request, as specified below.

The following deterministic example is a test vector, not a reusable challenge.
Its validation time is Unix timestamp `1700000000`, equal to the invoice creation
time.

```json
{
  "scheme": "exact",
  "network": "lnbtc:000000000019d6689c085ae165831e93",
  "amount": "25000",
  "asset": "BTC",
  "payTo": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "maxTimeoutSeconds": 300,
  "extra": {
    "assetTransferMethod": "bolt11",
    "paymentFlow": "upfront",
    "requestHash": "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018",
    "requestBindingProfile": "http:1",
    "requestBindingParams": { "headers": [] },
    "invoice": "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f"
  }
}
```

The `extra` fields are:

| Field | Required | Meaning |
|---|---|---|
| `extra.assetTransferMethod` | No | `"bolt11"` (default) or `"invoice"`. |
| `extra.paymentFlow` | Yes | MUST be `"upfront"`. |
| `extra.invoice` | Yes | Fresh, signed BOLT11 invoice for `amount` on `network` that passes the checks below. |
| `extra.requestHash` | Yes | Expected request hash, encoded as 64 lowercase hexadecimal characters. |
| `extra.requestBindingProfile` | Yes | Versioned request binding profile: `"http:1"` or `"mcp:1"`. |
| `extra.requestBindingParams` | Yes | Object containing exactly the parameters required by the selected profile. |

`maxTimeoutSeconds` MUST be a positive integer. The BOLT11 invoice expiry MUST
equal `maxTimeoutSeconds` exactly.

`payTo` MUST be the receiver node's valid compressed secp256k1 public key: exactly
33 bytes encoded as 66 lowercase hexadecimal characters without a prefix. The
invoice signing key MUST equal `payTo`. If the invoice contains an `n` field, that
field MUST equal `payTo`. Otherwise, the implementation MUST recover the key from
the invoice signature and require it to equal `payTo`.

Before returning the challenge, the server MUST strictly decode the invoice and
verify all of the following:

1. The BOLT11 amount equals `PaymentRequirements.amount` exactly.
2. The BOLT11 currency matches the concrete network (`bc` for mainnet, `tb` for
   testnet).
3. The invoice's description hash equals the request hash.
4. The invoice signing key equals `payTo`.
5. The BOLT11 expiry equals `maxTimeoutSeconds` exactly.
6. The BOLT11 creation time is not later than the server's validation time plus
   its configured non-negative clock-skew allowance, whose default MUST be 60
   seconds. Equality at this boundary is valid.
7. The invoice has not expired at the server's validation time.

The server MUST NOT reuse an invoice across clients or challenges.

`extra.invoice` is dynamic. Scheme implementations MUST declare `invoice` as a
dynamic `extra` field. `requestHash`, `requestBindingProfile`, and
`requestBindingParams` MUST NOT be dynamic. The server MUST derive them from the
actual request and its configuration before matching requirements. Every core
field and every server-declared `extra` field
except `invoice` MUST match the accepted requirements. This permits a paid retry
to use its original invoice for the same request.

## Request Binding

The BOLT11 description hash MUST equal the request hash defined below. Clients,
servers, and facilitators MUST reject invoices without this binding. The invoice
signature covers both the description hash and the unique payment hash. Identical
requests can have the same request hash while their invoices have distinct payment
hashes.

The payment hash identifies the invoice, not a particular request attempt.
An unused proof MUST be accepted for another challenge with the same request
binding and payment terms if all validation rules pass. Servers need not track
issued payment hashes per challenge.

The server MUST select the profile for the operation being purchased. MCP tool
calls MUST use `mcp:1`, including when MCP uses an HTTP transport. Other HTTP
requests use `http:1`. Clients, servers, and facilitators MUST reject missing,
unknown, or unsupported profiles and malformed profile parameters; they MUST NOT
fall back to another profile. Other transports require a separately defined
profile before they can use this scheme.

The domain tag MUST be `"x402:exact:lnbtc:bolt11:"` concatenated with
`extra.requestBindingProfile`. Clients and servers MUST construct the profile's
binding object from the actual request. The server MUST reject requests whose
purchased operation, content interpretation, or account selection depends on
context not represented by that object. It MUST apply its normal authentication
and authorization checks on every attempt.

### Description Hash Encoding

The description bytes MUST be the UTF-8 output of
[JCS (RFC 8785)](https://www.rfc-editor.org/rfc/rfc8785.html) applied to the
profile's binding object:

```text
descriptionBytes = UTF8(JCS(binding))
requestHash = SHA-256(descriptionBytes)
```

Implementations MUST use JCS member sorting, string escaping, and number
serialization, and reject inputs outside its data model, including duplicate
object member names and invalid Unicode. No byte-order mark or trailing newline
is part of the hash input. The binding object is constructed locally; it is not
an additional field in `PaymentRequirements` or `PaymentPayload`.

The BOLT11 description hash MUST contain the raw 32-byte `requestHash` digest.
`extra.requestHash` MUST contain that same digest as 64 lowercase hexadecimal
characters. The client reconstructs the description bytes from its request and
the validated profile parameters without another server lookup.

The invoice signature also commits to its amount, currency, expiry, and payment
hash; the signer identifies the receiver. The domain tag fixes the x402 version-2
`exact`/`bolt11`/`upfront` interpretation, where `bolt11` names the invoice
encoding. Both asset transfer methods use the same tag, so the request hash does
not depend on the method. The existing payment-term checks remain
mandatory. Neither the invoice nor `extra.requestHash` is part of the hash input.

On a paid retry, the server MUST recompute the digest from the request that will
execute, using its configured profile and parameters. It MUST NOT take the
expected digest or profile parameters from `accepted.extra`,
`PaymentPayload.resource`, or the accepted invoice. It sends the computed digest
in `requirements.extra.requestHash` to `/settle`. The facilitator MUST compare
the accepted invoice's signed description hash against that expected digest.
Missing binding fields MUST fail rather than disable the check. A previous
successful claim remains `duplicate_settlement`.

### HTTP Profile (`http:1`)

`extra.requestBindingParams` MUST contain exactly one member, `headers`, whose
value is the configured array of bound header names. The client and server
compute the binding from the HTTP request itself.

- `method` and `url` MUST use the `@method` and `@target-uri` component rules in
  [RFC 9421, section 2.2](https://www.rfc-editor.org/rfc/rfc9421.html#section-2.2).
  The URL MUST be an absolute `http` or `https` URL in ASCII URI syntax, including
  the query string, without a fragment or user information. Implementations MUST
  preserve method case, percent escapes, and query parameter order. The server
  MUST validate the public origin against its configuration and reconstruct it
  only from trusted proxy information when behind a proxy.
- `bodyHash` MUST be SHA-256 of the content bytes after transfer decoding and
  before content decoding or application parsing. An absent body uses SHA-256 of
  empty bytes. JSON bodies MUST NOT be parsed and serialized before hashing. The
  paid retry MUST preserve the content bytes.
- Bound headers MUST be selected by the server's configuration for the resource,
  never from the client echo. `extra.requestBindingParams.headers` MUST contain
  every header that can affect the purchased operation, content interpretation, or account
  selection, even when absent. Examples include `content-type`, `content-encoding`,
  `accept`, `range`, `authorization`, and `cookie` when used for these purposes.
  Names MUST be lowercase HTTP field-name tokens in ascending ASCII byte order,
  with no duplicates. An empty array is valid only when no header affects these
  decisions. `payment-signature` MUST NOT be included.

For each present bound header, `valueHash` MUST be SHA-256 of
`0x01 || ASCII(value)`, where `value` uses the default field-component rules in
[RFC 9421, section 2.1](https://www.rfc-editor.org/rfc/rfc9421.html#section-2.1),
without component parameters. For an absent header it MUST be SHA-256 of the
single byte `0x00`. This distinguishes absent and empty values. Unsupported field
values MUST cause rejection.

An account selected only through a TLS client certificate is an example of
unrepresented context and MUST cause rejection. Clients and servers MUST require
`PaymentRequired.resource.url` to equal `url`.

The client and server MUST construct a JSON object, `binding`, with exactly these
members:

| Member | Value |
|---|---|
| `domain` | The string `"x402:exact:lnbtc:bolt11:http:1"`. |
| `method` | The HTTP method defined above. |
| `url` | The HTTP target URL defined above. |
| `bodyHash` | The body digest defined above, encoded as 64 lowercase hexadecimal characters. |
| `headers` | An array with one object per name in `extra.requestBindingParams.headers`, in the same order. Each object has exactly `name` and `valueHash` members. `name` is the header name; `valueHash` is its digest defined above, encoded as 64 lowercase hexadecimal characters. |

All members are required, including `headers` when empty. This object contains
only strings, arrays, and objects. JCS applies to this object; the HTTP body is
hashed as bytes as specified above.

### MCP Profile (`mcp:1`)

This profile covers `tools/call` in the [MCP transport](../../transports-v2/mcp.md).
Other MCP operations MUST NOT use this profile. `extra.requestBindingParams`
MUST contain exactly `server` and `metadata`:

- `server` MUST be an absolute URI in ASCII syntax, without user information or
  a fragment, identifying the MCP server. For HTTP connections it MUST be the
  public MCP endpoint URI; for other connections it MUST be a URI agreed through
  client and server configuration. Both sides MUST use the exact configured
  spelling. The client MUST check this value against its intended server's
  connection or trusted configuration, not learn its identity from the payment
  challenge. The server MUST use its own configuration, not the client echo.
- `metadata` MUST be an array of non-empty `params._meta` member names, sorted
  according to JCS property ordering, without duplicates. Names are case
  sensitive. The server MUST include every metadata member that affects the
  purchased operation or account selection, even when absent. It MUST NOT
  include `x402/payment` or `progressToken`. An empty array is valid when no
  metadata affects those decisions.

The binding object MUST contain exactly these members:

| Member | Value |
|---|---|
| `domain` | The string `"x402:exact:lnbtc:bolt11:mcp:1"`. |
| `server` | The independently validated `extra.requestBindingParams.server`. |
| `method` | The string `"tools/call"`. |
| `name` | The actual `params.name`, a non-empty string, without normalization. |
| `arguments` | The actual `params.arguments` object, before defaults or application transformations; `{}` if omitted. Null and non-object values MUST be rejected. |
| `metadata` | An array with one object per configured metadata name, in the same order. Each object has exactly `name` and `valueHash` members as defined below. |

For each present bound metadata member, `valueHash` MUST be SHA-256 of
`0x01 || UTF8(JCS(value))`. For an absent member it MUST be SHA-256 of the single
byte `0x00`. Each digest MUST be encoded as 64 lowercase hexadecimal characters.
An absent `_meta` is treated as an empty object; a present non-object `_meta`
MUST be rejected. Null values remain distinct from absent values.

The JSON-RPC `id`, payment metadata, progress token, and transport framing are
not binding inputs. A paid retry MAY change them without changing the purchased
operation. The tool MUST treat omitted arguments and `{}` identically. Servers
MUST reject operations that depend on any excluded input or unrepresented
context, including an account selected only by transport authentication or
session state. A bound account argument or metadata value MUST still be checked
against the authenticated caller's permissions.

The server MUST associate `PaymentRequired.resource.url` with the actual tool
in its own configuration. Clients MUST derive the binding from the intended
server and tool call, never from the echoed resource URL. The server identity,
tool name, arguments, and relevant metadata together identify what is purchased.

## `PaymentPayload`

Under `bolt11`, after paying, the client sends the preimage in the scheme-specific
`payload` object. The invoice remains in `accepted.extra.invoice`:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "lnbtc:000000000019d6689c085ae165831e93",
    "amount": "25000",
    "asset": "BTC",
    "payTo": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "bolt11",
      "paymentFlow": "upfront",
      "requestHash": "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018",
      "requestBindingProfile": "http:1",
      "requestBindingParams": { "headers": [] },
      "invoice": "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f"
    }
  },
  "payload": {
    "preimage": "0001020304050607080900010203040506070809000102030405060708090102"
  }
}
```

`payload.preimage` is required:

| Field | Type | Requirements |
|---|---|---|
| `preimage` | string | MUST be exactly 64 lowercase hexadecimal characters encoding 32 bytes. |

Under `invoice`, with `accepted.extra.assetTransferMethod` set to `"invoice"`,
the client sends the payment hash of the paid invoice instead:

```json
{ "paymentHash": "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e" }
```

`payload.paymentHash` is required and MUST be exactly 64 lowercase hexadecimal
characters equal to the accepted invoice's payment hash. It is redundant with
`accepted.extra.invoice`, but is sent rather than an empty `payload` because
`scheme_exact.md` requires the proof artifact in `PaymentPayload.payload`, and it
names the consumption key the client claims. A mismatch fails validation.

`accepted.extra.invoice` MUST be byte-identical to the invoice that the client
paid. It MAY differ from a newly generated `requirements.extra.invoice` on the
retry. Its signing key, request binding, and payment terms MUST pass the checks
below. No additional challenge identifier or request copy is required.

## Request Binding Test Vectors

Every settlement case below applies to both asset transfer methods. Under
`invoice`, `payload.paymentHash` replaces the preimage, and the receiver reports
the invoice as settled unless stated otherwise.

### HTTP

The examples above describe `GET https://api.example.com/article/A` with an empty
body and no bound headers. They use the test-only secp256k1 private key
`0000000000000000000000000000000000000000000000000000000000000001`.
The canonical description is the following single line, encoded as UTF-8 without
its trailing newline:

```json
{"bodyHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","domain":"x402:exact:lnbtc:bolt11:http:1","headers":[],"method":"GET","url":"https://api.example.com/article/A"}
```

Its SHA-256 digest, which MUST equal `extra.requestHash` and the signed BOLT11
description hash, is:

```text
0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018
```

Changing only the URL to `https://api.example.com/article/B` produces this digest:

```text
4a99860f75eed1ea8178a5db488e044173bc570c8a6210f2c8590cdf8622d509
```

Each case below starts independently at validation time `1700000000` with an
empty replay store. Mutations leave the accepted invoice and preimage unchanged
unless stated otherwise. The server computes `requirements.extra.requestHash`
from the actual request before calling `/settle`.

| Case | Expected result |
|---|---|
| Unchanged examples, including different JSON member order or whitespace. | Settlement succeeds. |
| Replace only `requirements.extra.invoice` with a fresh valid invoice for the same request and terms. | Settlement succeeds using the original accepted invoice. |
| Issue two concurrent challenges for the same request and terms. Pay only the first invoice, then present its proof against the second challenge. | Settlement succeeds using the first invoice; no record linking it to the second challenge is needed. |
| Present the same paid proof concurrently against both challenges for the same request and terms. | Exactly one settlement succeeds; the other returns `duplicate_settlement`. |
| Pay both invoices for concurrent challenges with the same request and terms, then present each invoice's own proof. | Both settlements succeed; each payment has a distinct consumption key. |
| Settle the examples under `bolt11`, then present the same invoice's payment hash under `invoice`, or the reverse. | The second settlement returns `duplicate_settlement`. |
| Under `invoice`, present the proof while the receiver reports the invoice as accepted, then again after it settles. | `exact_lnbtc_invoice_not_settled`, then settlement succeeds. |
| Present article A's proof with an actual request for article B at the same price. | `invalid_exact_lnbtc_request_mismatch`. |
| Also change the accepted `requestHash` to article B's digest. | `invalid_exact_lnbtc_invoice_request_mismatch`; the invoice still commits to article A. |
| Change the actual method to `POST`, or body to the single byte `78` (hexadecimal), and echo the new digest. | `invalid_exact_lnbtc_invoice_request_mismatch`. |
| Remove `requestHash`, `requestBindingProfile`, or `requestBindingParams` from either side. | `invalid_exact_lnbtc_request_binding`. |
| Use an unknown profile, omit its required parameters, or add an unknown parameter. | `invalid_exact_lnbtc_request_binding`. |
| Change only the accepted header list. | `invalid_exact_lnbtc_request_mismatch`. |
| Replace the accepted invoice with a valid signed invoice containing an inline description instead of a description hash. | `invalid_exact_lnbtc_invoice_description`. |

### MCP

For `tools/call` with `params.name` equal to `"get_article"`,
`params.arguments` equal to `{ "article": "A" }`, and no bound metadata, use:

```json
{
  "requestBindingProfile": "mcp:1",
  "requestBindingParams": {
    "server": "https://api.example.com/mcp",
    "metadata": []
  },
  "requestHash": "03941bfedc6af8a09b2f459fe83470284a76a8c75801caa9e1487a9276a693f4"
}
```

The canonical description is this single line, without its trailing newline:

```json
{"arguments":{"article":"A"},"domain":"x402:exact:lnbtc:bolt11:mcp:1","metadata":[],"method":"tools/call","name":"get_article","server":"https://api.example.com/mcp"}
```

Its SHA-256 digest is the `requestHash` above. The following independent changes
produce these digests:

| Change | Request hash |
|---|---|
| Change `arguments.article` to `"B"`. | `b3e425970d64cd4f08fc4d57a11b76da59ce6a5760d92687398c91f063120678` |
| Change `name` to `"delete_article"`. | `3a52bbf19dda8b5765a27246b12e805770298273b48526956c421f02fe043455` |
| Change `server` to `"https://other.example.com/mcp"`. | `96903c29186c6aabc95e48abafd8ce3ad32b4060f5d5bf22cf75f3fbfe816e45` |

For a bound metadata name, an absent value hashes to
`6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d`;
a present `null` hashes to
`c58dcb77cee9027d1f4b3207bd876d232e61f79ee9f9dbd4e6d834778da78b16`.

For the settlement cases below, issue and pay an otherwise valid invoice whose
description hash is the MCP article A digest. Each case starts independently
with an empty replay store while the invoice is valid. Recompute requirements
from the actual call, leaving the accepted invoice unchanged unless stated.

| Case | Expected result |
|---|---|
| Retry the same tool call with a new JSON-RPC `id`, a changed `progressToken`, and the payment in `_meta["x402/payment"]`. | The request hash is unchanged; settlement succeeds. |
| Change only JSON whitespace or member order in the tool arguments. | The request hash is unchanged; settlement succeeds. |
| Change the actual tool name or arguments while keeping the original accepted binding. | `invalid_exact_lnbtc_request_mismatch`. |
| Also echo the new request hash after changing the tool name or arguments. | `invalid_exact_lnbtc_invoice_request_mismatch`. |
| Change the configured server identity and echo the new parameters and request hash. | `invalid_exact_lnbtc_invoice_request_mismatch`. |
| Use the HTTP article A invoice and preimage with accepted binding fields copied from valid MCP requirements. | `invalid_exact_lnbtc_invoice_request_mismatch`; the HTTP and MCP domains differ. |
| Change only the accepted profile and its parameters to a valid `http:1` binding. | `invalid_exact_lnbtc_request_mismatch`. |
| Advertise `http:1` for an MCP tool call, even over HTTP. | The client rejects the challenge before payment. |
| Omit a profile or required parameter, use an unknown profile, or include `x402/payment` or `progressToken` in the metadata list. | `invalid_exact_lnbtc_request_binding`. |
| With a separately issued invoice binding a metadata value, change that value (including absent to null) and echo the new digest. | `invalid_exact_lnbtc_invoice_request_mismatch`. |

## Client Payment Construction

Before paying, a client MUST:

1. Require `scheme == "exact"`, a supported concrete network, `asset == "BTC"`, a
   positive integral `amount`, a positive integral `maxTimeoutSeconds`, and a valid
   compressed secp256k1 `payTo` encoded as 66 lowercase hexadecimal characters.
2. Require `extra.paymentFlow == "upfront"` and a non-empty `extra.invoice`. Treat
   a missing `extra.assetTransferMethod` as `"bolt11"` and reject any value other
   than `"bolt11"` or `"invoice"`.
3. Strictly decode and verify the BOLT11 invoice and its signature.
4. Validate `extra.requestHash`, `extra.requestBindingProfile`, and
   `extra.requestBindingParams`. Require the profile to match the actual
   operation's transport and compute the digest from the intended request using
   that profile's rules, including its resource and server identity checks.
   Require exactly one description hash and no inline description. Both the
   description hash and `extra.requestHash` MUST equal the computed digest.
5. Require the invoice signing key to equal `payTo`.
6. Require the invoice currency to match the selected network.
7. Require the invoice to specify an integral millisatoshi amount equal to
   `PaymentRequirements.amount`.
8. Require the invoice expiry to equal `maxTimeoutSeconds` and its creation time to
   be no later than the client's validation time plus its configured non-negative
   clock-skew allowance, whose default MUST be 60 seconds.
9. Require the invoice to be unexpired at the client's validation time.
10. Ask its payer adapter to pay the invoice on the selected network.

A `bolt11` payer result MUST report `paid` and identify the same invoice, payment hash,
and invoice amount. Any separately reported routing fee MUST NOT be included in
the amount comparison. The client SHOULD report `in_flight` as a distinct result
so the caller can retry without starting a second payment. For a paid result,
the client MUST validate the preimage format and SHA-256 digest. It MUST NOT
construct a `PaymentPayload` if a check fails.

Under `invoice`, the client takes `paymentHash` from the decoded invoice and MAY
send the payload without a payer result, for example when a second device pays.
A payer result that it does receive MUST identify the same invoice, payment hash,
and amount. After `exact_lnbtc_invoice_not_settled`, it MAY retry the same payload.

## Facilitator Validation

The `upfront` flow does not invoke facilitator `/verify`. The facilitator's
`/settle` endpoint MUST treat the payload and echoed requirements as untrusted and
perform the following checks in order before it records the payment hash:

1. Require `accepted.scheme`, `network`, `amount`, `asset`, `payTo`, and
   `maxTimeoutSeconds` to equal the corresponding requirement fields.
2. Require `scheme == "exact"`, a supported network, `asset == "BTC"`, positive
   integral `amount` and `maxTimeoutSeconds` values, and a valid compressed
   secp256k1 `payTo` encoded as 66 lowercase hexadecimal characters.
3. Resolve a missing `extra.assetTransferMethod` to `bolt11` on both sides and
   require equal methods: `bolt11`, or `invoice` if the facilitator can query the
   receiver for `payTo`. Require `extra.paymentFlow == "upfront"` on both sides.
   Require both request hashes to be 64 lowercase hexadecimal characters.
   Require supported profiles and validate the syntax of both parameter objects
   using the Request Binding rules. Require the hashes, profiles, and parameters
   to match; parameter equality uses JCS serialization. Every other
   server-declared `extra` field except `invoice` MUST have the same value in
   `accepted`; additive client fields MAY remain.
4. Require non-empty invoices in `requirements.extra.invoice` and
   `accepted.extra.invoice`. The facilitator MUST use the accepted invoice for
   settlement and MUST NOT require the two invoices to be equal.
5. Strictly decode and verify the accepted invoice and its signature. Require
   exactly one description hash and no inline description.
   Require the signed description hash to equal the 32-byte digest decoded from
   `requirements.extra.requestHash`. This check is mandatory; missing binding
   fields MUST fail. The facilitator checks the server-supplied expected digest;
   it does not need the original request.
   Require its signing key to equal `requirements.payTo`, its BOLT11 currency to
   match the network, and its integral millisatoshi amount to equal
   `requirements.amount`.
   Require its expiry to equal `requirements.maxTimeoutSeconds`, and require its
   creation time not to exceed the facilitator's settlement time plus the
   configured clock-skew allowance.
6. Require the preimage to contain exactly 64 lowercase hexadecimal characters.
   Decode it as exactly 32 bytes and require
   `SHA-256(preimage_bytes) == payment_hash_bytes`. Under `invoice`, instead
   require `payload.paymentHash` to be 64 lowercase hexadecimal characters equal
   to the invoice's payment hash.
7. Apply the expiry policy below.
8. Under `invoice`, query the receiver as described in [Finality](#finality).

Under `bolt11`, the facilitator MUST verify the preimage locally and MUST NOT
require receiver access. Under `invoice`, it MUST read the invoice state from the
receiver and so needs credentials for the resource server's Lightning node. Such
a facilitator is in practice hosted by or for the resource server, which trusts
its report instead of a proof that anyone can check. This is the main cost of
`invoice`.

### Paid-but-expired Policy

Let:

- `invoice_end = invoice_creation_time + invoice_expiry_seconds`
- `settlement_time =` the facilitator's validation time during `/settle`
- `skew =` the facilitator's configured non-negative clock-skew allowance, whose
  default MUST be 60 seconds

The invoice passes the expiry check while
`settlement_time <= invoice_end + skew`, including after the BOLT11 expiry time. It
MUST fail the check after this boundary. Equality at the boundary is valid.

This grace period permits a retry when payment completed shortly before expiry.

### Finality

A payment is final when the receiver settles the invoice, releasing the preimage
and claiming the HTLCs; held HTLCs are not final. Lightning has no confirmation
depth: the receiver's invoice state is authoritative, and the resource server
that operates the receiver owns it. Under `bolt11`, a valid preimage shows that
the receiver settled. Under `invoice`, the facilitator MUST query the receiver
whose node key is `payTo`. If the invoice is settled, the facilitator requires
the amount received to be at least the invoice amount and records the payment
hash. Otherwise it MUST NOT record the payment hash and MUST return:

- `exact_lnbtc_invoice_not_settled` if the invoice is open or accepted and can
  still settle. The facilitator MAY re-query within the attempt first.
- `exact_lnbtc_receiver_unavailable` if the query fails or times out.
- `invalid_exact_lnbtc_invoice_canceled` if the invoice can no longer settle.
  Held HTLCs then fail back to the payer through Lightning's own failure or
  timeout handling; x402 adds no return path.

A client MAY retry a non-final result with the same payload while the invoice
passes the expiry policy. Receivers SHOULD settle a complete HTLC set at once
rather than hold it. Once the payment hash is recorded, a handler failure leaves
the client charged under either method; as `scheme_exact.md` states for
`upfront`, any remedy is the resource server's own arrangement.

## Settlement and Replay Protection

Settlement does not move funds. Under `bolt11`, the Lightning payment completed
before the client received the preimage; under `invoice`, settle only reads the
receiver's state. Neither check records state, so enforcing single-use settlement
requires a replay store. The canonical consumption key MUST be the ASCII string:

```text
network + ":" + payment_hash
```

`network` is the validated concrete CAIP-2 network identifier. `payment_hash` is
the accepted invoice's payment hash, encoded as 64 lowercase hexadecimal
characters without a prefix. The separator is one colon, with no whitespace.

After validation, the facilitator MUST atomically insert this key into a
restart-durable replay store. The insert MUST fail if the key already exists. In
that case, the facilitator MUST return `duplicate_settlement`. The resource server
MUST NOT process the protected request until the insert succeeds. The same hash
on different networks produces different keys.

Both methods share this key and store, so a payment hash recorded under one
method is a duplicate under the other. Under `bolt11`, the insert follows local
validation and is final. Under `invoice`, the facilitator MUST NOT insert the key
before the receiver reports the invoice as settled, and SHOULD query the receiver
before claiming the key, so a non-final attempt holds no claim. A claim held
while querying MUST be released before any result other than success is
returned, and MUST be bounded by a lease so that an abnormally terminated attempt
cannot hold it indefinitely; lease expiry MUST NOT let two attempts both succeed.

The replay entry MUST remain until at least one hour after
`invoice_end + skew`. It MUST NOT be removed while the invoice can still pass
validation.

On success, `SettlementResponse.transaction` MUST be the lowercase invoice payment
hash and `network` MUST be the concrete `lnbtc` network. `payer` MUST be omitted
because Lightning does not reveal a stable payer address.

```json
{
  "success": true,
  "transaction": "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e",
  "network": "lnbtc:000000000019d6689c085ae165831e93"
}
```

## Error Vocabulary

Facilitators MUST use the following stable strings in `errorReason`. Settlement
MUST preserve the validation reason when validation fails.

| Reason | Meaning |
|---|---|
| `unsupported_scheme` | Either side is not `exact`. |
| `network_mismatch` | `accepted.network` differs from the requirement. |
| `unsupported_network` | The concrete `lnbtc` network is unsupported. |
| `invalid_exact_lnbtc_asset` | Either side does not specify `BTC`. |
| `invalid_exact_lnbtc_amount` | Either amount is not a positive integer. |
| `invalid_exact_lnbtc_amount_mismatch` | `accepted.amount` differs from the requirement. |
| `invalid_exact_lnbtc_pay_to_mismatch` | `accepted.payTo` differs from the requirement. |
| `invalid_exact_lnbtc_pay_to_malformed` | `payTo` is not a lowercase compressed secp256k1 public key. |
| `invalid_exact_lnbtc_max_timeout_mismatch` | `accepted.maxTimeoutSeconds` differs from the requirement. |
| `invalid_exact_lnbtc_extra_mismatch` | A server-declared `extra` field other than `invoice`, `requestHash`, `requestBindingProfile`, or `requestBindingParams` differs. |
| `invalid_exact_lnbtc_request_binding` | A request hash, profile, or parameter object is missing or malformed, or a profile is unsupported. |
| `invalid_exact_lnbtc_request_mismatch` | The accepted request hash, profile, or parameters differ from the requirement. |
| `invalid_exact_lnbtc_asset_transfer_method` | The resolved asset transfer methods differ, or the facilitator does not support the method. |
| `invalid_exact_lnbtc_payment_flow` | Either payment flow is missing or not `upfront`. |
| `invalid_exact_lnbtc_invoice_missing` | Either required invoice field is absent. |
| `invalid_exact_lnbtc_invoice_decode_failed` | Strict BOLT11 decoding, signature validation, or integral-msat validation failed. |
| `invalid_exact_lnbtc_invoice_description` | The invoice does not contain exactly one description hash or contains an inline description. |
| `invalid_exact_lnbtc_invoice_request_mismatch` | The signed description hash differs from the expected request hash. |
| `invalid_exact_lnbtc_invoice_payee_mismatch` | The invoice signing key differs from `payTo`. |
| `invalid_exact_lnbtc_invoice_currency_mismatch` | BOLT11 currency does not match the network. |
| `invalid_exact_lnbtc_invoice_amount_mismatch` | BOLT11 amount differs from the required millisatoshis, or under `invoice` the receiver reports less received. |
| `invalid_exact_lnbtc_max_timeout` | `maxTimeoutSeconds` is not a positive integer. |
| `invalid_exact_lnbtc_invoice_expiry_mismatch` | BOLT11 expiry does not equal `maxTimeoutSeconds`. |
| `invalid_exact_lnbtc_invoice_created_in_future` | BOLT11 creation time exceeds validation time plus the clock-skew allowance. |
| `duplicate_settlement` | The network and payment-hash pair is already used or lost an atomic settlement race. |
| `invalid_exact_lnbtc_preimage_missing` | `payload.preimage` is absent. |
| `invalid_exact_lnbtc_preimage_malformed` | Preimage contains non-lowercase-hex characters. |
| `invalid_exact_lnbtc_preimage_length` | Decoded preimage is not exactly 32 bytes. |
| `invalid_exact_lnbtc_preimage_hash_mismatch` | SHA-256 of the preimage does not equal the payment hash. |
| `invalid_exact_lnbtc_payment_hash_missing` | Under `invoice`, `payload.paymentHash` is absent. |
| `invalid_exact_lnbtc_payment_hash_malformed` | `payload.paymentHash` is not 64 lowercase hexadecimal characters. |
| `invalid_exact_lnbtc_payment_hash_mismatch` | `payload.paymentHash` differs from the accepted invoice's payment hash. |
| `invalid_exact_lnbtc_invoice_expired` | The paid-but-expired settlement-time window was exceeded. |
| `exact_lnbtc_invoice_not_settled` | Under `invoice`, the receiver reports the invoice as open or accepted; it can still settle. |
| `exact_lnbtc_receiver_unavailable` | Under `invoice`, the facilitator could not obtain the invoice state from the receiver. |
| `invalid_exact_lnbtc_invoice_canceled` | Under `invoice`, the receiver reports the invoice as canceled; it can no longer settle. |

`exact_lnbtc_invoice_not_settled` and `exact_lnbtc_receiver_unavailable` are not
final; the payment hash was not recorded, and the same payload MAY be retried.

Client and server implementations SHOULD use these stable local failure reasons.
They are not facilitator response reasons unless a transport explicitly maps a local
failure into one:

| Reason | Meaning |
|---|---|
| `exact_lnbtc_invoice_issuance_denied` | The server's issuance limiter denied a new invoice. |
| `invalid_exact_lnbtc_payer_invoice_mismatch` | The payer adapter returned a different invoice. |
| `invalid_exact_lnbtc_payer_payment_hash_mismatch` | The payer adapter returned a different payment hash. |
| `invalid_exact_lnbtc_payer_amount_mismatch` | The payer adapter returned a different amount. |
| `exact_lnbtc_payment_in_flight` | Payment is still in flight and may be retried. |
| `exact_lnbtc_payment_not_paid` | The payer did not report a paid status. |
| `invalid_exact_lnbtc_payer_preimage_required` | A paid result omitted the mandatory preimage. |
| `invalid_exact_lnbtc_payer_preimage_malformed` | A payer preimage is not 64 lowercase hex characters. |
| `invalid_exact_lnbtc_payer_preimage_hash_mismatch` | A payer preimage does not hash to the invoice payment hash. |

## Security Considerations

### Mandatory Cryptographic Proof (`bolt11`)

The preimage is bearer proof of payment. Implementations MUST avoid logging or
otherwise disclosing it. A client MUST send it only to the resource server for the
invoice it paid. The facilitator can verify the invoice and preimage without
receiver credentials.

### Receiver-Attested Proof (`invoice`)

The `invoice` proof is not self-verifying: settle depends on the receiver's
liveness and on the facilitator's report of its state. `scheme_exact.md` prefers
self-verifying proofs, so `bolt11` is recommended and `invoice` is a fallback.

The payment hash is not secret, because it is part of the invoice. Anyone who
obtains the invoice, for example from a displayed QR code, can present it once
the invoice settles; request binding only restricts it to the bound request. Where
a bound input carries the payer's credentials, such as an `authorization` header,
an observer cannot reproduce the request. Otherwise the first presentation after
settlement receives the resource, so clients SHOULD NOT disclose the invoice
beyond the payer.

The facilitator's receiver credentials SHOULD only read invoice state. Ones that
can also create invoices extend to the facilitator the issuance authority that
[Receiver Key Isolation](#receiver-key-isolation) reserves to the resource server.
Facilitators SHOULD limit repeated receiver queries for the same payment hash.

### Invoice Substitution

On a paid retry, the accepted invoice can differ from the new challenge invoice.
The server MUST compute the expected request hash from the incoming request
before matching requirements. A matching client echo alone is insufficient. The
client and facilitator MUST check the signed description hash against the
expected digest and require the signing key to equal `payTo` and the
payment terms to match. A proof for another request fails even if its price and
receiver are the same. A self-issued invoice fails unless the attacker controls
the receiver node key.

Request binding does not identify the payer. A disclosed preimage and invoice
remain bearer proof for the bound request; replay protection permits at most one
successful claim. No server challenge store is required.

### Receiver Key Isolation

`payTo` binds the invoice to the receiver node. A shared custodial node is not
compatible if an untrusted tenant can create invoices under the same node key. The
tenant could pay its own invoice and use its proof against another tenant's
payment requirement. A compliant deployment MUST give the resource server
exclusive invoice-issuance authority for the receiver key.

### Invoice Issuance Denial of Service

Fresh invoices consume receiver node resources. Servers SHOULD limit or authorize
invoice issuance before calling the receiver. They MUST NOT reuse an invoice
across clients or challenges. If the transport provides a payment payload before
challenge generation, the server SHOULD validate it before it creates a replacement
invoice.

### Network and Currency Confusion

Servers, clients, and facilitators MUST map the concrete `lnbtc` network to the
expected BOLT11 currency and reject mismatches. In particular, a `tb` testnet
invoice MUST NOT appear under the mainnet identifier.

### Durable Replay Protection

An in-memory replay store is not compliant because a restart loses consumed keys.
All facilitator instances that settle for the same receiver MUST share a
restart-durable replay store with an atomic insert. This includes facilitators
serving different asset transfer methods. A resource server MUST NOT send
invoices for one receiver to independent replay stores. A database can enforce
this rule with a unique canonical consumption key. Persistent state is required
because Lightning has no public spent marker for the bearer proof.

### Payer Anonymity

Lightning routing does not give a facilitator a stable payer identity. Facilitators
MUST omit `SettlementResponse.payer` and MUST NOT infer payer identity from `payTo`
or the invoice payee.

## References

- [x402 protocol specification v2](../../x402-specification-v2.md)
- [BOLT11 payment encoding](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md)
- [JSON Canonicalization Scheme (RFC 8785)](https://www.rfc-editor.org/rfc/rfc8785.html)
- [HTTP message components (RFC 9421)](https://www.rfc-editor.org/rfc/rfc9421.html#section-2)
- [x402 MCP transport](../../transports-v2/mcp.md)
- [MCP tool calls](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools)
- [CAIP-2 chain identification](https://chainagnostic.org/CAIPs/caip-2)
