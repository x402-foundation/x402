---
"@x402/next": patch
---

Fixed custom settlement failure bodies with a non-JSON content type (such as `text/plain`) being JSON-encoded in the proxy and route wrapper; string bodies are now sent as-is unless the content type is JSON.
