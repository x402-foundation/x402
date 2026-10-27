---
"@x402/core": patch
---

Fixed `x402Facilitator.derivePattern()` silently dropping wildcard network matching when a single `register()`/`registerV1()` call spans more than one CAIP-2 namespace (e.g. `["stellar:testnet", "stellar:futurenet", "eip155:8453"]`). Previously any mixed-namespace registration collapsed to a single literal exact-match pattern derived from `networks[0]`, discarding the wildcard a same-namespace group would otherwise have earned on its own — even for a namespace with multiple explicitly registered networks. Each namespace present in a registration now derives its own wildcard pattern independently.
