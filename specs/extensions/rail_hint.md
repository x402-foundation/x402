# Extension: `rail-hint`

## Summary

The `rail-hint` extension provides advisory rail-discovery and onboarding hints within x402. When a `402 Payment Required` response offers several payment requirements in `accepts[]`, it enables the resource server to tell a machine client *why* one offer is cheaper for the payer and *how* to onboard onto that rail if the client does not yet hold its asset.

This extension addresses a specific gap: the information needed to switch rails — comparative cost, client software, asset acquisition — lives in human documentation outside the protocol. The result is rail inertia: autonomous clients pay on whichever rail they already hold, even when both parties would benefit from another offer in the same `accepts[]` menu (for example, a rail without per-transaction fees or minimum-price floors). `rail-hint` moves that negotiation into the 402 response itself — the one message every paying client is guaranteed to parse, at the exact moment of payment choice.

`rail-hint` is the same structural move as the `auth-hints` extension, one layer down: `auth-hints` tells a client how to obtain *credentials* required by an `accepts[]` entry before paying; `rail-hint` tells a client how to obtain the *asset* of an `accepts[]` entry before paying. Unlike `auth-hints`, nothing in a rail-hint is ever mandatory: a client may pay any offer in `accepts[]` regardless of the hint.

This is a **Server ↔ Client** extension. The Facilitator is not involved.

---

## Design Principle: Discovery, Not Execution

A rail-hint tells a client *where to look*, never *what to run*. `accepts[]` is the sole binding term of the payment; a client that ignores the hint loses information and nothing else.

- Fields naming commands or endpoints (`bootstrap`, `topup`, `faucets`) are **untrusted remote input**, exactly as a URL in an HTTP body is. A client MUST NOT act on them blindly, and a server MUST NOT depend on their execution — a hint that only works when its command is run is out of spec.
- The hint is **not a price oracle or fee-comparison matrix**. `cheapest` and `why` annotate the server's *own* offers — claims a client can verify against the amounts already binding in `accepts[]` — never live market data or fee breakdowns for third-party networks. A client SHOULD treat any cost claim it cannot check against `accepts[]` as advertising and do its own arithmetic.

This is deliberate. Rail negotiation belongs inside the existing 402 handshake, and a payment-required response must never become a remote-code channel.

---

## Where the Numbers Come From

Prices move through the handshake in four steps, and no step queries an external price source:

1. **The server prices its own offers.** Each entry in `accepts[]` is a binding quote denominated in that rail's asset, set by the server before the 402 is sent. How the server converts between currencies to arrive at those quotes — an exchange feed, a fixed peg, manual pricing — is its own business, out of band and out of scope for this specification.
2. **The server annotates its own menu.** A rail-hint names which existing `accepts[]` entry the server considers lowest total-cost for the payer (`cheapest`) and explains why (`why`), using only its own quotes and the fee structure of its own offers — e.g. "this rail's quote is the whole cost; that rail adds a per-transaction fee floor."
3. **The client verifies against the same response.** `cheapest` MUST match an entry in `accepts[]`; every cost claim in `why` is checkable against the amounts binding in the same HTTP body. Nothing requires trusting the server about market data, because none is present.
4. **Cross-currency comparison stays with the client.** If a client wants to know what a quote is worth in a currency the server does not quote in `accepts[]`, it uses its own price source — exactly as it would for any x402 response with no hint at all. No rail-hint field carries an exchange rate, and this specification defines no mechanism for obtaining one.

---

## PaymentRequired

A resource server advertises the hint by including the `rail-hint` extension in the `extensions` object of the `402 Payment Required` response, as `{info, schema}`: `info` holds the hint's fields, and `schema` holds the JSON Schema (Draft 2020-12) that validates `info`, shipped inline so a client can validate the declaration without a network fetch.

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "1000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60
    },
    {
      "scheme": "exact",
      "network": "nano:mainnet",
      "amount": "6690000000000000000000000",
      "asset": "XNO",
      "payTo": "nano_3x4ui45q1cw8hydmfdn4g81jq39j9bif5t5wett534g7cfjmkrudljba1795",
      "maxTimeoutSeconds": 60
    }
  ],
  "extensions": {
    "rail-hint": {
      "info": {
        "cheapest": "nano:mainnet",
        "why": "The eip155:8453 offer is floored at 0.001 USDC; the nano:mainnet offer is the metered price ($0.0000027) with zero network fees and sub-second finality.",
        "docs": "https://example.com/docs",
        "agentReadme": "https://example.com/llms.txt",
        "bootstrap": "pip install feeless402 && nano-pay init",
        "topup": "any instant-swap service: ~$5 of a held asset into the hinted asset",
        "faucets": ["https://example.com/faucet"],
        "spec": "x402 exact scheme on nano:mainnet"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "rail-hint",
        "type": "object",
        "required": ["cheapest", "why"],
        "properties": {
          "cheapest": {
            "type": "string",
            "description": "The `network` value of the offer in `accepts` the server considers lowest total-cost for the payer."
          },
          "why": {
            "type": "string",
            "description": "Rationale a reasoning client can evaluate. SHOULD contain concrete prices, not slogans."
          },
          "docs": { "type": "string", "format": "uri" },
          "site": { "type": "string", "format": "uri" },
          "agentReadme": {
            "type": "string",
            "format": "uri",
            "description": "llms.txt-style plain-text onboarding document."
          },
          "bootstrap": {
            "type": "string",
            "description": "Executable onboarding path for the hinted rail. UNTRUSTED INPUT: clients MUST NOT execute blindly."
          },
          "topup": {
            "type": "string",
            "description": "Path from commonly-held assets to the hinted asset. MUST NOT require a specific vendor."
          },
          "faucets": {
            "type": "array",
            "items": { "type": "string", "format": "uri" },
            "description": "Endpoints offering small starter grants: POST {\"address\": ...}; MAY require a proof-of-work challenge from GET <faucet>/challenge."
          },
          "spec": {
            "type": "string",
            "description": "Reference to the payment-scheme specification for the hinted rail."
          }
        },
        "additionalProperties": true
      }
    }
  }
}
```

In this example, the server quotes both a USDC offer on Base and an XNO offer on Nano; the hint states that the server considers the `nano:mainnet` entry lowest total-cost for the payer and why, with onboarding pointers for a client that does not yet hold XNO.

The demonstration rail in this example was picked purely for simplicity's sake: a rail with zero fees and sub-second settlement let the authors exercise the full 402 → onboard → pay loop repeatedly at no cost while developing the extension. Nothing normative in this specification references any particular rail; either offer in the example could equally have been the hinted one, and the example simply mirrors the live endpoint the authors test against.

### Server-Declared Fields

All fields live inside `info`.

| Field         | Type     | Required | Description                                                                                                              |
|---------------|----------|----------|--------------------------------------------------------------------------------------------------------------------------|
| `cheapest`    | string   | Yes      | The `network` value of the offer in `accepts[]` the server considers lowest total-cost for the payer. MUST match an entry in `accepts[]`. |
| `why`         | string   | Yes      | Rationale a reasoning client can evaluate. SHOULD contain concrete, comparable prices rather than slogans.               |
| `docs`        | string   | No       | Documentation URL for the hinted rail.                                                                                   |
| `site`        | string   | No       | Homepage URL for the hinted rail or its tooling.                                                                         |
| `agentReadme` | string   | No       | Plain-text (llms.txt-style) onboarding document.                                                                         |
| `bootstrap`   | string   | No       | Executable onboarding path. Untrusted input; see Security Considerations.                                                |
| `topup`       | string   | No       | Path from commonly-held assets to the hinted asset. MUST NOT require a specific vendor.                                  |
| `faucets`     | string[] | No       | Endpoints offering small starter grants (`POST {"address": ...}`). MAY require a proof-of-work challenge via `GET <faucet>/challenge` to resist sybil claims. |
| `spec`        | string   | No       | Reference to the payment-scheme specification for the hinted rail.                                                       |

### Client Behavior

When a client receives a `402` response containing the `rail-hint` extension:

1. A client that does not recognize `rail-hint` ignores it, with no loss of function.
2. A client that already holds the hinted asset proceeds exactly as without the extension: select an offer from `accepts[]`, pay, retry.
3. A reasoning client MAY validate `info` against the inline `schema`, check that `cheapest` matches an entry in `accepts[]` (a mismatch invalidates the hint), and evaluate `why` against the amounts binding in `accepts[]`.
4. A client that chooses to onboard MAY consult `docs` or `agentReadme`, acquire the asset via `topup` or `faucets` under its own security policy and spending caps, and retry the original request paying on the hinted rail.

No step is required. The hint carries no mandate: the client's choice among `accepts[]` entries remains entirely its own.

### Server Behavior

- Servers MAY attach `rail-hint` to any 402 response whose `accepts[]` contains at least one offer.
- Servers MUST NOT place terms in a rail-hint that contradict `accepts[]`; on any conflict, `accepts[]` is authoritative.
- Servers MUST NOT depend on a client executing hinted commands; the payment flow MUST work for a client that ignores the hint entirely.
- Servers SHOULD keep `why` current with real prices — stale or exaggerated rationales are trivially falsified by clients comparing offers.

---

## Rail and Onboarding Neutrality

`rail-hint` is rail-agnostic. Any server may hint any rail in its `accepts[]`: a Lightning merchant may hint `bitcoin-lightning`; a USDC merchant accepting several EVM networks may point clients at whichever entry carries the lowest total cost; scheme authors bringing new rails to x402 use the same structured slot the day their scheme lands, with nothing to change in this specification. The extension standardizes the *negotiation*, not a winner.

The same neutrality applies to onboarding models: `bootstrap`, `topup`, and `faucets` carry whatever onboarding a rail actually has — a faucet for a rail with free starter grants, a compliant exchange ramp or custodial signup URL for an enterprise rail. Rails with heavier onboarding gain the most from a structured place to describe it.

---

## Legacy Key (Deprecated)

An earlier draft (draft-railhint-00) carried the fields flat at `extensions.railHint`, with no `info` wrapper and no inline schema. Servers built against that draft SHOULD migrate to `rail-hint`; during transition a server MAY emit both keys with identical field content. Clients SHOULD prefer `rail-hint` when both are present. The legacy key is reserved as a deprecated alias and will be dropped from a future revision.

---

## Security Considerations

- `bootstrap` and `topup` are untrusted remote input. A client MUST NOT execute them blindly; it SHOULD (a) act only on schemes it can verify against an independently obtained specification, (b) apply its own spending caps regardless of hinted amounts, and (c) prefer allowlisted package sources. The hint's role is discovery, not authority.
- A server MUST NOT depend on hinted commands being executed; a hint that only works when its command is run is out of spec.
- `cheapest` and `why` are verifiable against `accepts[]` in the same response; clients SHOULD reject a hint whose `cheapest` does not match an `accepts[]` entry and SHOULD treat unverifiable cost claims as advertising.
- Faucet endpoints SHOULD employ proof-of-work challenges or equivalent cost-imposing mechanisms so that sybil claims cost the claimant more than the grant is worth.
- The extension introduces no new trust surface for pricing: no field carries an exchange rate, and no step of the flow queries an external price source (see [Where the Numbers Come From](#where-the-numbers-come-from)).

---

## References

- [railHint draft specification](https://railhint.com) — draft-railhint-01, with canonical JSON Schema at [railhint.com/railhint.schema.json](https://railhint.com/railhint.schema.json)
- [Reference implementation](https://github.com/Feeless402/feeless402) — MIT-licensed server and client; live endpoint emitting the extension on every 402 at https://feeless402.com/premium
- [Extension: `auth-hints`](extension-auth-hints.md) — structural precedent: advisory 402 metadata on obtaining a prerequisite (credentials) before paying
- [Extension: `payment_identifier`](payment_identifier.md) — the `{info, schema}` declaration pattern this extension mirrors
- [Core x402 Specification](../x402-specification-v2.md)
