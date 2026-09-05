# Scheme: `exact` on Bitcoin Lightning (`BIP-122`)

## Summary

This document specifies the x402 `exact` payment scheme for Bitcoin Lightning
networks in the CAIP-2 `bip122` namespace. The client pays a fresh BOLT11 invoice
from the resource server and returns its 32-byte payment preimage. The facilitator
verifies `SHA-256(preimage) == payment_hash` and requires the invoice signing key
to match `payTo`. This check does not require access to the receiver's Lightning
node. A client MUST NOT select this scheme unless its payer Lightning node returns
the preimage after payment.

The scheme supports only the `bolt11` asset transfer method and the `upfront`
payment flow. The resource server processes the protected request only after the
facilitator validates the proof and records the payment hash.

This scheme targets x402 protocol version 2 and uses the core
`PaymentRequirements`, `PaymentPayload`, and `SettlementResponse` types from
[x402-specification-v2.md](../../x402-specification-v2.md).

## Scheme and Networks

- `scheme` MUST be `"exact"`.
- `asset` MUST be `"BTC"`.
- Mainnet MUST use
  `bip122:000000000019d6689c085ae165831e93` and BOLT11 currency `bc`.
- Bitcoin testnet MUST use
  `bip122:000000000933ea01ad0ee984209779ba` and BOLT11 currency `tb`.
- Messages on the wire MUST use one of these concrete network identifiers.

## Asset Transfer Method and Payment Flow

`"bolt11"` is the only supported asset transfer method.
`extra.assetTransferMethod` MAY be omitted, in which case it defaults to
`"bolt11"`. Any explicit value MUST be `"bolt11"`.

`"upfront"` is the only supported payment flow because a Lightning payment settles
before its preimage is available. The resource server MUST set
`extra.paymentFlow` to `"upfront"` in every payment requirement. Clients and
resource servers MUST reject any other value.

The protocol sequence is:

1. The resource server creates a fresh BOLT11 invoice and returns it in a payment
   requirement.
2. The client validates and pays the invoice, then constructs a payment payload
   containing the preimage.
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
- **Replay store**: Storage that atomically records settled payment hashes and
  persists across facilitator restarts.

A payer adapter MUST return the payment preimage when it reports a payment as
paid. A client MUST NOT use an adapter that cannot return the preimage.

A receiver adapter MUST be able to create a fresh invoice for an exact
millisatoshi amount. The resource server MUST have exclusive invoice-issuance
authority for the receiver key in `payTo`; an untrusted party MUST NOT be able to
create invoices signed by that key.

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

User-facing SDKs SHOULD parse satoshi inputs such as `"21"`, `"21 sat"`, and
`"21 sats"` as `"21000"`. Parsers MUST use exact decimal arithmetic and reject
negative values and sub-millisatoshi precision. They MUST also reject fiat or
bitcoin inputs such as `$1`, `1 USD`, or `0.0001 BTC` unless the application has
registered a conversion parser. The error SHOULD direct the caller to use
satoshis or an explicit atomic `AssetAmount`.

## `PaymentRequirements`

The resource server MUST generate a fresh BOLT11 invoice for each payment
challenge and place it in `extra.invoice`.

The following deterministic example is a test vector, not a reusable challenge.
Its validation time is Unix timestamp `1700000000`, equal to the invoice creation
time.

```json
{
  "scheme": "exact",
  "network": "bip122:000000000019d6689c085ae165831e93",
  "amount": "25000",
  "asset": "BTC",
  "payTo": "036360e856310ce5d294e8be33fc807077dc56ac80d95d9cd4ddbd21325eff73f7",
  "maxTimeoutSeconds": 300,
  "extra": {
    "assetTransferMethod": "bolt11",
    "paymentFlow": "upfront",
    "invoice": "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdq80q6rqvsxqzfvcqpjpal2l7zmrg46wpsxvv8aly29hzrjhvyxcrxxdm3r4ky8etpthh9p3r2ly8jvtlv6wprwvrm5t2zrxxmvpg57xhf24x2ngrd8smj8jtcp79fu42"
  }
}
```

The `extra` fields are:

| Field | Required | Meaning |
|---|---|---|
| `extra.assetTransferMethod` | No | If present, MUST be `"bolt11"`; defaults to `"bolt11"`. |
| `extra.paymentFlow` | Yes | MUST be `"upfront"`. |
| `extra.invoice` | Yes | Fresh, signed BOLT11 invoice for `amount` on `network` that passes the checks below. |

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
3. The invoice contains exactly one inline description field (`d`) and no
   description hash field (`h`).
4. The invoice signing key equals `payTo`.
5. The BOLT11 expiry equals `maxTimeoutSeconds` exactly.
6. The BOLT11 creation time is not later than the server's validation time plus
   its configured non-negative clock-skew allowance, whose default MUST be 60
   seconds. Equality at this boundary is valid.
7. The invoice has not expired at the server's validation time.

The server MUST NOT reuse an invoice across clients or challenges.

`extra.invoice` is a dynamic field. Scheme implementations MUST declare `invoice`
as a dynamic `extra` field. For a request that includes a `PaymentPayload`, the
resource server MUST compare every core field and every other server-declared
`extra` field. The facilitator MUST settle the invoice in
`PaymentPayload.accepted.extra.invoice`. This permits a paid retry to use its
original invoice when the server generates a new challenge.

## `PaymentPayload`

After paying the invoice, the client sends the preimage in the scheme-specific
`payload` object. The invoice remains in `accepted.extra.invoice`:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "bip122:000000000019d6689c085ae165831e93",
    "amount": "25000",
    "asset": "BTC",
    "payTo": "036360e856310ce5d294e8be33fc807077dc56ac80d95d9cd4ddbd21325eff73f7",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "bolt11",
      "paymentFlow": "upfront",
      "invoice": "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdq80q6rqvsxqzfvcqpjpal2l7zmrg46wpsxvv8aly29hzrjhvyxcrxxdm3r4ky8etpthh9p3r2ly8jvtlv6wprwvrm5t2zrxxmvpg57xhf24x2ngrd8smj8jtcp79fu42"
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

`accepted.extra.invoice` MUST be byte-identical to the invoice that the client
paid. It MAY differ from a newly generated `requirements.extra.invoice` on the
retry. Its signing key and payment terms MUST pass the checks below.

## Client Payment Construction

Before paying, a client MUST:

1. Require `scheme == "exact"`, a supported concrete network, `asset == "BTC"`, a
   positive integral `amount`, a positive integral `maxTimeoutSeconds`, and a valid
   compressed secp256k1 `payTo` encoded as 66 lowercase hexadecimal characters.
2. Require `extra.paymentFlow == "upfront"` and a non-empty `extra.invoice`. Treat
   a missing `extra.assetTransferMethod` as `"bolt11"` and reject any other value.
3. Strictly decode and verify the BOLT11 invoice and its signature.
4. Require exactly one inline description field (`d`) and no description hash
   field (`h`).
5. Require the invoice signing key to equal `payTo`.
6. Require the invoice currency to match the selected network.
7. Require the invoice to specify an integral millisatoshi amount equal to
   `PaymentRequirements.amount`.
8. Require the invoice expiry to equal `maxTimeoutSeconds` and its creation time to
   be no later than the client's validation time plus its configured non-negative
   clock-skew allowance, whose default MUST be 60 seconds.
9. Require the invoice to be unexpired at the client's validation time.
10. Ask its payer adapter to pay the invoice on the selected network.

The payer result MUST report `paid` and identify the same invoice, payment hash,
and amount. The client SHOULD report `in_flight` as a distinct result so the caller
can retry without starting a second payment. For a paid result, the client MUST
validate the preimage format and SHA-256 digest. It MUST NOT construct a
`PaymentPayload` if a check fails.

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
   require `bolt11`. Require `extra.paymentFlow == "upfront"` on both sides. Every
   server-declared `extra` field other than `invoice` MUST have the same value in
   `accepted`; additive client fields MAY remain.
4. Require non-empty invoices in `requirements.extra.invoice` and
   `accepted.extra.invoice`. The facilitator MUST use the accepted invoice for
   settlement and MUST NOT require the two invoices to be equal.
5. Strictly decode and verify the accepted invoice and its signature. Require
   exactly one inline description field (`d`) and no description hash field (`h`).
   Require its signing key to equal `requirements.payTo`, its BOLT11 currency to
   match the network, and its integral millisatoshi amount to equal
   `requirements.amount`.
   Require its expiry to equal `requirements.maxTimeoutSeconds`, and require its
   creation time not to exceed the facilitator's settlement time plus the
   configured clock-skew allowance.
6. Require the preimage to contain exactly 64 lowercase hexadecimal characters.
   Decode it as exactly 32 bytes and require
   `SHA-256(preimage_bytes) == payment_hash_bytes`.
7. Apply the expiry policy below.

The facilitator MUST verify the preimage locally and MUST NOT require receiver
access.

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

## Settlement and Replay Protection

Settlement does not move funds. The Lightning payment completed before the client
received the preimage. After validation, the facilitator MUST atomically insert the
payment hash into a restart-durable replay store. The insert MUST fail if the hash
already exists. In that case, the facilitator MUST return `duplicate_settlement`.
The resource server MUST NOT process the protected request until the insert
succeeds.

The replay entry MUST remain until at least one hour after
`invoice_end + skew`. It MUST NOT be removed while the invoice can still pass
validation.

On success, `SettlementResponse.transaction` MUST be the lowercase invoice payment
hash and `network` MUST be the concrete BIP-122 network. `payer` MUST be omitted
because Lightning does not reveal a stable payer address.

```json
{
  "success": true,
  "transaction": "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e",
  "network": "bip122:000000000019d6689c085ae165831e93"
}
```

## Error Vocabulary

Facilitators MUST use the following stable strings in `errorReason`. Settlement
MUST preserve the validation reason when validation fails.

| Reason | Meaning |
|---|---|
| `unsupported_scheme` | Either side is not `exact`. |
| `network_mismatch` | `accepted.network` differs from the requirement. |
| `unsupported_network` | The concrete BIP-122 network is unsupported. |
| `invalid_exact_bip122_asset` | Either side does not specify `BTC`. |
| `invalid_exact_bip122_amount` | Either amount is not a positive integer. |
| `invalid_exact_bip122_amount_mismatch` | `accepted.amount` differs from the requirement. |
| `invalid_exact_bip122_pay_to_mismatch` | `accepted.payTo` differs from the requirement. |
| `invalid_exact_bip122_pay_to_malformed` | `payTo` is not a lowercase compressed secp256k1 public key. |
| `invalid_exact_bip122_max_timeout_mismatch` | `accepted.maxTimeoutSeconds` differs from the requirement. |
| `invalid_exact_bip122_extra_mismatch` | A server-declared non-invoice `extra` field differs. |
| `invalid_exact_bip122_asset_transfer_method` | Either explicit asset transfer method is not `bolt11`. |
| `invalid_exact_bip122_payment_flow` | Either payment flow is missing or not `upfront`. |
| `invalid_exact_bip122_invoice_missing` | Either required invoice field is absent. |
| `invalid_exact_bip122_invoice_decode_failed` | Strict BOLT11 decoding, signature validation, or integral-msat validation failed. |
| `invalid_exact_bip122_invoice_description` | The invoice does not contain exactly one `d` field or contains an `h` field. |
| `invalid_exact_bip122_invoice_payee_mismatch` | The invoice signing key differs from `payTo`. |
| `invalid_exact_bip122_invoice_currency_mismatch` | BOLT11 currency does not match the network. |
| `invalid_exact_bip122_invoice_amount_mismatch` | BOLT11 amount differs from the required millisatoshis. |
| `invalid_exact_bip122_max_timeout` | `maxTimeoutSeconds` is not a positive integer. |
| `invalid_exact_bip122_invoice_expiry_mismatch` | BOLT11 expiry does not equal `maxTimeoutSeconds`. |
| `invalid_exact_bip122_invoice_created_in_future` | BOLT11 creation time exceeds validation time plus the clock-skew allowance. |
| `duplicate_settlement` | The payment hash is already used or lost an atomic settlement race. |
| `invalid_exact_bip122_preimage_missing` | `payload.preimage` is absent. |
| `invalid_exact_bip122_preimage_malformed` | Preimage contains non-lowercase-hex characters. |
| `invalid_exact_bip122_preimage_length` | Decoded preimage is not exactly 32 bytes. |
| `invalid_exact_bip122_preimage_hash_mismatch` | SHA-256 of the preimage does not equal the payment hash. |
| `invalid_exact_bip122_invoice_expired` | The paid-but-expired settlement-time window was exceeded. |

Client and server implementations SHOULD use these stable local failure reasons.
They are not facilitator response reasons unless a transport explicitly maps a local
failure into one:

| Reason | Meaning |
|---|---|
| `exact_bip122_invoice_issuance_denied` | The server's issuance limiter denied a new invoice. |
| `invalid_exact_bip122_payer_invoice_mismatch` | The payer adapter returned a different invoice. |
| `invalid_exact_bip122_payer_payment_hash_mismatch` | The payer adapter returned a different payment hash. |
| `invalid_exact_bip122_payer_amount_mismatch` | The payer adapter returned a different amount. |
| `exact_bip122_payment_in_flight` | Payment is still in flight and may be retried. |
| `exact_bip122_payment_not_paid` | The payer did not report a paid status. |
| `invalid_exact_bip122_payer_preimage_required` | A paid result omitted the mandatory preimage. |
| `invalid_exact_bip122_payer_preimage_malformed` | A payer preimage is not 64 lowercase hex characters. |
| `invalid_exact_bip122_payer_preimage_hash_mismatch` | A payer preimage does not hash to the invoice payment hash. |

## Security Considerations

### Mandatory Cryptographic Proof

The preimage is bearer proof of payment. Implementations MUST avoid logging or
otherwise disclosing it. A client MUST send it only to the resource server for the
invoice it paid. The facilitator can verify the invoice and preimage without
receiver credentials.

### Invoice Substitution

On a paid retry, the accepted invoice can differ from the new challenge invoice.
To prevent substitution, the client and facilitator MUST require the accepted
invoice's signing key to equal `payTo` and all payment terms to match. A
self-issued invoice fails unless the attacker controls the receiver node key.

### Receiver Key Isolation

`payTo` binds the invoice to the receiver node. A shared custodial node is not
compatible if an untrusted tenant can create invoices under the same node key. The
tenant could pay its own invoice and use the preimage against another tenant's
payment requirement. A compliant deployment MUST give the resource server
exclusive invoice-issuance authority for the receiver key.

### Invoice Issuance Denial of Service

Fresh invoices consume receiver node resources. Servers SHOULD limit or authorize
invoice issuance before calling the receiver. They MUST NOT reuse an invoice
across clients or challenges. If the transport provides a payment payload before
challenge generation, the server SHOULD validate it before it creates a replacement
invoice.

### Network and Currency Confusion

Servers, clients, and facilitators MUST map the concrete BIP-122 network to the
expected BOLT11 currency and reject mismatches. In particular, a `tb` testnet
invoice MUST NOT appear under the mainnet identifier.

### Durable Replay Protection

An in-memory replay store is not compliant because a restart loses used payment
hashes. All facilitator instances that settle for the same receiver MUST share a
restart-durable replay store with an atomic insert. A resource server MUST NOT send
invoices for one receiver to independent replay stores. A database can enforce
this rule with a unique payment-hash key. Persistent state is required because
Lightning has no public spent marker for the bearer proof.

### Payer Anonymity

Lightning routing does not give a facilitator a stable payer identity. Facilitators
MUST omit `SettlementResponse.payer` and MUST NOT infer payer identity from `payTo`
or the invoice payee.

## References

- [x402 protocol specification v2](../../x402-specification-v2.md)
- [BOLT11 payment encoding](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md)
- [CAIP-2 chain identification](https://chainagnostic.org/CAIPs/caip-2)
