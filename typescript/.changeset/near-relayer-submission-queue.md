---
"@x402/near": patch
---

Serialize settlement submissions per NEAR relayer account. Concurrent settlements previously read the same relayer access-key nonce before the first transaction reached FINAL, so they could sign the same nonce and the later one failed.
