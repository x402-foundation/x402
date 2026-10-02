---
"@x402/core": patch
---

Return `400` instead of `402` when a request carries a `PAYMENT-SIGNATURE` header that cannot be decoded. The header was previously treated as absent (the decode error was swallowed with a `console.warn`), so a client that sent a corrupt payment header got the same `402 Payment Required` as a client that sent none, and could not tell the two apart. The HTTP transport spec maps a malformed payment payload to `400`, so a present-but-undecodable header now yields `400` with body `{ "error": "invalid_payload" }` and no facilitator `verify` call.
