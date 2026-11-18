---
"@x402/evm": patch
---

Batch-settlement client recovery rejects a corrective-402 voucher signature that `x402BatchSettlement` cannot recover. A high-s or `v` of 0/1 signature no longer overwrites local channel state.
