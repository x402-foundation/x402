---
"@x402/near": patch
---

Evict settlement-cache entries once their delegate max_block_height has passed, as spec section 10 describes. Previously evictExpired had no production caller, so expired entries were removed only by the TTL safety net.
