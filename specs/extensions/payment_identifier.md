# Extension: `payment-identifier`

## Summary

The `payment-identifier` extension enables clients to provide an `id` that serves as an idempotency key. Both resource servers and facilitators consume `PaymentPayload`, so this can be leveraged at either or both points in the stack to deduplicate requests and return cached responses for repeated submissions.

---

## `PaymentRequired`

Server advertises support:

```json
{
  "extensions": {
    "payment-identifier": {
      "info": {
        "required": false
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "required": { "type": "boolean" },
          "id": { "type": "string", "minLength": 16, "maxLength": 128 }
        },
        "required": ["required"]
      }
    }
  }
}
```

---

## `PaymentPayload`

Client echoes the extension and appends an `id`:

```json
{
  "extensions": {
    "payment-identifier": {
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "required": { "type": "boolean" },
          "id": { "type": "string", "minLength": 16, "maxLength": 128 }
        },
        "required": ["required"]
      },
      "info": {
        "required": false,
        "id": "pay_7d5d747be160e280504c099d984bcfe0"
      }
    }
  }
}
```

---

## `required` Field

- **Type**: boolean
- **Purpose**: Indicates whether the server requires clients to include a payment identifier
- **Default**: `false` (payment identifier is optional)

---

## `id` Format

- **Length**: 16-128 characters
- **Characters**: alphanumeric, hyphens, underscores
- **Recommendation**: UUID v4 with prefix (e.g., `pay_`)

---

## Idempotency Behavior

| Scenario | Server Response |
|----------|-----------------|
| New `id` | Process request normally |
| Same `id`, same payload | Return cached response |
| Same `id`, different payload | Return 409 Conflict |
| `required: true`, no `id` provided | Return 400 Bad Request |

### Request Binding

Resource servers and facilitators should bind each `id` to a normalized request
fingerprint before returning a cached result. The fingerprint should cover the
parts of the request that make the paid operation unique, such as:

- `scheme`
- `network`
- `asset`
- `amount`
- `payTo`
- resource path and method
- application-level operation or order identifier

Implementations should store the first observed fingerprint with the `id`.
Later requests with the same `id` and the same fingerprint can return the
cached response. Later requests with the same `id` and a different fingerprint
should fail with `409 Conflict` instead of reusing the cached response or
executing a second operation.

Servers should avoid using `id` alone as the storage key for authorization
decisions when the same backend handles multiple paid resources. Scope the key
by tenant, merchant, route, or facilitator account when those boundaries exist.

The fingerprint suits deduplication that runs after the payment is verified,
when the payment itself authenticates the request. A lookup that runs before
verification, as response recovery does, binds the `id` to the exact
`PaymentPayload` instead (see below).

### Recovering a Lost Response

A client that did not receive the response to a paid request MAY resend the
identical `PaymentPayload`, with the same `id`, to recover it. Only a resource
server can return that response; a facilitator never holds it. A resource
server that returns stored responses for this purpose:

- MUST look up the `id` before verifying the payment. Otherwise a resend whose
  payment has already settled, or whose authorization has expired, fails
  verification, and the client cannot learn how the original request ended.
- MUST store the response exactly as it was sent, including the
  `PAYMENT-RESPONSE` header, and SHOULD store it atomically with completing the
  payment. A client reconciles its payment state from the settlement response,
  so a stored body without that header leaves the original payment unresolved.
- MUST return a stored response only for a `PaymentPayload` identical to the
  one it was stored for. Before verification nothing in the request is
  authenticated, so a key built from the fingerprint fields above would let
  anyone who learns an `id` read another payer's response. A different payload
  with the same `id` MUST be answered with `409 Conflict`.
- MUST NOT process a resend while the original request is still being
  processed. It SHOULD return the original's response once it is available,
  or an error the client can retry.

A resend that finds no stored response is processed like any other request,
and the payment scheme's own replay protection decides the outcome.

---

## Responsibilities

Both resource servers and facilitators consume `PaymentPayload`, so this extension can be leveraged at either or both points:

- **Resource server**: May use `id` for request deduplication and response caching
- **Facilitator**: May use `id` for verify/settle idempotency
- **Client**: Generates unique `id`, reuses same `id` on retries; must provide `id` if server sets `required: true`
