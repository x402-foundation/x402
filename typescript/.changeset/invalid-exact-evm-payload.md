---
"@x402/evm": patch
"x402": patch
---

The exact EVM facilitator reports `invalid_exact_evm_payload` when an EIP-3009 or Permit2 payload is malformed, on v1 and v2 verify and settle. This reason replaces `invalid_payload`. The message names the first bad field, and `payer` is set when `from` is a string. The legacy `x402` `ErrorReasons` enum accepts this reason.
