---
"@x402/core": patch
---

Fixed payment creation hooks to share a context per call and notify failure hooks for cleanup when a before hook aborts or throws, without allowing recovery to override the rejection.
