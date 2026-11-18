---
"@x402/evm": patch
---

Batch-settlement voucher verification (facilitator `verifyVoucher` and the server's local check) rejects ECDSA signatures that `x402BatchSettlement` cannot recover: anything other than 65 bytes with a low `s` and `v` of 27 or 28. Previously a high-s or `v` = 0/1 voucher signature verified off-chain, and the later claim reverted.
