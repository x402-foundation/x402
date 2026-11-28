---
"@x402/near": patch
---

Serialize settlement submissions per NEAR relayer account. Concurrent settlements previously read the same relayer access-key nonce (at `final` finality, before the first transaction was final), so they could sign the same nonce and the later one failed. A queued settlement whose delegate action has expired is no longer sent.
