---
"@x402/evm": patch
---

Preserve recognized EIP-3009 contract revert reasons during exact/EVM verification. Probe unclassified simulation failures only when the node answered; transport errors retain the generic simulation-failed reason without extra diagnostic reads.
