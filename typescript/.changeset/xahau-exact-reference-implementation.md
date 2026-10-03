---
"@x402/xahau": minor
---

Added the Xahau `exact` scheme implementation (`@x402/xahau`), following `specs/schemes/exact/scheme_exact_xahau.md`. Built on xahau.js and independent of `@x402/xrpl`: payer-signed `Payment` transactions with `sequence` and `ticketSequence` transfer methods, mandatory signed `NetworkID` for `xahau:21337` / `xahau:21338`, Hook-aware fee autofill, and verification through the xahaud `simulate` RPC.
