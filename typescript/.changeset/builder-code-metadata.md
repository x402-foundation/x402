---
"@x402/extensions": minor
"@x402/evm": minor
---

Added facilitator-authored settlement metadata (`m`) to the builder-code ERC-8021 Schema 2 suffix. `DataSuffixContext` accepts `metadata`, `encodeBuilderCodeSuffix` and `parseBuilderCodeSuffixFromCalldata` handle `m`, and encoding now throws instead of truncating when the CBOR exceeds 65,535 bytes.
