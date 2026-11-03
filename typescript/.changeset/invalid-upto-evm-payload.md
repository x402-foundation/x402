---
"@x402/evm": patch
---

The upto EVM facilitator reports `invalid_upto_evm_payload` on verify and settle when a Permit2 payload is malformed, and `invalid_upto_evm_required_amount` on verify when `requirements.amount` is not a number. This reason replaces `unsupported_payload_type`. The message names the first bad field, and `payer` is set when `from` is a string.
