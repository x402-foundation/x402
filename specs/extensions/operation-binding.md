# Extension: `operation-binding`

## Summary

The `operation-binding` extension defines a companion proof that binds a successful x402 payment to one exact validated operation.

In the first version of this extension, the bound operation is an HTTP request whose validated inputs are representable as JSON per RFC 8785.

This extension is intentionally separate from:

- `offer-and-receipt`, which proves what the resource server offered and that it returned a successful response
- facilitator-side settlement attestations such as the proposal in [#1802](https://github.com/x402-foundation/x402/issues/1802), which prove how a payment was settled

The goal here is narrower:

> prove that payment was accepted for this exact validated operation, not just for this route or this settlement transaction.

---

## Goals

- Bind a signed receipt to one exact validated HTTP operation.
- Make the binding deterministic across SDKs and frameworks.
- Define a strict and reproducible `operationDigest`.
- Compose cleanly with `offer-and-receipt` and facilitator settlement attestations.
- Leave room for future tooling such as OpenAPI-generated paid proxies.

## Non-Goals

- Replacing `offer-and-receipt`.
- Replacing facilitator-side settlement proofs or the attestation direction discussed in [#1802](https://github.com/x402-foundation/x402/issues/1802).
- Defining client-side budget allocation or wallet policy.
- Defining persistent Sign-In-With-X storage or proofs.
- Covering binary, multipart, streaming, or non-JSON request bodies in version `1`.
- Defining MCP operation binding in version `1`.

---

## Threat Model

This extension is designed to reduce the following classes of error or abuse:

- **Cross-operation replay**: a receipt for one validated operation is presented as proof for a different operation.
- **Parameter substitution**: a receipt for `/users/123` is reused for `/users/456`, or a receipt for `amount=1` is reused for `amount=100`.
- **Canonicalization drift**: two implementations hash logically identical requests differently because they disagree about ordering, whitespace, or omission rules.
- **Ambiguous retry semantics**: repeated payment submissions for the same idempotency key drift to different bound operations.

This extension does **not** by itself prove settlement details such as fee, amount transferred on-chain, or transaction inclusion. Those concerns belong to the payment scheme itself, `offer-and-receipt`, or a facilitator-side settlement attestation.

---

## Scope and Status

This is a companion extension proposal.

- The first version covers only `transport = "http"`.
- The first version covers only operations whose bound inputs can be represented as I-JSON and canonicalized with RFC 8785.
- The first version defines a resource-server-signed operation receipt.

Servers SHOULD treat this extension as opt-in per route.

---

## `PaymentRequired`

A resource server advertises operation binding support by including the `operation-binding` extension in the `extensions` object of the `402 Payment Required` response.

The extension follows the standard v2 pattern:

- `info`: binding policy for this request
- `schema`: JSON Schema for `info`

### `info` Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `transport` | string | Yes | Currently MUST be `"http"` |
| `resourceUrl` | string | Yes | Absolute resource URL for this request, without query string or fragment |
| `method` | string | Yes | Uppercase HTTP method |
| `pathTemplate` | string | Yes | Canonical route template using `:param` syntax |
| `operationId` | string | Yes | Stable server-defined operation identifier |
| `policyVersion` | string | Yes | Stable version string for the binding policy and validated input contract |
| `canonicalization` | string | Yes | Currently MUST be `"rfc8785-jcs"` |
| `digestAlgorithm` | string | Yes | Currently MUST be `"sha-256"` |
| `bindPathParams` | boolean | Yes | Whether validated path params participate in the digest |
| `bindQuery` | boolean | Yes | Whether validated query params participate in the digest |
| `bindBody` | boolean | Yes | Whether the validated body participates in the digest |

### Requirements

- `resourceUrl` MUST be the absolute request URL without query string or fragment.
- `method` MUST be uppercase.
- `pathTemplate` MUST use the same `:param` syntax described for `routeTemplate` in the `bazaar` extension.
- `operationId` MUST be stable for the semantic operation being paid for.
- `policyVersion` MUST change when the server changes validated input semantics in a way that would change the meaning of existing receipts.
- Servers MUST NOT advertise `bindBody: true` unless the validated body can be represented as I-JSON.

### Example

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/weather/SF",
    "description": "Weather lookup",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60
    }
  ],
  "extensions": {
    "operation-binding": {
      "info": {
        "transport": "http",
        "resourceUrl": "https://api.example.com/weather/SF",
        "method": "GET",
        "pathTemplate": "/weather/:city",
        "operationId": "weather.getCurrent",
        "policyVersion": "2026-04-04",
        "canonicalization": "rfc8785-jcs",
        "digestAlgorithm": "sha-256",
        "bindPathParams": true,
        "bindQuery": true,
        "bindBody": false
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "transport": { "type": "string", "const": "http" },
          "resourceUrl": { "type": "string", "format": "uri" },
          "method": { "type": "string" },
          "pathTemplate": { "type": "string" },
          "operationId": { "type": "string" },
          "policyVersion": { "type": "string" },
          "canonicalization": { "type": "string", "const": "rfc8785-jcs" },
          "digestAlgorithm": { "type": "string", "const": "sha-256" },
          "bindPathParams": { "type": "boolean" },
          "bindQuery": { "type": "boolean" },
          "bindBody": { "type": "boolean" }
        },
        "required": [
          "transport",
          "resourceUrl",
          "method",
          "pathTemplate",
          "operationId",
          "policyVersion",
          "canonicalization",
          "digestAlgorithm",
          "bindPathParams",
          "bindQuery",
          "bindBody"
        ],
        "additionalProperties": false
      }
    }
  }
}
```

---

## `PaymentPayload`

Clients SHOULD echo the `operation-binding` extension from `PaymentRequired` into the `PaymentPayload` unchanged.

Servers MAY reject the payment with `400` or `409` if the echoed extension differs from what the server advertised for that request.

This echo step is not the source of truth for the digest. The source of truth is always the server's own validated request state at execution time.

---

## Exact `operationDigest` Inputs

After request validation, coercion, and default application, the server MUST construct the following logical input object:

```json
{
  "version": 1,
  "transport": "http",
  "resourceUrl": "https://api.example.com/weather/SF",
  "method": "GET",
  "pathTemplate": "/weather/:city",
  "operationId": "weather.getCurrent",
  "policyVersion": "2026-04-04",
  "pathParams": {
    "city": "SF"
  },
  "query": {
    "units": "metric"
  },
  "body": null
}
```

### Field Semantics

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | number | Yes | MUST be `1` |
| `transport` | string | Yes | MUST be `"http"` |
| `resourceUrl` | string | Yes | Absolute request URL without query string or fragment |
| `method` | string | Yes | Uppercase HTTP method |
| `pathTemplate` | string | Yes | Canonical route template using `:param` syntax |
| `operationId` | string | Yes | Stable operation identifier |
| `policyVersion` | string | Yes | Server-defined policy version |
| `pathParams` | object or `null` | Yes | Validated path params if `bindPathParams = true`, otherwise `null` |
| `query` | object or `null` | Yes | Validated query object if `bindQuery = true`, otherwise `null` |
| `body` | any JSON value or `null` | Yes | Validated body if `bindBody = true`, otherwise `null` |

### Input Rules

- The server MUST compute the logical input object from the validated request representation, not from raw bytes.
- `pathParams` and `query` MUST be JSON objects when present.
- `body` MAY be any JSON value when present, including an object, array, string, number, boolean, or `null`.
- If a component is not bound, the server MUST set the corresponding field to `null` even if the raw request contained that component.
- If a component is bound but absent after validation, the server MUST set the corresponding field to `null`.
- Fragment identifiers MUST NOT be included.
- Query parameters MUST be represented only through the validated `query` field, never inside `resourceUrl`.
- If a validated value is not representable as I-JSON, the server MUST NOT use this extension for that request.

---

## Exact Canonicalization Rules

Servers and verifiers MUST compute `operationDigest` as follows:

1. Construct the logical input object defined above.
2. Serialize that object using the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) JSON Canonicalization Scheme.
3. Encode the canonical JSON string as UTF-8 bytes.
4. Compute SHA-256 over those bytes.
5. Encode the resulting digest as lowercase hex without separators.

### Normative Requirements

- Implementations MUST use RFC 8785 exactly, not a "JCS-like" variant.
- Implementations MUST NOT preserve input whitespace, object insertion order, or source formatting.
- Implementations MUST use the validated JSON representation after schema coercion and defaulting.
- Implementations MUST NOT normalize Unicode beyond what RFC 8785 requires.
- Implementations MUST reject duplicate object member names before canonicalization.
- Implementations MUST use lowercase hex for the final digest string.

### Reference Formula

```text
operationDigest = hex(sha256(utf8(rfc8785(logicalInputObject))))
```

---

## Operation Receipt

On success, the server MAY include a signed operation receipt in the `SettlementResponse`.

### Placement

The receipt is returned at:

```text
extensions["operation-binding"].info.receipt
```

### Signed Envelope

This extension reuses the same signed envelope structure as `offer-and-receipt`:

- `format`
- `payload` for EIP-712
- `signature`

Supported formats are:

- `eip712`
- `jws`

Signer authorization follows the same model as `offer-and-receipt`: the verifier MUST confirm that the signer is authorized to act for the service identified by `resourceUrl`.

### Receipt Payload Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | number | Yes | Receipt payload schema version, currently `1` |
| `network` | string | Yes | CAIP-2 network identifier for the payment |
| `transport` | string | Yes | Currently `"http"` |
| `resourceUrl` | string | Yes | Absolute request URL without query string or fragment |
| `method` | string | Yes | Uppercase HTTP method |
| `pathTemplate` | string | Yes | Canonical route template using `:param` syntax |
| `operationId` | string | Yes | Stable operation identifier |
| `policyVersion` | string | Yes | Server-defined policy version |
| `canonicalization` | string | Yes | Currently `"rfc8785-jcs"` |
| `digestAlgorithm` | string | Yes | Currently `"sha-256"` |
| `bindPathParams` | boolean | Yes | Whether path params were bound |
| `bindQuery` | boolean | Yes | Whether query params were bound |
| `bindBody` | boolean | Yes | Whether body was bound |
| `operationDigest` | string | Yes | Lowercase hex digest of the canonicalized logical input object |
| `payer` | string | Yes | Payer identifier |
| `issuedAt` | number | Yes | Unix timestamp in seconds |

### EIP-712 Domain

All EIP-712 signatures in this extension use:

```javascript
{
  name: "x402 operation receipt",
  version: "1",
  chainId: 1
}
```

### EIP-712 Types

```javascript
{
  "primaryType": "OperationReceipt",
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" }
    ],
    "OperationReceipt": [
      { "name": "version", "type": "uint256" },
      { "name": "network", "type": "string" },
      { "name": "transport", "type": "string" },
      { "name": "resourceUrl", "type": "string" },
      { "name": "method", "type": "string" },
      { "name": "pathTemplate", "type": "string" },
      { "name": "operationId", "type": "string" },
      { "name": "policyVersion", "type": "string" },
      { "name": "canonicalization", "type": "string" },
      { "name": "digestAlgorithm", "type": "string" },
      { "name": "bindPathParams", "type": "bool" },
      { "name": "bindQuery", "type": "bool" },
      { "name": "bindBody", "type": "bool" },
      { "name": "operationDigest", "type": "string" },
      { "name": "payer", "type": "string" },
      { "name": "issuedAt", "type": "uint256" }
    ]
  }
}
```

### Example Receipt

```json
{
  "format": "eip712",
  "payload": {
    "version": 1,
    "network": "eip155:8453",
    "transport": "http",
    "resourceUrl": "https://api.example.com/weather/SF",
    "method": "GET",
    "pathTemplate": "/weather/:city",
    "operationId": "weather.getCurrent",
    "policyVersion": "2026-04-04",
    "canonicalization": "rfc8785-jcs",
    "digestAlgorithm": "sha-256",
    "bindPathParams": true,
    "bindQuery": true,
    "bindBody": false,
    "operationDigest": "8db6ee2cc9d1f19dbf9d502f92c0edcf3f48c8a7f8fd5378d8cebd1d7955db6b",
    "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    "issuedAt": 1775289900
  },
  "signature": "0x1234567890abcdef..."
}
```

---

## Verifier Behavior

### Within the x402 Request Lifecycle

When a client or downstream component verifies an operation receipt for a request it observed directly, it SHOULD:

1. Verify the signed envelope using the rules for the selected format.
2. Confirm that the signer is authorized for `resourceUrl`.
3. Confirm that `canonicalization` and `digestAlgorithm` are supported.
4. Reconstruct the logical input object from the validated request state using the receipt payload fields.
5. Recompute `operationDigest`.
6. Compare the recomputed digest to the signed `operationDigest`.
7. Confirm `issuedAt` is within verifier policy.

Verification MUST fail if:

- the signature is invalid
- the signer is not authorized
- canonicalization rules differ from this specification
- the recomputed digest does not match

### Outside the x402 Request Lifecycle

An external verifier that does not possess the validated request inputs MAY still verify:

- the receipt signature
- signer authorization
- receipt metadata

However, it cannot fully verify the `operationDigest` binding unless it also has the exact validated inputs required to reconstruct the logical input object.

---

## Interaction with `payment-identifier`

`operation-binding` and `payment-identifier` solve different problems:

- `payment-identifier` provides idempotency and retry safety
- `operation-binding` provides semantic proof of what the payment authorized

When both extensions are present:

- clients SHOULD reuse the same `payment-identifier` when retrying the same operation
- servers SHOULD cache or reproduce the same operation receipt for retries that produce the same `payment-identifier` and the same `operationDigest`
- servers SHOULD reject reuse of the same `payment-identifier` with a different `operationDigest`

This means the pair `("payment-identifier".id, operationDigest)` becomes the practical idempotency contract for bound operations.

This extension does not require `payment-identifier`, but deployments that care about safe retries SHOULD use both together.

---

## Composition with `offer-and-receipt` and `#1802`

This extension is intended to compose with, not replace, adjacent receipt work:

- `offer-and-receipt` proves what the resource server offered and that it returned a successful response
- `operation-binding` proves which validated operation that successful response corresponds to
- facilitator-side attestation work such as [#1802](https://github.com/x402-foundation/x402/issues/1802) proves settlement details such as transaction hash, amount, and fee

These are distinct layers:

| Layer | Signed by | Main question answered |
| --- | --- | --- |
| `offer-and-receipt` | Resource server | "What was offered, and did the server declare success?" |
| `operation-binding` | Resource server | "What exact validated operation did that success correspond to?" |
| Facilitator attestation (`#1802`) | Facilitator | "How was the payment settled?" |

An implementation MAY include both `operation-binding` and a facilitator-side settlement attestation in the same success response.

Future work MAY define a higher-level composed business receipt, but that is out of scope for this extension.

---

## HTTP Examples

### Example A: `GET /weather/:city`

#### Request

```http
GET /weather/SF?units=metric HTTP/1.1
Host: api.example.com
X-PAYMENT: <omitted>
```

#### Validated Request State

```json
{
  "pathParams": {
    "city": "SF"
  },
  "query": {
    "units": "metric"
  },
  "body": null
}
```

#### Logical Input Object

```json
{
  "version": 1,
  "transport": "http",
  "resourceUrl": "https://api.example.com/weather/SF",
  "method": "GET",
  "pathTemplate": "/weather/:city",
  "operationId": "weather.getCurrent",
  "policyVersion": "2026-04-04",
  "pathParams": {
    "city": "SF"
  },
  "query": {
    "units": "metric"
  },
  "body": null
}
```

#### Success Response

```json
{
  "success": true,
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extensions": {
    "operation-binding": {
      "info": {
        "receipt": {
          "format": "eip712",
          "payload": {
            "version": 1,
            "network": "eip155:8453",
            "transport": "http",
            "resourceUrl": "https://api.example.com/weather/SF",
            "method": "GET",
            "pathTemplate": "/weather/:city",
            "operationId": "weather.getCurrent",
            "policyVersion": "2026-04-04",
            "canonicalization": "rfc8785-jcs",
            "digestAlgorithm": "sha-256",
            "bindPathParams": true,
            "bindQuery": true,
            "bindBody": false,
            "operationDigest": "8db6ee2cc9d1f19dbf9d502f92c0edcf3f48c8a7f8fd5378d8cebd1d7955db6b",
            "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
            "issuedAt": 1775289900
          },
          "signature": "0x1234567890abcdef..."
        }
      }
    }
  }
}
```

### Example B: `POST /search`

#### Request

```http
POST /search HTTP/1.1
Host: api.example.com
Content-Type: application/json

{"query":"x402","limit":10}
```

#### Validated Request State

```json
{
  "pathParams": null,
  "query": null,
  "body": {
    "query": "x402",
    "limit": 10
  }
}
```

#### Logical Input Object

```json
{
  "version": 1,
  "transport": "http",
  "resourceUrl": "https://api.example.com/search",
  "method": "POST",
  "pathTemplate": "/search",
  "operationId": "search.run",
  "policyVersion": "2026-04-04",
  "pathParams": null,
  "query": null,
  "body": {
    "query": "x402",
    "limit": 10
  }
}
```

---

## Security Considerations

- Servers MUST compute the digest after validation, not from raw request bytes.
- Servers MUST use exact RFC 8785 canonicalization.
- Servers MUST ensure `operationId`, `pathTemplate`, and `policyVersion` are stable and not attacker-controlled.
- Servers SHOULD use short-lived payment requirements when operation semantics are time-sensitive.
- Servers SHOULD combine this extension with `payment-identifier` for retry safety.
- Servers MUST NOT advertise this extension for request bodies they cannot canonicalize reproducibly.

---

## Privacy Considerations

- `operationDigest` is a one-way hash of validated request inputs, but the receipt still reveals route-level metadata such as `resourceUrl`, `pathTemplate`, and `operationId`.
- Deployments SHOULD avoid putting sensitive secrets into bound query or body fields when receipts may be stored or shared.
- This extension intentionally does not include amount, fee, or transaction hash in version `1`; those details belong to adjacent receipt layers.

---

## References

- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [Offer and Receipt Extension](./extension-offer-and-receipt.md)
- [Payment Identifier Extension](./payment_identifier.md)
- [Facilitator-side attestation discussion](https://github.com/x402-foundation/x402/issues/1802)

---

## Version History

| Version | Date | Changes | Author |
| --- | --- | --- | --- |
| 0.1 | 2026-04-04 | Initial companion extension draft for operation-bound receipts. | Ayush Ozha |
