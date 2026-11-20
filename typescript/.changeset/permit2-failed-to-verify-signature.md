---
"@x402/evm": patch
---

Fixed exact and upto Permit2 verify reporting an RPC failure during the signature check as `invalid_permit2_signature`. A failed payer `eth_getCode`, or an `isValidSignature` call that fails without reverting, now returns `invalid_permit2_failed_to_verify_signature` with the error in `invalidMessage`. A revert or a non-magic `isValidSignature` result is still `invalid_permit2_signature`. The Go and Python SDKs return the same reason for a failed payer code lookup.
