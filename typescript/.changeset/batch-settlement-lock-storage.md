---
"@x402/evm": minor
---

Move batch-settlement admission locks off the durable `Channel` record onto `ChannelLockStorage`. Acquire in `onBeforeVerify` after cheap local rejects (one channel Get under the lock); `onAfterVerify` only stashes facilitator extras. `pendingRequest` is removed from `Channel` (breaking for custom storage implementors; leftover `pendingRequest` JSON is ignored, no backfill). InMemory, Redis, and File implement both roles; pass `lockStorage` to mix backends (e.g. File durable + Redis locks). Redis channel delete also drops the `:server:lock:` key; contested `updateChannel` CAS retries are bounded by `maxUpdateWaitMs` (default 5s). File `.hold.lock` / `.json.lock` markers older than 2s are stolen so a crash cannot pin the channel.
