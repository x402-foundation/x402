---
"@x402/fastify": minor
---

Added opt-in `paymentHook: "preValidation"` for payment hooks and dynamic pricing that read parsed request bodies. Kept `onRequest` payment processing as the default and rejected non-origin-form request targets in `onRequest` in both modes.

The opt-in mode runs after body parsing and before schema validation. Register the middleware before other `preValidation` hooks that serve paid content. Earlier `onRequest`/`preParsing` hooks run before the payment gate; malformed JSON and body-limit errors can return before a payment challenge.
