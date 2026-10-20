---
"@x402/evm": patch
---

Fixed batch-settlement `ChannelManager` leaving claimed funds unsettled when the claims were submitted by a refund (server or client initiated) or by an earlier process. The settle job now calls the facilitator on every interval instead of only after its own `claim()`, `settle()` returns an empty transaction instead of throwing when the facilitator reports nothing to settle (including a non-2xx reply surfaced as `SettleError`), and `stop({ flush: true })` settles even when it claimed nothing.
