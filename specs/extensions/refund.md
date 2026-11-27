# Extension: `refund`

## Summary

x402 defines how money moves from client to server. It defines no path back.
The `refund` extension standardizes that path: servers advertise refund terms,
clients submit signed refund requests, servers execute them, and both sides get
a signed refund receipt.

This extension composes with two existing extensions:
- **Offer and Receipt** (`extension-offer-and-receipt.md`): the signed receipt
  is the client's proof of the original payment.
- **payment-identifier** (`payment_identifier.md`): the payment id (when used)
  disambiguates the payment being refunded.

**Scope boundary:** this extension standardizes the *wire format* for refund
requests and responses. It does not obligate any server to refund — refunding
is server policy. Dispute arbitration (who decides a contested refund) is
explicitly out of scope and left to a future extension.

---

## `PaymentRequired`

A resource server advertises refund support by including the `refund` extension
in the `extensions` object of the **402 Payment Required** response.

```json
{
  "extensions": {
    "refund": {
      "info": {
        "refundEndpoint": "https://api.example.com/x402/refund",
        "windowSeconds": 86400,
        "partialRefunds": true,
        "policyUrl": "https://example.com/refund-policy"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "refundEndpoint": { "type": "string", "format": "uri" },
          "windowSeconds": { "type": "integer", "minimum": 0 },
          "partialRefunds": { "type": "boolean" },
          "policyUrl": { "type": "string", "format": "uri" }
        },
        "required": ["refundEndpoint", "windowSeconds", "partialRefunds"]
      }
    }
  }
}
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `refundEndpoint` | Yes | HTTPS URL accepting refund requests (POST) |
| `windowSeconds` | Yes | How long after settlement a refund may be requested. `0` = no refunds |
| `partialRefunds` | Yes | Whether amounts below the full settled amount are accepted |
| `policyUrl` | No | Human-readable refund policy |

---

## `RefundRequest`

The client POSTs a `RefundRequest` to `refundEndpoint` with
`Content-Type: application/json`.

```json
{
  "x402Version": 2,
  "paymentReference": {
    "txHash": "0xabc...def",
    "network": "eip155:8453",
    "paymentId": "01J9Z..."
  },
  "amount": "10000",
  "reason": "service_not_delivered",
  "reasonDetail": "Endpoint returned 500 for 12 consecutive calls",
  "refundTo": "0x123...789",
  "idempotencyKey": "9f3b1c2d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
  "receipt": {
    "format": "eip712",
    "payload": { "...": "signed receipt payload, see Offer and Receipt extension" },
    "signature": "0x..."
  },
  "payerSignature": "0x..."
}
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `x402Version` | Yes | Protocol version (must be 2) |
| `paymentReference` | Yes | Identifies the settled payment |
| `paymentReference.txHash` | Yes | Settlement transaction hash |
| `paymentReference.network` | Yes | CAIP-2 network id of the settlement |
| `paymentReference.paymentId` | No | The `payment-identifier` extension id, when one was used |
| `amount` | Yes | Refund amount in atomic units of the settled asset. MUST be ≤ settled amount minus already-refunded total |
| `reason` | Yes | Machine-readable reason code (see below) |
| `reasonDetail` | No | Free-text detail |
| `refundTo` | No | Refund destination. Defaults to the original payer address. MUST be an address on the settlement network |
| `idempotencyKey` | Yes | Client-generated UUID. Servers MUST dedupe on this key |
| `receipt` | No | The signed receipt from the Offer and Receipt extension, when the server issued one. Strengthens the request; servers MAY require it |
| `payerSignature` | Yes | Signature over the canonical request bytes by the original payer (EIP-712 or JWS, same format rules as the Offer and Receipt extension) |

### Reason codes

`service_not_delivered`, `service_defective`, `duplicate_payment`,
`overcharge`, `customer_request`, `other`.

---

## `RefundResponse`

```json
{
  "status": "executed",
  "amount": "10000",
  "refundTxHash": "0xdef...abc",
  "refundReceipt": {
    "format": "eip712",
    "payload": { "...": "..." },
    "signature": "0x..."
  }
}
```

| Field | Required | Description |
| ----- | -------- | ----------- |
| `status` | Yes | `executed`, `pending`, or `denied` |
| `amount` | Yes | Amount refunded (or requested, when denied) |
| `refundTxHash` | `executed` only | On-chain refund transaction hash |
| `denialReason` | `denied` only | Machine-readable: `outside_window`, `not_payer`, `already_refunded`, `amount_exceeds_settled`, `policy_denied`, `unknown_payment` |
| `refundReceipt` | `executed` only | Signed refund receipt, same artifact shape as the Offer and Receipt extension (`name: "x402 refund receipt"` for the EIP-712 domain) |

`pending` is for servers that queue refunds (e.g., batched or manual review);
the client SHOULD poll `refundEndpoint/{idempotencyKey}` for the final state.

---

## Server responsibilities

When a server receives a `RefundRequest`, it MUST:

1. Verify the referenced payment actually settled (tx exists on `network`,
   amount/asset/`payTo` match a payment the server accepted).
2. Verify `payerSignature` recovers to the original payment's payer address.
   Requests from any other key MUST be denied with `not_payer`.
3. Enforce `windowSeconds` from the advertised terms. Late requests are
   denied with `outside_window`.
4. Track per-payment refunded totals. `refunded_total + amount` MUST NOT
   exceed the settled amount; violations are denied with
   `already_refunded` / `amount_exceeds_settled`.
5. Dedupe on `idempotencyKey`: a repeated key MUST return the original
   response, never a second transfer.
6. Execute the refund as an on-chain transfer from the server's own funds.
   The facilitator MUST NOT move server funds (trust minimization, per the
   x402 principles).
7. Return a signed refund receipt on `executed`.

## Facilitator

Facilitators MAY expose a read-only refund confirmation (verifying that
`refundTxHash` settled). No new fund-moving facilitator endpoint is defined:
refunds are server-executed by design.

---

## Security considerations

- **Replay:** `idempotencyKey` is required; servers MUST treat a repeated key
  as a replay and return the cached response.
- **Payer binding:** the signature check ties the request to the original
  payer. A stolen receipt alone cannot trigger a refund to an attacker's
  address — but note `refundTo` lets the payer redirect; servers SHOULD
  confirm out-of-band for large amounts per their own policy.
- **Double refund:** per-payment refunded totals are the backstop; the
  idempotency key is the first line.
- **No forced refunds:** a server that advertises `windowSeconds: 0`
  declines all refunds. Clients MUST treat refund support as advertised,
  not guaranteed. Disputed cases belong to a future arbitration extension.

---

## Why this belongs in the spec

Agent commerce is scaling on x402's buy path with no sell-side primitives.
Without a standard refund flow, every implementation invents its own —
incompatible, unauditable, and invisible to the agents holding the receipts.
This extension closes the loop using only mechanisms x402 already has:
extensions for discovery, signed artifacts for proof, idempotency keys for
safety.
