---
"@x402/stellar": minor
---

The Stellar exact client and facilitator accept an optional `rpcConfig.horizonUrl` for the ledger close time estimate. They used to always read the public SDF Horizon (`horizon.stellar.org` on pubnet) even when `rpcConfig.url` pointed at a custom RPC. Without `horizonUrl` the default Horizon URLs are used as before.
