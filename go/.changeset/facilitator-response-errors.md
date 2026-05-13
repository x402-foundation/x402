---
'github.com/x402-foundation/x402/go': patch
---

Treat malformed facilitator success payloads as facilitator boundary errors in the Go HTTP client instead of surfacing them as verification or settlement failures.
