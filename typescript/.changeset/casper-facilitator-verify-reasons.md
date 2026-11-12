---
"@x402/casper": patch
---

The exact Casper facilitator now returns `invalid_exact_casper_facilitator_malformed_payload` when a payload cannot be parsed, and `invalid_exact_casper_facilitator_preflight_failed` when a targeted preflight read fails or a dictionary value is malformed. A missing balance, a used nonce, and an asset that cannot run `transfer_with_authorization` keep their existing reasons. Settle reports the same reason and payer. ([#4233](https://github.com/x402-foundation/x402/pull/4233)) - Thanks [@PhilBot402](https://github.com/PhilBot402) and [@phdargen](https://github.com/phdargen)!
