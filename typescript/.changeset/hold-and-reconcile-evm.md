---
"@x402/evm": minor
---

`ExactEvmScheme` client implements `reconcilePaymentPayload` for EIP-3009 payloads by reading `authorizationState(from, nonce)` on the token. Requires `readContract` on the signer or an RPC URL in options; otherwise returns `"unknown"`.
