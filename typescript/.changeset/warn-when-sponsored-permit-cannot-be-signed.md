---
"@x402/evm": patch
---

Warn (once per network) when gas sponsoring is advertised but the client cannot read the chain, instead of silently skipping the sponsored permit/approval; document that `rpcUrl` or a reading signer is required for sponsored Permit2 payments.
