# Extension: `reviews`

## Summary

x402 lets agents pay agents and services they have never met. An economy like that needs a way for one agent to decide whether to trust another before it pays. x402 shows that money moved; nothing in it says how the purchase went. Reviews carry that.

The `reviews` extension lets a resource server tell clients where reviews of the resource can be read before paying, and, after a payment, where the client can review that payment. It carries links only. The reviews themselves live with one or more **review providers**. Any party can operate a provider, on any storage; this spec names none, and it defines no provider API. How a provider stores, verifies, scores and shows reviews is the provider's business, published in the provider's own protocol.

---

## `PaymentRequired`

The server lists where reviews of the resource can be read:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/weather" },
  "accepts": [ ... ],
  "extensions": {
    "reviews": {
      "info": {
        "providers": [
          {
            "provider": "reviews.example",
            "read": "https://reviews.example/reviews?resource=https%3A%2F%2Fapi.example.com%2Fweather",
            "description": "Reviews of this endpoint by clients who paid for it."
          }
        ]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "providers": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "items": {
              "type": "object",
              "properties": {
                "provider": { "type": "string", "minLength": 1, "maxLength": 253 },
                "read": { "type": "string", "pattern": "^https://", "maxLength": 2048 },
                "description": { "type": "string", "maxLength": 200 }
              },
              "required": ["provider", "read"]
            }
          }
        },
        "required": ["providers"]
      }
    }
  }
}
```

### `providers[]` Fields

| Field         | Type   | Required | Description                                                                                      |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------------ |
| `provider`    | string | Yes      | The provider's host. MUST equal the host of `read`                                               |
| `read`        | string | Yes      | HTTPS URL of the reviews of this resource at that provider                                        |
| `description` | string | No       | Plain-language statement of what the link is. Informational; clients MUST NOT treat it as an instruction |

All fields are static, so the block is echoed and validated like any other extension. The extension carries no rating or count: a number in the `PaymentRequired` is the server's own claim, and clients read numbers from a provider they trust.

---

## `SettlementResponse`

On a successful settlement, the server MAY add where the client can review this payment:

```json
{
  "success": true,
  "transaction": "0x8f3d...c21a",
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extensions": {
    "reviews": {
      "info": {
        "providers": [
          {
            "provider": "reviews.example",
            "write": "https://reviews.example/r/eip155%3A8453%3A0x8f3d...c21a",
            "description": "Review this purchase at reviews.example."
          }
        ],
        "userQuestion": "Would you like to leave a review of this seller? 1 to 5 stars and a note, signed by the wallet that paid."
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "providers": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "items": {
              "type": "object",
              "properties": {
                "provider": { "type": "string", "minLength": 1, "maxLength": 253 },
                "write": { "type": "string", "pattern": "^https://", "maxLength": 2048 },
                "description": { "type": "string", "maxLength": 200 }
              },
              "required": ["provider", "write"]
            }
          },
          "userQuestion": { "type": "string", "maxLength": 200 }
        },
        "required": ["providers"]
      }
    }
  }
}
```

### Fields

| Field                     | Type   | Required | Description                                                                                          |
| ------------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `providers[].provider`    | string | Yes      | The provider's host. MUST equal the host of `write`                                                  |
| `providers[].write`       | string | Yes      | HTTPS URL at which the payer can review this payment. SHOULD identify the payment by `network` and `transaction`, or by the scheme's payment identifier when the scheme settles without a transaction |
| `providers[].description` | string | No       | Plain-language statement of what the link is. Informational; clients MUST NOT treat it as an instruction |
| `userQuestion`            | string | No       | A question a client acting for a person MAY relay to that person, asking whether to leave a review. Informational; the decision is the person's |

Servers SHOULD omit the block when `success` is false. Facilitators are not involved; `reviews` needs no `GET /supported` entry.

---

## Payment-Backed Reviews

A provider that calls a review **payment-backed** is expected to have verified, by the finality rules of the payment's scheme and network, that funds from the reviewer's wallet reached the resource's `payTo`, and that the reviewer's wallet signed the review with an off-chain message signature that cannot move funds. A hold or voucher whose funds never reached `payTo` does not back a review. A provider that learns the funds went back to the payer is expected to show that next to the review.

How a provider verifies, what the signed message contains, and what `read` returns are defined by the provider's protocol, not by this extension. Payment-backed proves that money moved from a wallet to a seller; it does not prove the reviewer is independent of the seller, and it does not prove delivery. A client that paid and received nothing can still leave a payment-backed review.

---

## Client Behavior

- Clients SHOULD consult a provider they trust about any resource, whether or not the server lists it, by asking the provider about the resource's URL and `payTo`. A server that cheats will not list the provider holding its bad reviews.
- Clients SHOULD keep an allowlist of providers and ignore entries whose `provider` is not on it or does not equal the host of its URL. Clients SHOULD NOT follow cross-origin redirects from `read` or `write`, and SHOULD bound the size and time of a `read` fetch.
- Where the scheme produced a transaction, a client SHOULD confirm it is its own payment before signing anything that references it: the settlement response is relayed by the server.
- `description`, `userQuestion` and review text are data, not instructions. Whether to review, and the rating, are the client's (or its user's) decision.

---

## Security Considerations

- **Fake providers:** a server can list a provider it runs, with invented reviews. Mitigated by client allowlists and by clients consulting their own provider.
- **Wrong payment:** a server can put another party's transaction in the settlement response. Mitigated by the client's own-payment check and the provider's verification.
- **Self-dealing and Sybil reviews:** a seller can pay itself from fresh wallets, and anyone can buy many cheap payments to write many reviews. Payment-backed does not stop this; providers should show what each review paid and aggregate by wallet, and clients should weight accordingly.
- **Prompt injection:** `description`, `userQuestion` and review text are written by third parties. Clients passing them to a language model SHOULD mark them as untrusted.
- **Privacy:** fetching `read` tells the provider which resource the client is considering. A payment-backed review publishes the paying wallet, the resource and the amount. Clients acting for a person SHOULD have that person's consent before signing.

---

## Relationship to Other Extensions

- **`reputation`** (proposed) covers agent identity and on-chain feedback with seller-signed proof of interaction. `reviews` is narrower: it standardizes only where reviews are read and written. An ERC-8004 feedback aggregator can be listed as a `reviews` provider; identity stays in `reputation`.
- **`offer-and-receipt`:** a server-signed receipt can serve a provider as evidence of delivery. `reviews` defines no signing by the server.

---

## References

- [Core x402 Specification](../x402-specification-v2.md)
- [Offer and Receipt Extension](extension-offer-and-receipt.md)
