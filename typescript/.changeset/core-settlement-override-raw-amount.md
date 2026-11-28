---
"@x402/core": patch
---

Settlement overrides now reject a raw amount that is not a base-10 integer string. `""`, `"-1"`, `"0x10"` and `" 100"` previously passed the authorized-maximum check through `BigInt()` and were forwarded to the facilitator as the settlement amount.
