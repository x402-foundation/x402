---
'github.com/x402-foundation/x402/go/v2': patch
---

Require a configured `Origin` for SIWX server integration. Challenge issuance and proof validation now bind to this operator-defined public origin instead of deriving trust from request headers or per-route declaration fields. Pass `Origin` to `CreateResourceServerExtension()`; remove `Domain` and `ResourceURI` from `DeclareOptions`.
