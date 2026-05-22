# Extension: `risk-check`

## Summary

The `risk-check` extension enables **counterparty risk verification** for x402-protected resources. Resource servers declare a minimum risk score requirement and an optional risk-check provider URL. Facilitators call the provider during verification or settlement and include the signed risk attestation in their response. Servers can then enforce score thresholds before serving resources.

This extension is **provider-agnostic**. Any service implementing the `/.well-known/risk-check.json` discovery endpoint qualifies as a risk-check provider. The extension defines the interface, not the scoring methodology.

---

## Motivation

x402 batch settlement (May 2026) made sub-cent micropayments economically rational. At sub-cent transaction values, a 5-cent counterparty risk check destroys unit economics if performed per-transaction. By integrating risk verification into the facilitator's settlement flow, a single risk check can be amortized across thousands of batched voucher redemptions.

Without this extension, risk verification is an aftermarket bolt-on that each resource server must implement independently. With it, verification becomes a protocol-level primitive that facilitators can bundle into the same transaction flow.

---

## Discovery

Risk-check providers publish a discovery document at `/.well-known/risk-check.json`:

```json
{
  "name": "Example Risk Provider",
  "version": "0.1.0",
  "description": "Counterparty risk scoring for x402 agent commerce",
  "endpoint": "/v1/score",
  "method": "POST",
  "pricing": {
    "amount": "10000",
    "currency": "USDC",
    "protocol": "x402",
    "network": "eip155:8453"
  },
  "signals": ["wallet", "domain", "ip", "sanctions"],
  "chains_supported": ["base", "ethereum"],
  "response_time_ms": "<3000",
  "attestation": {
    "jwks_url": "https://provider.example/.well-known/jwks.json",
    "algorithm": "ES256",
    "kid": "provider-attest-v1",
    "ttl": "1h"
  }
}
```

Facilitators SHOULD cache discovery documents with a TTL of no more than 24 hours.

---

## `PaymentRequired`

A resource server advertises risk-check support by including the `risk-check` key in the `extensions` object of the **402 Payment Required** response.

### Example

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/sensitive-data",
    "description": "High-value data endpoint",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ],
  "extensions": {
    "risk-check": {
      "info": {
        "required": false,
        "risk_check_url": "https://provider.example/.well-known/risk-check.json",
        "min_score": 60,
        "categories": ["compliance_risk"]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "required": {
            "type": "boolean",
            "description": "Whether the server requires a risk check to proceed"
          },
          "risk_check_url": {
            "type": "string",
            "format": "uri",
            "description": "URL to the risk-check provider's discovery document"
          },
          "min_score": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100,
            "description": "Minimum acceptable risk score (0 = highest risk, 100 = safest)"
          },
          "categories": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Required attestation categories (e.g., compliance_risk, behavioral, identity)"
          }
        },
        "required": ["required"]
      }
    }
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `required` | `boolean` | Yes | Whether the server requires a passing risk check to serve the resource |
| `risk_check_url` | `string` (URI) | No | URL to the provider's `/.well-known/risk-check.json` discovery document. If omitted, the facilitator may use any registered provider. |
| `min_score` | `integer` | No | Minimum acceptable score (0-100). Default: `0` (any score accepted). |
| `categories` | `string[]` | No | Attestation categories the server requires. Maps to the [Composable Trust Evidence Format](https://github.com/agentgraph-co/agentgraph/discussions/1734) taxonomy. |

---

## `PaymentPayload`

The client echoes the extension and may append provider preferences:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/sensitive-data" },
  "accepted": { "..." },
  "payload": { "..." },
  "extensions": {
    "risk-check": {
      "info": {
        "required": false,
        "risk_check_url": "https://provider.example/.well-known/risk-check.json",
        "min_score": 60,
        "categories": ["compliance_risk"],
        "payer_wallet": "0xabc123...",
        "payer_domain": "agent.example.com"
      },
      "schema": { "..." }
    }
  }
}
```

The client MAY append `payer_wallet` and `payer_domain` to the `info` object to provide additional context for the risk-check provider. Per the x402 v2 extension rules, clients can append but cannot delete or overwrite existing info.

### Additional Client Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payer_wallet` | `string` | No | The payer's wallet address for risk scoring |
| `payer_domain` | `string` | No | The payer's domain for domain-level risk signals |

---

## `VerifyResponse`

When a facilitator performs a risk check during verification, it includes the result in the `extensions` field of `VerifyResponse`:

```json
{
  "isValid": true,
  "payer": "0xabc123...",
  "extensions": {
    "risk-check": {
      "checked": true,
      "score": 87,
      "tier": "low",
      "provider": "did:web:provider.example",
      "categories": ["compliance_risk"],
      "checked_at": "2026-05-21T14:00:00Z",
      "expires_at": "2026-05-21T15:00:00Z"
    }
  }
}
```

If the facilitator does not perform a risk check (e.g., the extension is not required and the facilitator does not support it), the `risk-check` key is omitted from `extensions`.

---

## `SettleResponse`

After settlement, the facilitator includes the full risk attestation with a verifiable JWS:

```json
{
  "success": true,
  "payer": "0xabc123...",
  "transaction": "0xdef456...",
  "network": "eip155:8453",
  "extensions": {
    "risk-check": {
      "checked": true,
      "score": 87,
      "tier": "low",
      "provider": "did:web:provider.example",
      "categories": ["compliance_risk"],
      "jws": "eyJhbGciOiJFUzI1NiIsInR5cCI6InJpc2stY2hlY2srand0Iiwia2lkIjoicHJvdmlkZXItYXR0ZXN0LXYxIn0.eyJpc3MiOiJkaWQ6d2ViOnByb3ZpZGVyLmV4YW1wbGUiLCJzdWIiOiIweGFiYzEyMyIsInNjb3JlIjo4NywidGllciI6Imxvd...",
      "jwks_url": "https://provider.example/.well-known/jwks.json",
      "checked_at": "2026-05-21T14:00:00Z",
      "expires_at": "2026-05-21T15:00:00Z"
    }
  }
}
```

### Result Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `checked` | `boolean` | Yes | Whether a risk check was performed |
| `score` | `integer` | If checked | Risk score 0-100 (0 = highest risk, 100 = safest) |
| `tier` | `string` | If checked | Risk tier: `"low"` (80-100), `"medium"` (60-79), `"high"` (30-59), `"critical"` (0-29) |
| `provider` | `string` | If checked | Provider DID (e.g., `did:web:provider.example`) |
| `categories` | `string[]` | If checked | Categories covered by this attestation |
| `jws` | `string` | No | Compact JWS (RFC 7515) signed attestation, verifiable against `jwks_url` |
| `jwks_url` | `string` (URI) | If `jws` present | URL to the provider's JWKS endpoint for signature verification |
| `checked_at` | `string` (ISO 8601) | If checked | Timestamp when the risk check was performed |
| `expires_at` | `string` (ISO 8601) | If checked | Expiry timestamp for the attestation (typically 1 hour) |

---

## Facilitator Behavior

Facilitators that support the `risk-check` extension SHOULD:

1. **Read** the `risk-check` extension from the `PaymentRequired` and `PaymentPayload`.
2. **Fetch** the provider's discovery document from `risk_check_url` (cache with ≤24h TTL).
3. **Call** the provider's scoring endpoint with the payer's wallet address (and optionally domain/IP).
4. **Include** the result in `VerifyResponse.extensions["risk-check"]` and `SettleResponse.extensions["risk-check"]`.
5. **Reject** verification if `required` is `true` and the score is below `min_score`, returning `isValid: false` with `invalidReason: "risk-check-failed"`.

Facilitators MAY choose to:
- Cache risk-check results per payer wallet (respecting `expires_at`)
- Amortize a single risk check across multiple batched voucher settlements for the same payer
- Support multiple risk-check providers and select based on `categories`

Facilitators that do not support the extension MUST ignore it and proceed with normal verification/settlement. The extension is always optional at the facilitator level.

---

## Server Enforcement

When `required` is `true`, the resource server SHOULD check `SettleResponse.extensions["risk-check"]` after receiving a successful settlement:

1. If `checked` is `false` or the `risk-check` key is absent, the server MAY reject the request (the facilitator did not support the extension).
2. If `score` is below `min_score`, the server SHOULD reject the request with an appropriate error.
3. If `jws` is present, the server MAY verify the signature against `jwks_url` for independent attestation verification.

When `required` is `false`, the risk-check result is informational. The server MAY use the score for logging, analytics, or adaptive behavior without blocking the request.

---

## Security Considerations

- **JWS Verification**: Servers SHOULD verify the `jws` attestation against the provider's published JWKS rather than trusting the facilitator alone. This prevents a compromised facilitator from fabricating risk scores.
- **TTL Enforcement**: Attestations include `expires_at`. Servers and facilitators MUST NOT cache or reuse attestations beyond their expiry.
- **Provider Trust**: The extension does not establish trust in the risk-check provider itself. Servers choose which providers to accept via `risk_check_url`. Facilitators MAY maintain an allowlist of trusted providers.
- **Privacy**: The payer's wallet address is sent to the risk-check provider. Providers SHOULD NOT store or share this data beyond what is needed for scoring. The extension does not define a data retention policy; providers publish their own.
- **Availability**: If the risk-check provider is unavailable and `required` is `true`, the facilitator SHOULD return `isValid: false` with `invalidReason: "risk-check-unavailable"` rather than silently proceeding.

---

## Reference Implementation

- **Provider**: [Revettr](https://revettr.com) — counterparty risk scoring for x402 agent commerce
  - Discovery: `https://revettr.com/.well-known/risk-check.json`
  - JWKS: `https://revettr.com/.well-known/jwks.json`
  - Scoring: `POST https://revettr.com/v1/score`
  - Attestation: `POST https://revettr.com/v1/attest` (free tier)
  - SDK: `pip install revettr` ([PyPI](https://pypi.org/project/revettr/))

---

## Related Specifications

- [x402 Specification v2](../x402-specification-v2.md) — Core protocol
- [Composable Trust Evidence Format (A2A RFC #1734)](https://github.com/agentgraph-co/agentgraph/discussions/1734) — Attestation taxonomy
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) — Agent identity and validation registry
- [RFC 7515](https://datatracker.ietf.org/doc/html/rfc7515) — JSON Web Signature
- [RFC 7517](https://datatracker.ietf.org/doc/html/rfc7517) — JSON Web Key Set
