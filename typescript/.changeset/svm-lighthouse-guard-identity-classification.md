---
"@x402/svm": patch
---

Fixed exact SVM Path 1 rejecting wallet-injected Lighthouse assertion guards before the compute-budget/`TransferChecked` sequence or beyond the old instruction-count cap. Instructions are classified by program ID and discriminator, preserving protocol relative order while allowing assertions anywhere without a count cap.

Only Lighthouse assertion discriminators `2..=17` are accepted, and every guard must isolate the facilitator fee payer. MemoryWrite, MemoryClose, empty data, and unknown variants are rejected without smart-wallet fallback. Previously accepted unsafe Lighthouse instructions are intentionally no longer accepted. Configured preflight/postflight blocks cannot hide top-level `TransferChecked` instructions; their CPI effects remain operator-trusted.

Existing error constants remain exported, but Path 1 no longer emits `invalid_exact_svm_payload_transaction_instructions_length` or `invalid_exact_svm_payload_unknown_{fourth,fifth,sixth,seventh}_instruction`. Callers branching on those strings must handle the new `invalid_exact_svm_payload_unknown_instruction` and `invalid_exact_svm_payload_transaction_instructions_order` reasons instead.
