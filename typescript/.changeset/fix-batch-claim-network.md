---
"@x402/evm": patch
---

Fixed EVM batch-settlement channel managers claiming or refunding foreign-network channels in shared storage. Server writes now persist the request network; manager selection uses it first and retains channel-id binding checks for legacy rows. Failed claim batches no longer block later batches or settlement of successful claims. `BatchClaimError` exposes the batch errors, successful results, and any completed settlement; automatic claim jobs report both successful batches and failures.
