# Pact Release Policy Profile for x402 Auth-Capture

This specification defines the Verification-Gated Release Policy profile over the x402 `auth-capture` payment scheme (#3065).

## Overview

The `auth-capture` scheme defines hold and capture mechanics. This profile specifies the mechanical execution rules for `captureAuthorizer` based on verifiable task completion.

```
+----------------+      Co-sign Contract (RFC 8785 / JWS)      +----------------+
|  Buyer Agent   | <=========================================> |  Seller Agent  |
+----------------+                                             +----------------+
        |                                                              |
        | 1. Auth Hold ($195)                                          | 2. Submit Work
        v                                                              v
+-------------------------------------------------------------------------------+
|                        x402 CaptureAuthorizer Engine                         |
|  - Runs Verification Suite (Deterministic / TEE / zkML)                      |
|  - Verification PASS -> Capture Payment                                      |
|  - Verification FAIL -> Void Hold & Slash Bond                                |
+-------------------------------------------------------------------------------+
```

## Lifecycle Steps

1. **Verifiable Task Contract:** Buyer and seller co-sign a contract fixing task scope hash, payout, verification method, and challenge window.
2. **Mechanical Settlement:** On task submission, verification suite runs:
   - **PASS:** Auto-capture released to seller.
   - **FAIL:** Hold voided and seller bond slashed.
3. **Work Attestation:** Both parties co-sign a Work Attestation upon settlement recording contract hash and completion status.
