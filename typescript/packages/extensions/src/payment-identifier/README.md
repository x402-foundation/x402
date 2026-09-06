# Payment-Identifier extension

Part of [`@x402/extensions`](../README.md). Import from `@x402/extensions/payment-identifier`.

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

```typescript
import { extractPaymentIdentifier } from "@x402/extensions/payment-identifier";

// In your settle handler
const id = extractPaymentIdentifier(paymentPayload);
if (id) {
  const cached = await idempotencyStore.get(id);
  if (cached) {
    return cached; // Return cached response
  }
}
```

## Related exports

See [`index.ts`](./index.ts) for types, validation helpers (`validatePaymentIdentifier`, `isPaymentIdentifierRequired`, etc.), and `paymentIdentifierResourceServerExtension`.
