---
"@x402/extensions": patch
---

`verifyOfferSignatureEIP712` and `verifyReceiptSignatureEIP712` now reject a payload that is missing any field of its EIP-712 type, or that carries a field of the wrong shape (a `uint256` that is not a non-negative safe integer or bigint, or a non-string `string` field). The error is the existing `Invalid <kind>: missing or malformed payload` with the field named. Before, only a missing `payer`/`scheme` had a defined error: any other omitted field crashed with a `TypeError` inside `BigInt()` or the encoder. An omitted field is not filled in, even `transaction` (whose unused value is `""` per §5.3), because the payload is used exactly as transmitted (§5.5 step 3).
