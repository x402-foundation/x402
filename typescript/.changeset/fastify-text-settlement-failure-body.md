---
"@x402/fastify": patch
---

Fixed custom settlement failure bodies with a non-JSON content type (such as `text/plain`) being JSON-encoded; string bodies are now sent as-is unless the content type is JSON.
