# Extension: `payment-policy`

## Summary

The `payment-policy` extension lets a **resource server publish the rules by which it will accept a
payment**, and lets a **client record the decision it made before signing**. It standardises the
document, not the engine: any evaluator can consume it, and a client that does not understand it is
unaffected.

Two problems it addresses:

1. A 402 challenge states *what* to pay (`amount`, `asset`, `payTo`, `network`) but not *under what
   conditions* a server will accept it — so a client cannot know before signing whether the payment
   will be honoured for reasons other than on-chain settlement.
2. Nothing in the protocol carries a client's own reasoning. A refusal today is silence: the agent
   simply does not pay, and the server cannot tell "declined by policy" from "never saw it".

## `PaymentRequired`

A resource server advertises its policy by including `payment-policy` in the `extensions` object:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "https://api.example.com/premium-data", "description": "Premium data" },
  "accepts": [ { "scheme": "exact", "network": "eip155:8453", "amount": "10000", "asset": "0x833...", "payTo": "0x209...", "maxTimeoutSeconds": 60, "extra": { "name": "USDC", "version": "2" } } ],
  "extensions": {
    "payment-policy": {
      "info": {
        "version": 1,
        "rules": {
          "max_amount": { "value": "1.00", "asset": "USDC", "decimals": 6 },
          "allowed_networks": ["eip155:8453"],
          "allowed_assets": [
            { "symbol": "USDC", "decimals": 6, "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "network": "eip155:8453" }
          ],
          "allowed_pay_to": ["0x209693Bc6afc0C5328bA36FaF03C514EF312287C"],
          "max_timeout_seconds": 60,
          "velocity": { "window_seconds": 86400, "max_count": 100, "max_amount": { "value": "10.00", "decimals": 6, "asset": "USDC" } },
          "unknown_payee": "review"
        }
      },
      "schema": { "$ref": "https://x402.org/schemas/payment-policy-v1.json" }
    }
  }
}
```

### `info.rules`

| Field | Type | Meaning when absent |
|---|---|---|
| `max_amount` | `{ value, asset, decimals }` | no upper bound stated |
| `allowed_networks` | `string[]` (CAIP-2) | any network in `accepts` |
| `allowed_assets` | `{ symbol, decimals, address, network }[]` | any asset in `accepts` |
| `allowed_pay_to` | `string[]` (addresses) | any `payTo` in `accepts` |
| `max_timeout_seconds` | `integer` | any `maxTimeoutSeconds` |
| `velocity` | `{ window_seconds, max_count?, max_amount? }` | no stated velocity limit |
| `unknown_payee` | `"pay" \| "review" \| "do_not_pay"` | `review` |

The rules are **the server's own acceptance conditions**. A server that publishes `payment-policy` MUST
enforce it: publishing a policy it does not apply is worse than publishing none, because a client will
make a decision on it.

## `PaymentPayload`

Per the core spec, a client echoes the extension's `info` unchanged and MAY append. This extension
defines one optional append: the decision.

```json
{
  "x402Version": 2,
  "accepted": { "...": "the requirements it chose" },
  "payload": { "...": "scheme-specific" },
  "extensions": {
    "payment-policy": {
      "info": { "version": 1, "rules": { "...": "echoed verbatim" } },
      "verdict": {
        "decision": "do_not_pay",
        "rule_id": "allowlist.payTo",
        "evaluator": { "name": "paystage", "version": "2026.11.15" }
      }
    }
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `decision` | `"pay" \| "review" \| "do_not_pay"` | Yes | what the client decided |
| `rule_id` | `string` | No | dotted identifier of the rule that determined it |
| `evaluator` | `{ name, version }` | No | who decided, for audit |

`verdict` is **advisory**. It is not proof of anything: a client can claim `pay` while having checked
nothing, and a server MUST NOT treat it as authorisation. Its purpose is diagnosis — a server that sees
`do_not_pay` learns the request was considered and declined rather than never seen.

## When a client decides `do_not_pay`

The client MUST NOT send `PAYMENT-SIGNATURE`. It MAY surface the reason to the user or agent. If it
chooses to signal the server, it does so out of band; this extension does not add a "decline" message,
because a client that refuses must not be forced to make a request in order to refuse.

## When a server refuses on policy

If a payment arrives that violates the published policy, the server MUST NOT settle and MUST answer
with `402` whose `extensions["payment-policy"].info.refusal` names the rule:

```json
{ "payment-policy": { "info": { "version": 1, "refusal": { "rule_id": "velocity.max_count" } } } }
```

`409 Conflict` was considered and rejected: the request is payable in principle, and `402` keeps a
single retry path for clients.

## Relationship to core spend controls (the first question a reviewer will ask)

Core already ships client-side `spendControls` — a per-payment USD cap (default `$1`) and an
`allowedAssets` list with atomic per-asset caps — plus an `onBeforePaymentCreation` hook that can abort
with a reason. This extension deliberately does **not** restate any of that.

| Rule | Where it belongs | Why |
|---|---|---|
| per-payment amount cap | **core `spendControls`** | already implemented and enforced before any policy runs |
| `allowed_assets` | **core `spendControls.allowedAssets`** | same |
| `allowed_pay_to` | **this extension** | core has no payee control; a payment to the wrong address is not a spend-cap problem |
| `allowed_networks` | scheme registration (core) or this extension when the server publishes it | scoping is registration today; publishing it lets a client detect a mismatch before signing |
| `velocity` | **this extension** | cross-request state; core evaluates one payment at a time by design |
| `unknown_payee` | **this extension** | a decision policy, not a numeric control |
| receipt verification | **not in this extension** | detached artifacts; a separate concern with its own spec |

So the extension's job is narrower than "policy": it standardises **the rules a per-payment cap cannot
express**, and the server-side publication of them. A client MAY implement it entirely inside an
`onBeforePaymentCreation` hook — which is exactly what the reference implementation does — and that is
the strongest argument for the spec: the hook exists, the consumer exists, only the document is missing.

## Facilitator behavior

A facilitator MUST ignore `payment-policy` entirely, except to pass it through unmodified. Policy is a
server↔client contract; a facilitator that enforced one party's policy would be deciding on behalf of a
server that never asked it to.

## Security considerations

- **A published policy is a claim, not a guarantee.** It tells a client what the server *says* it
  requires. The only enforcement that exists is the server's behaviour, and the only check a client can
  perform is post-hoc: did the server behave as its policy said.
- **A verdict is not a credential.** Never gate access on it.
- **Rules are intentionally not a scripting language.** No expressions, no references to other
  requests' data beyond the velocity window. A policy document that can compute is a policy document
  that can be wrong in ways nobody can audit.
- **Timestamps and windows are server-side.** A client cannot verify a velocity claim about itself, and
  a server that trusts a client's velocity statement has no velocity limit.

## Backwards compatibility

Absent the extension, nothing changes: a client signs as it does today, a server accepts as it does
today. A client that does not understand `payment-policy` echoes `info` unchanged and signs — which is
why the rules are advisory to it rather than binding.

## References

- Core spec §5.1 (extensions in `PaymentRequired`) and §5.2 (echo in `PaymentPayload`).
- `bazaar` extension — the closest precedent for an `info`/`schema` pair.
- `@paystage/policy` — this draft's field names are that implementation's schema.
