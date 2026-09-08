---
"@x402/evm": patch
---

EVM exact settle's ERC-6492 branch now reads payer deployment from the verify it already awaited rather than issuing a second eth_getCode. Both reads happen within one settle call and before any deploy transaction, so this is not the post-deploy re-read that races RPC state propagation.
