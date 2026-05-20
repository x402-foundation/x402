---
"@x402/evm": patch
---

Classified relayer gas exhaustion distinctly from EIP-3009 contract reverts in parseEip3009TransferError. Added ErrRelayerInsufficientFunds (`invalid_exact_evm_relayer_insufficient_funds`) so operators can alert on facilitator wallet gas drain without it being collapsed into the generic ErrTransactionFailed bucket.
