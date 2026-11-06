---
"@x402/evm": patch
---

Permit2 allowance checks now honor an optional `hasRpcClient` probe. A signer that exposes `readContract` but reports no RPC client falls back to the scheme `rpcUrl`, so a configured endpoint can skip an unnecessary ERC-20 approval.
