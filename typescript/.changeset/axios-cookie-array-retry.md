---
"@x402/axios": patch
---

Fixed paid-retry Cookie handling in `@x402/axios` so array values, including an empty array that overrides an instance default, are preserved for Axios to serialize instead of being dropped or comma-joined.
