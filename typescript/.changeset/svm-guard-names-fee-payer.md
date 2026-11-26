---
"@x402/svm": patch
---

The `exact` SVM facilitator accepts a Lighthouse assertion that lists the fee payer in its accounts, as Phantom adds before signing. Previously the payment failed with `invalid_exact_svm_payload_transaction_fee_payer_transferring_funds`. A guard still cannot invoke the fee payer as its program, a non-assertion Lighthouse instruction is still rejected, and every other instruction still must not reference the fee payer.
