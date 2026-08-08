---
"@x402/evm": patch
---

Bring the TypeScript exact/EVM verify path to parity with Python: when the EIP-3009 transfer simulation fails, classify an on-chain revert through `parseEip3009TransferError` (guarded by `isContractRevert`) before falling back to the diagnostic probe, instead of letting every simulation failure resolve to `invalid_exact_evm_transaction_simulation_failed`. That code reports a payload that is valid but whose simulation could not run, so a caller may retry it; a revert is terminal and the same payload is rejected on every attempt. Failures that are not recognised reverts keep the existing diagnostic behaviour.
