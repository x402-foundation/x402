---
"@x402/evm": patch
---

Fixed the batch-settlement channel manager aborting a refund sweep on a channel whose balance is already fully charged. `refund`, `refundIdleChannels` and the auto refund job now skip such channels instead of sending a zero-amount cooperative refund, which the contract rejects (`ZeroRefund`), so the channels after it are still refunded. This matches the Go and Python channel managers.
