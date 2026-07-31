# Extension: `discovery`

## Summary

The `discovery` extension defines the protocol version declaration and manifest specification for x402 resource discovery across standalone descriptors (`/.well-known/x402`) and OpenAPI extensions (`x-x402`).

---

## 1. Field Requirements: `x402Version` & `x402Versions`

To eliminate silent protocol mismatch failures between buyers and sellers, all discovery descriptors MUST declare their supported protocol versions explicitly.

| Field | Type | Requirement | Description |
|---|---|---|---|
| `x402Version` | `integer` | **Required** | Primary supported x402 protocol version (e.g., `2` or `1`). Must be an integer. |
| `x402Versions` | `array` of `integer` | Optional | List of all supported protocol versions when a host serves multi-version endpoints (e.g., `[1, 2]`). |

### Rules & Validation Requirements
1. **Strict Type Enforcement:** `x402Version` MUST be typed as an `integer`. String representations (e.g., `"1"` or `"2"`) or floating-point numbers are invalid.
2. **Mandatory Declaration:** Discovery indexers, aggregators (e.g. CDP Bazaar, x402scan), and client SDKs MUST reject or flag descriptors omitting `x402Version`.
3. **Multi-Version Expressibility:** When `x402Versions` is present, it MUST be a non-empty array of unique integers.

---

## 2. Descriptor Formats & Examples

### A. Standalone Manifest Descriptor (`/.well-known/x402`)

```json
{
  "x402Version": 2,
  "x402Versions": [1, 2],
  "name": "Example Weather API",
  "description": "Live weather endpoint supporting x402 v1 and v2 protocol challenges.",
  "resources": [
    {
      "url": "https://api.example.com/weather",
      "mimeType": "application/json",
      "accepts": [
        {
          "scheme": "exact",
          "asset": "USDC",
          "network": "base",
          "amount": "1000"
        }
      ]
    }
  ]
}
```

### B. OpenAPI Specification Extension (`x-x402`)

```yaml
openapi: 3.1.0
info:
  title: Example Paid Weather API
  version: 1.0.0
  x-x402:
    x402Version: 2
    x402Versions: [1, 2]
paths:
  /weather:
    get:
      summary: Weather forecast endpoint
      responses:
        '402':
          description: Payment required via x402 v2 protocol
```

---

## 3. Client Negotiation & Fallback Behavior

When a client fetches a discovery descriptor:

1. **Version Inspection:** The client inspects `x402Version` (and `x402Versions` if present) before initiating paid requests.
2. **v2 Wire Protocol:** If `x402Version: 2`, the client expects the 402 challenge in the base64 `PAYMENT-REQUIRED` header.
3. **v1 Fallback:** If `x402Version: 1`, a v2-capable client falls back to reading the 402 challenge from the response body, preventing silent challenge drops.
4. **Mismatch Handling:** If the client supports neither `x402Version` nor any entry in `x402Versions`, it MUST abort with an explicit `unsupported_protocol_version` error rather than attempting un-challengeable fetches.

---

## 4. Registry & Validator Conformance

Discovery registries and catalog indexers MUST validate descriptors against the JSON Schema below:

* **Missing Version:** If `x402Version` is absent, set status to `invalid_manifest` with reason `missing_x402Version`.
* **Invalid Type:** If `x402Version` is a string (e.g. `"2"`), set status to `invalid_manifest` with reason `invalid_x402Version_type`.

---

## 5. JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "x402 Discovery Descriptor Schema",
  "type": "object",
  "required": ["x402Version"],
  "properties": {
    "x402Version": {
      "type": "integer",
      "minimum": 1,
      "description": "Primary supported x402 protocol version (must be integer)."
    },
    "x402Versions": {
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 1
      },
      "uniqueItems": true,
      "description": "List of supported x402 protocol versions for multi-version hosts."
    }
  }
}
```
