---
"@x402/concordium": patch
---

Retry Concordium exact settlement while the node reports the submitted transaction as not found, until the finalization timeout. A transaction that is only briefly invisible no longer fails settlement with `finalization_failed: transaction not found.`
