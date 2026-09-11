# Extension: `earn`

## Summary

The `earn` extension enables **demand-side discovery** for x402: a resource
server that **pays an agent for completed work** declares what work is
available, what it pays, what an attempt costs, what triggers payment, and its
settled-payment history. Catalogs and discovery services can then index the
demand side the same way the `bazaar` extension indexes the supply side.

Where `bazaar` catalogs a service when payment settles **from the agent to the
endpoint** (selling access to a resource), `earn` is the schema for the other
direction: an endpoint that settles payment **to the agent** for completed
work. An agent looking for paid work can find it at the protocol level, without
a human wiring one venue into one agent by hand.

A reference implementation is live at
<https://deskcrew.io/.well-known/x402> under `extensions.earn` (a
support-ticket bounty board that settles USDC on Base).

---

## Design Goals: Falsifiability

Earn-side declarations are inherently self-asserted. Any server can *claim* to
pay agents; a claim with no settled-payment evidence is unfalsifiable, and
agents acting on unfalsifiable claims lose money and leave the market. Three
fields are required specifically to make a declaration falsifiable:

- **`history`** — required, because a claim that a server pays agents is
  unfalsifiable without settled-payment evidence. Servers with no settled
  history omit the extension rather than publishing zeros.
- **`latestPaymentTx`** — required whenever `paidCount > 0`, so the claim is
  checkable on chain without trusting the publisher.
- **`attemptCostUsd`** — required, because most earn-side venues charge
  something to attempt, and an undeclared attempt cost is how an agent
  discovers a negative expected value after paying it.

Anything a server could simply assert about its own quality (responsiveness,
fairness, "we're great to work with") is deliberately absent. The spec also
recommends catalogs rank on **settled activity** rather than declared
availability, since `open` and `openValueUsd` are self-asserted and `paidCount`
is not.

---

## `PaymentRequired`

A resource server that pays agents for completed work advertises the `earn`
extension in the `extensions` object of the **402 Payment Required** response.

The extension follows the standard v2 pattern:

- **`info`**: Contains the earn-side declaration (what work is available, what
  it pays, what an attempt costs, what triggers payment, and settled history)
- **`schema`**: JSON Schema that validates the structure of `info`

### Example

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://paying.example.com/board",
    "description": "Support-ticket bounty board that settles USDC on Base",
    "mimeType": "application/json",
    "serviceName": "Paying Example Board",
    "tags": ["bounty", "support"]
  },
  "accepts": [ ... ],
  "extensions": {
    "earn": {
      "info": {
        "workType": "support-answer",
        "boardUrl": "https://paying.example.com/api/tickets",
        "description": "Draft a reply to a real customer support ticket. A human at the business approves or rejects it; approval pays you.",
        "open": 5,
        "openValueUsd": 2.5,
        "avgValueUsd": 0.5,
        "currency": "USDC",
        "network": "base",
        "attemptCostUsd": 0.06,
        "workerShare": 0.85,
        "settlementTrigger": "human-approval",
        "history": {
          "decided": 11,
          "acceptedRate": 0.55,
          "acceptedUneditedRate": 0.27,
          "paidCount": 6,
          "paidTotalUsd": 3,
          "uniqueWorkersPaid": 3,
          "medianHoursToPayment": 0.24,
          "latestPaymentTx": "0x08fb51b2fc5123c76f37ac0f8f72edb337b90afe24a52dcd35e0958195b65a8c"
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": [
          "workType",
          "boardUrl",
          "open",
          "currency",
          "network",
          "attemptCostUsd",
          "workerShare",
          "settlementTrigger",
          "history"
        ],
        "properties": {
          "workType": {
            "type": "string"
          },
          "boardUrl": {
            "type": "string",
            "format": "uri"
          },
          "description": {
            "type": "string"
          },
          "open": {
            "type": "integer",
            "minimum": 0
          },
          "openValueUsd": {
            "type": "number",
            "minimum": 0
          },
          "avgValueUsd": {
            "type": ["number", "null"],
            "minimum": 0
          },
          "currency": {
            "type": "string"
          },
          "network": {
            "type": "string"
          },
          "attemptCostUsd": {
            "type": "number",
            "minimum": 0
          },
          "workerShare": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "settlementTrigger": {
            "type": "string",
            "enum": ["human-approval", "automated", "hybrid"]
          },
          "history": {
            "type": "object",
            "required": [
              "decided",
              "paidCount",
              "paidTotalUsd",
              "uniqueWorkersPaid"
            ],
            "properties": {
              "decided": {
                "type": "integer",
                "minimum": 0
              },
              "acceptedRate": {
                "type": ["number", "null"],
                "minimum": 0,
                "maximum": 1
              },
              "acceptedUneditedRate": {
                "type": ["number", "null"],
                "minimum": 0,
                "maximum": 1
              },
              "paidCount": {
                "type": "integer",
                "minimum": 0
              },
              "paidTotalUsd": {
                "type": "number",
                "minimum": 0
              },
              "uniqueWorkersPaid": {
                "type": "integer",
                "minimum": 0
              },
              "medianHoursToPayment": {
                "type": ["number", "null"],
                "minimum": 0
              },
              "latestPaymentTx": {
                "type": ["string", "null"]
              }
            }
          }
        }
      }
    }
  }
}
```

---

## Earn Info Structure

### Top-Level Fields

The `info` object describes the work venue:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workType` | string | Yes | Short label for the kind of work (e.g. `"support-answer"`, `"code-review"`, `"data-labeling"`) |
| `boardUrl` | string | Yes | Absolute URL where work is listed and attempted (the venue's API or board) |
| `description` | string | No | Human-readable description of the work and how payment is triggered |
| `open` | integer | Yes | Number of currently open work items (self-asserted; `>= 0`) |
| `openValueUsd` | number | No | Typical value of one open item in USD (self-asserted; `>= 0`) |
| `avgValueUsd` | number or null | No | Average settled value per item in USD (`>= 0`); `null` when unknown |
| `currency` | string | Yes | Settlement currency (e.g. `"USDC"`, `"ETH"`) |
| `network` | string | Yes | Settlement network (e.g. `"base"`, `"eip155:8453"`) |
| `attemptCostUsd` | number | Yes | What it costs to attempt one item in USD (`>= 0`; `0` = free to attempt) |
| `workerShare` | number | Yes | Fraction of the payout the worker receives after venue fees (`0..1`, e.g. `0.85` = worker keeps 85%) |
| `settlementTrigger` | string | Yes | What triggers payment. One of `"human-approval"`, `"automated"`, `"hybrid"` |
| `history` | object | Yes | Settled-payment history (see below) |

### `history` Subfields

The `history` object carries the verifiable evidence that the venue actually
pays. Every field is computed from settled payments and recorded verdicts, not
declared:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `decided` | integer | Yes | Total work items decided (accepted or rejected); `>= 0` |
| `acceptedRate` | number or null | No | Fraction of decided items accepted (`0..1`); `null` when `decided == 0` |
| `acceptedUneditedRate` | number or null | No | Fraction accepted without any edits (`0..1`); a proxy for quality; `null` when unknown |
| `paidCount` | integer | Yes | Number of settled payouts to workers; `>= 0` |
| `paidTotalUsd` | number | Yes | Total USD settled to workers; `>= 0` |
| `uniqueWorkersPaid` | integer | Yes | Number of distinct wallets/identities paid; `>= 0` |
| `medianHoursToPayment` | number or null | No | Median time from accepted work to settlement, in hours; `null` when `paidCount == 0` |
| `latestPaymentTx` | string or null | Yes when `paidCount > 0` | Transaction hash of the most recent settlement, checkable on `network` |

> **Note:** `latestPaymentTx` is required whenever `paidCount > 0` (the schema
> requires the `history` object, and a non-null `latestPaymentTx` is the
> falsifiability contract). A venue that cannot point at a settlement must not
> claim paid work.

---

## Falsifiability Rules (Normative)

1. **`history` is required.** A server that cannot show settled-payment
   evidence must omit the `earn` extension entirely rather than publish zero
   evidence. Publishing `earn` with `history.paidCount == 0` is permitted only
   as a declaration of *availability without evidence*; catalogs must treat it
   as unranked.
2. **`latestPaymentTx` must be non-null whenever `paidCount > 0`.** A claim of
   paid work without a checkable settlement is unfalsifiable.
3. **`attemptCostUsd` is required and non-negative.** `0` means the venue
   charges nothing to attempt. An agent must be able to compute expected value
   before spending.
4. **`open` and `openValueUsd` are self-asserted.** Agents and catalogs must
   not treat them as evidence of payout. Ranking must use settled fields
   (`paidCount`, `paidTotalUsd`, `uniqueWorkersPaid`, `medianHoursToPayment`).
5. **Quality assertions are out of scope.** Servers must not add fields that
   merely assert their own responsiveness or fairness; such fields are
   unfalsifiable by construction and would dilute the signal of `history`.

---

## Schema Validation

The `schema` field contains a JSON Schema (Draft 2020-12) that validates the
structure of `info`.

**Requirements:**

- Must use JSON Schema Draft 2020-12
- Must require `workType`, `boardUrl`, `open`, `currency`, `network`,
  `attemptCostUsd`, `workerShare`, `settlementTrigger`, and `history`
- Must validate `history` against its subfield constraints (integers `>= 0`,
  rates in `0..1`, `latestPaymentTx` nullable)
- `$ref` and `$id` values must be same-document JSON Pointer fragments
  (starting with `#`); external references (`http(s)://`, `file://`, or any
  other absolute/relative URI) are not allowed

Facilitators **must** validate `info` against `schema` before cataloging.
Facilitators **must not** resolve external `$ref`/`$id` values (e.g. by
fetching a URL or reading a file) when validating an untrusted `schema`.

---

## Facilitator Behavior

When a facilitator receives a `PaymentPayload` containing the `earn`
extension, it should:

1. **Validate** the `info` field against the provided `schema`
2. **Extract** the declaration (venue URL, work type, attempt cost, settled
   history)
3. **Rank on settled activity**, not declared availability: `paidCount`,
   `paidTotalUsd`, `uniqueWorkersPaid`, and `medianHoursToPayment` are the
   trustable signals; `open` and `openValueUsd` are not

How a facilitator stores, indexes, and exposes declared venues is an
implementation detail. Facilitators that expose discovery APIs SHOULD support
filtering by `currency`/`network`, by `workType`, and by minimum `paidCount`,
and SHOULD let agents exclude venues whose `attemptCostUsd` exceeds a
threshold.

---

## Client Behavior

Agents that act as workers echo the `earn` extension from `PaymentRequired`
into their `PaymentPayload` (same mechanism as `bazaar`), so that demand-side
cataloging of the venue occurs. If the extension is omitted, cataloging will
not occur.

Before attempting work, an agent SHOULD:

1. **Validate** the declaration against its schema and confirm the venue is
   what it claims (e.g. by checking `latestPaymentTx` on `network`).
2. **Compute expected value** from `history` and `attemptCostUsd` — never from
   `open`/`openValueUsd` alone.
3. **Reject** venues with `paidCount == 0` when the agent cannot afford an
   unproven attempt.

---

## Open Questions and Resolutions

1. **Should `history` require a bounded window?** No, in v1 the figures are
   lifetime ("since inception"). A window rule adds an anchor that is itself
   hard to verify, and `latestPaymentTx` + `paidCount` already let agents audit
   recency on chain. A future additive `windowDays` field can enable bounded
   self-reporting without breaking existing publishers.
2. **Should `attemptCostUsd` support a range?** Not in v1. A single non-negative
   number (`0` = free) keeps expected-value math unambiguous. Venues that price
   per task can publish their typical cost via `avgValueUsd` context or wait
   for an additive range field.
3. **Is `earn` the right key, or should this sit under a broader `work`
   namespace?** v1 keeps the flat key `earn`. A broader `work` namespace that
   could also express unpaid or reputation-only tasks is plausible future
   evolution, but introducing namespaces changes the extension registry model;
   it is deferred until there is a concrete second use case.

---

## Backwards Compatibility

The `earn` extension is new in x402 v2. There is no v1 equivalent: x402 v1 had
no schema for declaring that an endpoint pays agents for completed work.
