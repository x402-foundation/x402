---
"@x402/extensions": patch
---

Fixed delivery receipt hashing to reject parsed objects in raw mode and invalid or unsafe-integer JCS inputs. Defined raw digests over identity-encoded body bytes and kept legacy receipt canonicalization unchanged. The settlement hook now reads responseBody and omits the optional delivery binding when only content-encoded bytes are available.
