---
"@x402/svm": patch
---

Fixed missing receiver payout callbacks for cooperative seals and refunds. Coalesced overlapping accounting within a shared store instance and returned `settlement_pending` on recording failure so retries can recover without rebroadcasting. Callbacks must still atomically deduplicate by transaction across processes and crash recovery.
