---
"@x402/evm": patch
---

The batch-settlement facilitator now rejects a refund that has no `refundAuthorizerSignature` with `invalid_batch_settlement_evm_refund_authorizer_signature` instead of signing it with its authorizer key, since it has no `/settle` caller authentication. Server-signed refunds are unchanged.
