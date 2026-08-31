---
"@x402/svm": patch
---

The facilitator's static verification path now tolerates wallet-injected Lighthouse guard instructions at any position. Phantom currently brackets the TransferChecked with four guards (three inserted before it, one appended after), so the previous positional layout check rejected every Phantom-signed payment with `invalid_exact_svm_payload_transaction_instructions_length` even though the payment instructions were untouched. Guard instructions are filtered out before the positional checks and bounded to four; the compute budget, transfer, and memo verification is unchanged.
