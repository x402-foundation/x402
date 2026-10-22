---
"@x402/aptos": patch
"@x402/concordium": patch
"@x402/evm": patch
"@x402/keeta": patch
"@x402/near": patch
"@x402/stellar": patch
"@x402/svm": patch
---

Propagate `invalidMessage` from the settle-time re-verification into `SettleResponse.errorMessage`, including the EVM auth-capture collect and lifecycle settle paths, matching the behavior already present in the avm, casper, cardano, hedera, tvm, and xrpl mechanisms. Settle failures previously returned only `errorReason`, so the diagnostic detail (e.g. the underlying Solana simulation error) was dropped even though `/verify` returned it.
