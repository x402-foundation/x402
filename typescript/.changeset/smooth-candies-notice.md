---
'@x402/concordium': patch
---

Retry finalization when the node does not know a just-submitted transaction yet (NOT_FOUND), instead of failing settle.
