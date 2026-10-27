---
"@x402/evm": patch
---

Fixed a facilitator crash when an asset-contract `eth_getCode` fails before verify awaits the check. The stored promise now has a rejection handler, and awaiting the check still throws that error.
