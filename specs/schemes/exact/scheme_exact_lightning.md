# Exact Payment Scheme for Bitcoin Lightning Network (`exact`)

**Status:** Draft
**Author:** Javier Mateos (@javierpmateos)

## Scheme Name

`exact`

## Summary

This document specifies the `exact` payment scheme for the Bitcoin Lightning
Network. It enables x402 payments settled in bitcoin over Lightning: the
resource server (or its facilitator) issues a BOLT11 invoice for the exact
amount inside the 402 response; the client pays the invoice over Lightning and
retries the request presenting the payment preimage as a self-verifying proof
of settlement.

At least one production deployment already accepts Lightning payments using
x402 v2 wire format with `scheme: "exact"` and the invoice carried in `extra`;
this document formalizes that pattern with portable, non-custodial proofs.

## Payment Model

Lightning differs from other `exact` network implementations in one structural
way: settlement is **payer-initiated and completes before the proof exists**.
There is no signed transaction for a facilitator to submit. Instead:

1. The recipient's node signs an invoice (a payment commitment).
2. The client pays it; the payment settles atomically via HTLCs.
3. The recipient's node reveals the 32-byte preimage to the payer upon
   settlement. Possession of a preimage `p` with `SHA-256(p)` equal to the
   invoice payment hash is cryptographic proof the invoice was settled.

Verification therefore reduces to local checks — no RPC call, no gas, no
on-chain transaction in the request path. The facilitator never holds or moves
funds; the client pays a recipient-signed invoice directly. This satisfies the
protocol's trust-minimization requirement structurally.

Two deployment modes:

- **Mode A — merchant node (recommended).** The resource server's operator
  controls the Lightning node (or non-custodial wallet endpoint) that issues
  invoices. A facilitator, when used, only relays invoice creation and
  verifies proofs.
- **Mode B — facilitator-issued invoices.** The facilitator issues invoices
  against a receiving endpoint the merchant controls (e.g. a BOLT12 offer or
  an Ark-style self-custodial wallet with unilateral exit). The facilitator
  MUST NOT be able to claim or redirect funds. Custodial variants are out of
  scope.

## Network Identifier (CAIP-2)

Lightning is a payment network over Bitcoin, not a chain. This implementation
uses the underlying chain's `bip122` CAIP-2 identifier, with the Lightning
rail indicated by `extra.paymentMethod: "lightning"`:

| Network         | CAIP-2 identifier                          |
| --------------- | ------------------------------------------ |
| Bitcoin mainnet | `bip122:000000000019d6689c085ae165831e93`  |
| Signet          | `bip122:00000008819873e925422c1ff0f99f7c`  |
| Testnet3        | `bip122:000000000933ea01ad0ee984209779ba`  |

The v2 specification encourages non-blockchain networks to follow CAIP-2
format (e.g. `ach:us`); a dedicated `lightning:` namespace remains a possible
future refinement and would not change the rest of this document.

## Protocol Flow

1. Client requests a protected resource.
2. Server responds `402` with `PAYMENT-REQUIRED` advertising an `accepts`
   entry per this document, including a BOLT11 invoice for the exact amount.
3. Client validates the invoice against the requirements (amount, payment
   hash, binding — see Verification Rules 2–6, which clients SHOULD run
   before paying), then pays the invoice over Lightning and obtains the
   preimage.
4. Client retries with `PAYMENT-SIGNATURE` carrying the preimage.
5. Server verifies locally or via a facilitator (`/verify`, `/settle`) and
   responds `200` with `PAYMENT-RESPONSE`.

## x402 v2 Headers

- `PAYMENT-REQUIRED` — server payment requirements (base64 JSON).
- `PAYMENT-SIGNATURE` — client payment payload (base64 JSON).
- `PAYMENT-RESPONSE` — settlement result (base64 JSON).

## `PaymentRequirements` for `exact`

```json
{
  "scheme": "exact",
  "network": "bip122:000000000019d6689c085ae165831e93",
  "amount": "1500",
  "asset": "BTC",
  "payTo": "03a2...node_pubkey...9f",
  "maxTimeoutSeconds": 60,
  "extra": {
    "paymentMethod": "lightning",
    "denomination": "msat",
    "invoice": "lnbc15n1p...bolt11...",
    "paymentHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "invoiceExpiry": 1784102400,
    "requirementsHash": "b1946ac92492d2347c6235b4d2611184c9f6f6f2d2c2a3f6b9d0e1c2a3b4c5d6",
    "fiatQuote": {
      "amount": "0.001",
      "currency": "USD",
      "rate": "65743.69",
      "rateTimestamp": 1784098800
    }
  }
}
```

### Field Definitions

| Field                     | Required | Description                                                             |
| ------------------------- | -------- | ----------------------------------------------------------------------- |
| `amount`                  | Required | Invoice amount in `extra.denomination` units (`msat` RECOMMENDED)       |
| `asset`                   | Required | `"BTC"`                                                                 |
| `payTo`                   | Required | Recipient Lightning node public key (33-byte compressed secp256k1, hex) |
| `extra.paymentMethod`     | Required | `"lightning"`                                                           |
| `extra.denomination`      | Required | `"msat"` or `"sat"`                                                     |
| `extra.invoice`           | Required | BOLT11 invoice. `extra.offer` (BOLT12) MAY be provided instead          |
| `extra.paymentHash`       | Required | Invoice payment hash (convenience copy; MUST match decoded invoice)     |
| `extra.invoiceExpiry`     | Required | Unix time after which the invoice is invalid                            |
| `extra.requirementsHash`  | Optional | Commitment binding invoice to requirements (RECOMMENDED, see below)     |
| `extra.fiatQuote`         | Optional | Informational fiat context; not verified unless upgraded by extension   |

### Requirements Binding (`description_hash`)

To bind the invoice to the offered terms, the issuer SHOULD set the BOLT11 `h`
field (`description_hash`) to:

```
description_hash = SHA-256( JCS(PaymentRequirements \ {extra.invoice, extra.requirementsHash}) )
```

where `JCS` is RFC 8785 JSON Canonicalization, and publish the same value as
`extra.requirementsHash`. Because BOLT11 invoices are signed by the recipient
node key, the invoice becomes a recipient-signed commitment to the full
payment terms — closing requirements-substitution attacks without any
signature beyond what BOLT11 already carries. Extensions carrying richer
invoice metadata (e.g. verifiable invoice commitments) participate by
committing their canonical payload inside the requirements object before
hashing.

## `PaymentPayload` for `exact`

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/quote",
    "description": "Per-request access to /v1/quote",
    "mimeType": "application/json"
  },
  "accepted": { "...": "the chosen PaymentRequirements object, echoed" },
  "payload": {
    "paymentHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "preimage": "6c9d0e1c2a3b4c5d6b1946ac92492d2347c6235b4d2611184c9f6f6f2d2c2a3f"
  }
}
```

### Payload Fields

| Field         | Required | Description                                                  |
| ------------- | -------- | ------------------------------------------------------------ |
| `preimage`    | Required | 32-byte hex payment preimage obtained upon settlement        |
| `paymentHash` | Required | MUST equal `SHA-256(preimage)` and match the invoice         |

The payload is a bearer proof; see Security Considerations for replay
handling. Note the contrast with informal deployments that place the *invoice*
in the payload: an invoice proves nothing about settlement and forces
verification through the recipient's own wallet. The preimage is portable —
any party can verify it.

## Facilitator Verification Rules (MUST)

A facilitator (or a resource server verifying locally) MUST enforce:

### 1. Envelope Checks (x402 v2)

Reject if `paymentPayload.x402Version != 2`; if
`paymentPayload.accepted.scheme != "exact"`; if `accepted.network` is
unsupported; or if `accepted` does not match `paymentRequirements` on
`scheme`, `network`, `asset`, `payTo`, `amount`, `maxTimeoutSeconds`, or the
required `extra` keys (`paymentMethod`, `denomination`, `invoice`,
`paymentHash`).

### 2. Preimage Validity

`SHA-256(payload.preimage)` MUST equal `payload.paymentHash` (case-insensitive
hex, 32 bytes each).

### 3. Invoice Consistency

Decode `extra.invoice`. Its payment hash MUST equal `payload.paymentHash` and
`extra.paymentHash`. If decoding fails, verification MUST fail.

### 4. Signer Validation

The invoice signature MUST be valid and recover to `payTo`.

### 5. Amount Validation

The invoice amount, compared in millisatoshis after decoding, MUST equal
`amount` interpreted per `extra.denomination`. Never trust JSON amounts alone.

### 6. Expiry

The invoice MUST NOT be expired at verification time, and the proof MUST be
presented within `maxTimeoutSeconds` of invoice creation.

### 7. Requirements Binding

If `extra.requirementsHash` is present: the decoded invoice
`description_hash` MUST equal it, and it MUST recompute from the canonical
requirements object per the binding rule above.

### 8. Single Use

The payment hash MUST NOT have been accepted before. Verifiers maintain a
spent-set keyed by payment hash, retained at least until invoice expiry plus a
safety margin. Resource servers using multiple facilitators for the same
routes MUST share or route-partition the spent-set; otherwise a proof could be
redeemed once per facilitator.

Rules 1–7 are pure functions of the request and require no network access.
Facilitators in Mode B MAY additionally cross-check invoice state against the
issuing node as defense in depth.

## Settlement

Settlement is payer-initiated and completes before the proof exists; there is
no facilitator settlement action. `/settle` performs the verification rules
above (including rule 8) and returns the settlement response. `/verify` runs
rules 1–7 only, keeping it idempotent; redemption happens at `/settle`.

## `SettlementResponse`

```json
{
  "success": true,
  "transaction": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "network": "bip122:000000000019d6689c085ae165831e93",
  "payer": null
}
```

| Field         | Type           | Description                                                    |
| ------------- | -------------- | -------------------------------------------------------------- |
| `success`     | boolean        | Settlement success status                                      |
| `transaction` | string         | Payment hash (Lightning payments have no on-chain txid)        |
| `network`     | string         | CAIP-2 network identifier (same value as in requirements)      |
| `payer`       | string \| null | `null`; Lightning does not natively identify payers            |

Facilitator-registered extensions MAY populate `extensions` (e.g. settlement
attestations, verifiable invoice commitment envelopes) via the standard
extension pipeline.

## Security Considerations

### Trust Minimization

The facilitator never holds keys or funds and cannot forge settlements
without a preimage. A compromised facilitator can only falsely reject valid
proofs (denial of service); resource servers MAY fall back to local
verification.

### Replay and Race Protection

The preimage is a bearer proof. Single use per payment hash (rule 8) is
mandatory; transport-layer protections of the base specification apply. The
spent-set MUST be shared across facilitator instances serving the same
routes.

### Requirements Substitution

Without the `requirementsHash` binding, an intermediary could pair a cheap
invoice with expensive requirements. Issuers SHOULD always bind; clients
SHOULD verify the binding before paying.

### Hold-Invoice Griefing

Recipients using hold invoices can delay HTLC resolution, locking payer
liquidity. Clients SHOULD bound HTLC expiry deltas and treat excessive holds
as payment failure.

### Fiat Quote Staleness

`fiatQuote` is informational. Agents applying fiat budgets MUST NOT treat it
as verified unless upgraded by a signed-oracle extension.

### Payer Privacy

Lightning payments do not reveal payer identity to the verifier;
implementations MUST NOT require payer identification at the scheme level.
Identity, where needed, belongs to extensions.

## Interoperability Notes

- **L402 (bLIP-0026).** Complementary: L402 grants a reusable authentication
  token after payment; this implementation treats each request as an
  independently settled payment. Servers MAY offer both (`WWW-Authenticate`
  for L402, the `accepts` array for x402).
- **BOLT12.** Where offers are supported, `extra.offer` replaces
  `extra.invoice`; the invoice fetched from the offer MUST satisfy the same
  binding and verification rules.

## References

- BOLT11 invoice protocol; BOLT12 offers
- RFC 8785 JSON Canonicalization Scheme
- CAIP-2 chain identifiers; `bip122` namespace
- bLIP-0026 (L402)
- Reference implementation: https://github.com/javierpmateos/x402-lightning
