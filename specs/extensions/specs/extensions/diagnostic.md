**Extension name:** `diagnostic`
**Status:** Proposed
**Author:** @jonathanbulkeley
**Closes:** #1860

---

## Summary

This extension adds an optional `diagnostic` field to x402 402 responses, providing a machine-readable vocabulary for communicating payment failure state. It enables autonomous agents to distinguish between retriable errors, non-retriable errors, and situations requiring human escalation — and enables client SDKs to implement appropriate handling for each case.

---

## Motivation

The current x402 specification defines what a 402 response looks like when payment is required. It does not define any mechanism for communicating *why* payment is failing when a client repeatedly attempts and fails to pay.

Every 402 response looks identical regardless of whether it is:

- A first request from a new client legitimately discovering payment requirements
- A payment attempt where the invoice expired before settlement
- A payment attempt where the wallet has insufficient funds
- A broken agent that has made thousands of requests with zero successful payments

From the server's perspective these are completely different situations. From the protocol's perspective they are indistinguishable.

### Real-world case

A production x402 oracle (myceliasignal.com) received 8,000+ daily requests from a client over 18 days with zero successful payments. The client had previously paid successfully. Something in its payment stack broke. The server had no protocol mechanism to signal the issue. The client received 144,000+ identical 402 responses. The operator was unaware.

This is not an edge case. As agentic payment volume grows, broken payment logic will become a regular occurrence. Without a diagnostic vocabulary, every failure is invisible until someone manually inspects server logs.

---

## Extension Format

This extension follows the x402 v2 extension pattern. When present, the `diagnostic` object appears inside the `extensions` field of the 402 response body.

### Response example

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/resource"
  },
  "accepts": ["x402"],
  "extensions": {
    "diagnostic": {
      "info": {
        "code": "PAYMENT_ATTEMPTS_EXCEEDED",
        "message": "8,432 requests received with no valid payment in 18 days.",
        "attempts": 8432,
        "firstAttempt": "2026-03-10T00:00:00Z",
        "suggestion": "Check payment handler configuration and wallet balance.",
        "escalate": true
      },
      "schema": "https://raw.githubusercontent.com/coinbase/x402/main/specs/extensions/diagnostic.schema.json"
    }
  }
}
```

---

## Field Reference

### `extensions.diagnostic`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `info` | object | yes | Diagnostic information object |
| `schema` | string | no | URL to the JSON schema for validation. When this spec is merged, the canonical URL will be `https://raw.githubusercontent.com/coinbase/x402/main/specs/extensions/diagnostic.schema.json`. Until then this field SHOULD be omitted. |

### `extensions.diagnostic.info`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | yes | Machine-readable diagnostic code (see codes below) |
| `message` | string | no | Human-readable description of the failure state |
| `attempts` | integer | no | Number of requests received without a successful payment |
| `firstAttempt` | string (ISO 8601) | no | Timestamp of the first request in the current failure sequence |
| `suggestion` | string | no | Actionable suggestion for recovery |
| `escalate` | boolean | no | When `true`, autonomous resolution is unlikely — the client should halt and surface to a human operator |

---

## Diagnostic Codes

| Code | Meaning | Retriable | Escalate |
|------|---------|-----------|----------|
| `PAYMENT_REQUIRED` | Standard first-request 402, no prior attempts | Yes | No |
| `INVOICE_EXPIRED` | Payment was attempted but the invoice expired before settlement | Yes | No |
| `PAYMENT_UNVERIFIED` | Payment header was present but signature verification failed | No | Recommended |
| `PAYMENT_ATTEMPTS_EXCEEDED` | Many requests received with no successful payment | No | Yes |
| `WALLET_INSUFFICIENT_FUNDS` | On-chain balance is too low to cover the required payment | No | Yes |
| `OPERATOR_ALERT` | Server cannot determine root cause — escalate to human operator | No | Yes |

### Code semantics

**`PAYMENT_REQUIRED`**
The default state. No diagnostic history. The client should proceed with the normal payment flow. Servers MAY omit the `diagnostic` field entirely for first requests; including it with this code is optional but provides consistency for clients that always parse the extension.

**`INVOICE_EXPIRED`**
The client attempted payment but the payment window expired before settlement. In x402 (USDC on Base), this corresponds to an expired EIP-3009 `validBefore` timestamp. In L402 (Lightning), this corresponds to a Lightning invoice that expired before it was paid. The client should request a fresh payment challenge and retry. Retriable once — if a second attempt also expires, escalation is recommended. Common causes: slow routing, delayed client processing, or a client clock skew issue.

**`PAYMENT_UNVERIFIED`**
A payment header (`X-PAYMENT`) was present in the request but signature verification failed. The client should not retry automatically — the payment logic itself is likely broken. Surface to the operator for review.

**`PAYMENT_ATTEMPTS_EXCEEDED`**
The server has received a high volume of requests from this client with no successful payments. The client's payment handler is likely broken or the wallet is empty and not being refilled. The client should halt, stop retrying, and alert the operator.

**`WALLET_INSUFFICIENT_FUNDS`**
The facilitator returned an `insufficient_funds` signal during payment verification. The client's wallet does not have enough funds to cover the payment. The client should halt and surface the wallet balance to the operator.

**`OPERATOR_ALERT`**
A general escalation code for situations where the server cannot determine the specific root cause but is confident that autonomous resolution is unlikely. The client should treat this identically to `PAYMENT_ATTEMPTS_EXCEEDED` — halt, stop retrying, and alert the operator.

---

## `escalate` Flag

The `escalate: true` flag is the primary signal for client SDKs to implement human escalation. When a client receives `escalate: true`:

1. **Stop retrying** the current endpoint immediately
2. **Emit a structured escalation event** with the full diagnostic payload attached (see Client Implementation below)
3. **Block further requests** to this endpoint until an operator reviews and explicitly re-enables it

The `escalate` flag is distinct from the `code` field. A server MAY set `escalate: true` with any code, not only the codes listed as "Escalate: Yes" above. The codes provide semantic meaning; the flag provides the behavioral signal.

---

## Client Implementation

### Parsing and routing

Client SDKs SHOULD parse `extensions.diagnostic.info.code` and implement the following behavior:

| Code | Recommended client behavior |
|------|---------------------------|
| `PAYMENT_REQUIRED` | Proceed with normal payment flow |
| `INVOICE_EXPIRED` | Request fresh payment challenge, retry once — if second attempt also expires, surface to operator |
| `PAYMENT_UNVERIFIED` | Do not retry, surface to operator via approval queue |
| `PAYMENT_ATTEMPTS_EXCEEDED` | Halt, emit escalation event, block endpoint |
| `WALLET_INSUFFICIENT_FUNDS` | Halt, surface wallet balance to operator, block endpoint |
| `OPERATOR_ALERT` | Halt, emit escalation event, block endpoint |

### Escalation event schema

When `escalate: true` is received, client SDKs SHOULD emit a structured escalation event to the operator's notification surface. Recommended event shape:

```json
{
  "type": "x402_escalation",
  "endpoint": "https://api.example.com/resource",
  "amount": 0.01,
  "currency": "USDC",
  "correlation_id": "req_8432",
  "diagnostic": {
    "code": "PAYMENT_ATTEMPTS_EXCEEDED",
    "attempts": 8432,
    "firstAttempt": "2026-03-10T00:00:00Z",
    "escalate": true
  },
  "timestamp": "2026-03-29T00:00:00Z"
}
```

The `correlation_id` field ties the escalation event back to the specific request chain, making it actionable for the operator rather than just informational.

### Graceful degradation

Clients that do not implement diagnostic parsing MUST continue to function correctly — the `extensions` field is ignored by clients that do not recognise it. The extension is purely additive.

---

## Server Implementation

### When to emit diagnostics

Servers MAY emit the `diagnostic` extension on any 402 response. Recommended thresholds:

- Emit `PAYMENT_REQUIRED` (or no diagnostic) for first requests and early retries
- Emit `INVOICE_EXPIRED` when a payment attempt is detected but invoice has passed its validity window
- Emit `PAYMENT_UNVERIFIED` when `X-PAYMENT` is present but signature verification fails
- Emit `PAYMENT_ATTEMPTS_EXCEEDED` after a configurable threshold of failed attempts (suggested: 100+ attempts with no successful payment). Servers SHOULD increase the urgency of the `message` field as attempts grow — e.g. note the duration as well as the count. Servers SHOULD NOT emit this code on first contact or early retries; a threshold prevents false positives from clients that legitimately retry a small number of times.

### Attempt tracking thresholds (suggested)

| Attempts | Recommended code | `escalate` |
|----------|-----------------|-----------|
| 1–9 | No diagnostic (or `PAYMENT_REQUIRED`) | false |
| 10–99 | No diagnostic | false |
| 100–999 | `PAYMENT_ATTEMPTS_EXCEEDED` | true |
| 1000+ | `PAYMENT_ATTEMPTS_EXCEEDED` | true |

These are suggestions only. Servers MAY use lower thresholds for high-value endpoints or higher thresholds for high-volume low-cost endpoints.
- Emit `WALLET_INSUFFICIENT_FUNDS` when the facilitator returns `insufficient_funds`
- Emit `OPERATOR_ALERT` at server discretion for other persistent failure patterns

### Attempt tracking

Servers that implement `PAYMENT_ATTEMPTS_EXCEEDED` SHOULD track attempts per client identifier. Recommended identifiers (in order of preference):

1. `payer` address from the `X-PAYMENT` header (most precise — ties to a specific wallet)
2. IP address (fallback — less precise, subject to spoofing)

Servers SHOULD NOT penalise clients for `insufficient_funds` responses — these indicate an empty wallet, not a bad actor. The `WALLET_INSUFFICIENT_FUNDS` code communicates this state without implying malicious intent.

### Security considerations

**Information disclosure:** The `attempts` and `firstAttempt` fields reveal server-side tracking state. Servers SHOULD only emit these fields for clients that have already made multiple requests — do not reveal tracking state on first contact.

**Privacy:** Servers SHOULD NOT include personally identifiable information in `message` or `suggestion` fields. These fields are machine-readable and may be logged by client SDKs.

**Spoofing:** The diagnostic extension is advisory only. Clients MUST NOT use diagnostic codes to make security-critical decisions. A malicious server could emit misleading codes; clients should treat diagnostics as operational hints, not authoritative signals.

---

## Out-of-Band Operator Contact (Future Extension)

This extension solves in-band signaling — the server tells the client what is wrong. A complementary problem remains: when the client runtime is too broken to read the diagnostic, there is no protocol mechanism for the server to reach the human operator directly.

A future extension could define a standard `X-Operator-Contact` or `X-Operator-Webhook` header that clients include in payment requests, providing the server with a direct escalation channel. This is intentionally out of scope for this extension to keep the initial surface area minimal. Privacy implications (exposing operator webhooks to every server an agent pays) require careful design and a separate discussion.

---

## Backward Compatibility

This extension is fully backward compatible:

- The `extensions` field is optional in x402 v2 responses
- Existing clients that do not parse `extensions.diagnostic` continue to function unchanged
- Servers can implement the extension incrementally — emitting diagnostics for some failure patterns before others
- No changes to the payment flow, headers, or settlement process

---

## Reference Implementation

### Server (Python — x402_proxy.py pattern)

```python
from collections import defaultdict
from datetime import datetime, timezone

_attempt_counts = defaultdict(int)
_first_attempt = {}

def get_diagnostic(payer_address: str, failure_reason: str) -> dict | None:
    key = payer_address or "unknown"
    _attempt_counts[key] += 1
    if key not in _first_attempt:
        _first_attempt[key] = datetime.now(timezone.utc).isoformat()

    attempts = _attempt_counts[key]

    if failure_reason == "insufficient_funds":
        return {
            "code": "WALLET_INSUFFICIENT_FUNDS",
            "message": "Wallet balance too low to cover payment.",
            "attempts": attempts,
            "firstAttempt": _first_attempt[key],
            "suggestion": "Top up your wallet and retry.",
            "escalate": True
        }
    elif failure_reason == "signature_invalid":
        return {
            "code": "PAYMENT_UNVERIFIED",
            "message": "Payment signature verification failed.",
            "attempts": attempts,
            "firstAttempt": _first_attempt[key],
            "suggestion": "Check payment signing configuration.",
            "escalate": True
        }
    elif attempts >= 100:
        return {
            "code": "PAYMENT_ATTEMPTS_EXCEEDED",
            "message": f"{attempts} requests received with no valid payment since {_first_attempt[key]}.",
            "attempts": attempts,
            "firstAttempt": _first_attempt[key],
            "suggestion": "Check payment handler configuration and wallet balance.",
            "escalate": True
        }
    
    return None  # No diagnostic for early retries


def build_402_response(payer_address: str = None, failure_reason: str = None) -> dict:
    response = {
        "x402Version": 2,
        "error": "Payment required",
        "accepts": ["x402"],
        # ... payment requirements ...
    }
    
    diagnostic = get_diagnostic(payer_address, failure_reason)
    if diagnostic:
        response["extensions"] = {
            "diagnostic": {
                "info": diagnostic,
                "schema": "https://raw.githubusercontent.com/coinbase/x402/main/specs/extensions/diagnostic.schema.json"
            }
        }
    
    return response
```

### Client (TypeScript — SDK integration pattern)

```typescript
interface DiagnosticInfo {
  code: 'PAYMENT_REQUIRED' | 'INVOICE_EXPIRED' | 'PAYMENT_UNVERIFIED' |
        'PAYMENT_ATTEMPTS_EXCEEDED' | 'WALLET_INSUFFICIENT_FUNDS' | 'OPERATOR_ALERT';
  message?: string;
  attempts?: number;
  firstAttempt?: string;
  suggestion?: string;
  escalate?: boolean;
}

async function handle402Response(
  response: Response,
  correlationId: string,
  onEscalate: (event: object) => void
): Promise<'retry' | 'halt'> {
  const body = await response.json();
  const diagnostic: DiagnosticInfo | undefined =
    body?.extensions?.diagnostic?.info;

  if (!diagnostic) {
    // No diagnostic — proceed with normal payment flow
    return 'retry';
  }

  if (diagnostic.escalate) {
    onEscalate({
      type: 'x402_escalation',
      endpoint: body?.resource?.url,
      correlation_id: correlationId,
      diagnostic,
      timestamp: new Date().toISOString(),
    });
    return 'halt';
  }

  switch (diagnostic.code) {
    case 'PAYMENT_REQUIRED':
      return 'retry';
    case 'INVOICE_EXPIRED':
      // Request fresh invoice and retry once
      return 'retry';
    case 'PAYMENT_UNVERIFIED':
    case 'PAYMENT_ATTEMPTS_EXCEEDED':
    case 'WALLET_INSUFFICIENT_FUNDS':
    case 'OPERATOR_ALERT':
      return 'halt';
    default:
      return 'retry';
  }
}
```

---

## Acknowledgements

This extension was developed from production experience operating a pay-per-query oracle (myceliasignal.com) and refined through discussion in issue #1860. Thanks to @0xAxiom for filing the first spec PR (#1866) which demonstrated the extension format and provided a strong implementation foundation; to @hermesnousagent for the receipt trail and `correlation_id` additions; and to @up2itnow0822 (agentwallet-sdk) for the code-to-behavior mapping that informed the client implementation guidance.
