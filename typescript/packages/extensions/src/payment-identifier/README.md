# Payment-Identifier extension

Part of [`@x402/extensions`](../../README.md). Import from `@x402/extensions/payment-identifier`.

For x402 v2, this extension lets clients attach an idempotency key (`id`) on `PaymentPayload.extensions` so resource servers and facilitators can deduplicate payment attempts.

## For resource servers

```typescript
import {
  declarePaymentIdentifierExtension,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";

// Advertise support in PaymentRequired response (optional identifier)
const paymentRequired = {
  x402Version: 2,
  resource: { ... },
  accepts: [...],
  extensions: {
    [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(),
  },
};

// Require payment identifier
const paymentRequiredStrict = {
  x402Version: 2,
  resource: { ... },
  accepts: [...],
  extensions: {
    [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true),
  },
};
```

## For clients

```typescript
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";

// Get extensions from server's PaymentRequired response
const extensions = { ...paymentRequired.extensions };

// Append payment ID (only if server declared the extension)
appendPaymentIdentifierToExtensions(extensions);

// Include in PaymentPayload
const paymentPayload = {
  x402Version: 2,
  resource: paymentRequired.resource,
  accepted: selectedPaymentOption,
  payload: { ... },
  extensions,
};
```

## For idempotency implementation

Do not use the `id` alone as the storage key. Bind it to a normalized
fingerprint of the request, and reject reuse of the `id` with a different
fingerprint (see "Request Binding" in `specs/extensions/payment_identifier.md`).

```typescript
import {
  extractPaymentIdentifier,
  computeRequestFingerprint,
  isRequestBindingConflict,
} from "@x402/extensions/payment-identifier";

// In your settle handler
const id = extractPaymentIdentifier(paymentPayload);
if (id) {
  const fingerprint = computeRequestFingerprint(paymentPayload, { method: req.method });
  const seen = await idempotencyStore.get(id);
  if (seen) {
    if (isRequestBindingConflict(seen.fingerprint, fingerprint)) {
      return conflict(); // Same id, different request: 409 Conflict
    }
    return seen.response; // Same id, same request: return the cached response
  }
}
```

## Related exports

See [`index.ts`](./index.ts) for types, validation helpers (`validatePaymentIdentifier`, `isPaymentIdentifierRequired`, etc.), and `paymentIdentifierResourceServerExtension`.
