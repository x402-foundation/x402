---
"@x402/evm": minor
---

EVM facilitators now cache a positive asset-contract check for 15 minutes instead of issuing a fresh eth_getCode on the payment token for every payment. Only positive results are cached, so a token observed mid-deployment still recovers on the next request. The cache is keyed by network and asset so entries cannot collide across chains.
