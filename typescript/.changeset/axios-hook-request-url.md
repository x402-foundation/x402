---
"@x402/axios": patch
---

Fixed payment-required hook URLs to use Axios base-path joining and query serialization when the transport does not expose a final response URL.
