---
"@x402/extensions": patch
---

`wrapFetchWithSIWx` now picks the SIWX chain that matches the signer type, as `createSIWxClientHook` does. Previously it looked up only the network of `accepts[0]`, so it never signed in on auth-only routes (`accepts: []`) and gave up when the first payment option was on a different chain family than the signer.
