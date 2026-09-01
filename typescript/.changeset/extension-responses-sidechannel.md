---
"@x402/core": patch
---

Populate `extensionResponses` on verify/settle from the facilitator `EXTENSION-RESPONSES` header as a server-internal sidechannel (aligned with Python). Do not merge into `extensions`; strip the sidechannel from buyer-facing `PAYMENT-RESPONSE` encoding.
