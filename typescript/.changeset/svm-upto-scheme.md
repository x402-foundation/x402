---
'@x402/svm': minor
---

Added a usage-based `upto` payment scheme for SVM, backed by an onchain payment-channels
program. Resource servers can authorize up to a ceiling and settle the actual metered usage,
with client/server/facilitator support, offchain voucher signing, and channel
open/distribute/settle helpers. Deposit settle rejects an already-existing channel
(`invalid_upto_svm_channel_already_open`) so each authorization opens exactly once.
