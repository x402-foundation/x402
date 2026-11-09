---
"@x402/casper": patch
---

The `exact` Casper facilitator now returns the transaction hash in `transaction` when settlement fails after the transaction was submitted, for example when it reverts on chain or the wait for its result times out. `transaction` stays empty when no transaction was submitted.
