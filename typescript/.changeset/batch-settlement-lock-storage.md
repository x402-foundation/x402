---
"@x402/evm": minor
---

Move batch-settlement admission locks off the durable `Channel` record onto `ChannelLockStorage`. `pendingRequest` is removed from `Channel` (breaking for custom storage implementors; leftover `pendingRequest` JSON is ignored, no backfill). InMemory, Redis, and File implement both roles; pass `lockStorage` to mix backends (e.g. File durable + Redis locks).
