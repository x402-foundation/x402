---
"@x402/svm": minor
---

SVM exact, upto and batch-settlement clients now build Solana transaction v1 (SIMD-0385) when the facilitator advertises it, and facilitators advertise and accept `extra.transactionVersions` `[0, 1]`. Pass `transactionVersions: [0]` in the client config to keep a signer that cannot sign version 1 on version 0.

A client-built version-1 transaction carries no ComputeBudget instructions: its message config sets the compute unit limit, a 4 MiB loaded-account-data budget (`DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT`) and the total priority fee in lamports, and it may be up to 4096 bytes. Verifiers check the version-1 exact layout (TransferChecked first, then up to four Lighthouse/Memo instructions) and the open, top-up and `request_close` layouts. They require the compute unit and loaded-account-data limits, cap the priority fee as `priorityFee * 1000000 <= capMicroLamports * computeUnitLimit` in arbitrary precision, and reject a heap-size request or any ComputeBudget instruction. New exact reasons: `invalid_exact_svm_payload_transaction_loaded_accounts_data_size_limit_missing`, `invalid_exact_svm_payload_transaction_v1_compute_budget_instruction` and `invalid_exact_svm_payload_transaction_v1_heap_size`.

Verifiers now enforce the serialized size limit of the message version on every client transaction they co-sign (1232 bytes for legacy and version 0, 4096 bytes for version 1): exact rejects an oversized payment with the new `invalid_exact_svm_payload_transaction_size_exceeded` reason, and the open, top-up and `request_close` verifiers reject one before checking its layout.

The upto open + settle + distribute readiness simulation now runs in the open's own message version: a version-1 open is simulated as version 1, with no ComputeBudget instructions, rather than re-wrapped as version 0.
