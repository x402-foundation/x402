---
'@x402/evm': patch
---

Fixed EIP-3009 client signing and facilitator verify/settle against `requirements.asset` unconditionally, ignoring a seller-supplied `extra.verifyingContract` (e.g. Circle Gateway's batch-settlement contract). Trusting `extra.verifyingContract` is opt-in via a `verifyingContractValidator` callback on `ExactEvmScheme`/`ExactEvmSchemeV1` (client and facilitator); by default (no validator supplied) signing, verification, and settlement still always use the asset address, matching prior behavior.
