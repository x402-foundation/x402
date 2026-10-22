---
"@x402/evm": patch
---

Report a failed signature lookup as retryable instead of an invalid signature on the EIP-1271 contract-payer branch of exact EIP-3009 (v1 and v2) and on the batch-settlement EIP-3009 and Permit2 deposit paths. A payer `eth_getCode` or `isValidSignature` transport failure (HTTP error, timeout, rate limit) no longer reads as a bad signature there: the exact paths return `invalid_exact_evm_failed_to_verify_signature`, the deposit paths `invalid_batch_settlement_evm_rpc_read_failed`. A revert or an empty return from `isValidSignature` still reads as an invalid signature. The exported boolean helpers (`verifyTypedDataSignature`, `verifyHashSignature`, `verifyHashSignatureWithCode`, `verifyERC1271`) behave as before.
