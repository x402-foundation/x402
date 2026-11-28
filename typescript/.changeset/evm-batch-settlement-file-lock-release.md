---
"@x402/evm": patch
---

`acquireExclusiveFile` no longer treats a lock marker that disappears while it is being checked as stale. A contender that hit a lock just as its owner released it used to unlink the path, which could remove the lock another contender had just created and let two `FileChannelStorage` callers hold the same channel lock at once.
