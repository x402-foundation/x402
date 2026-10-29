---
"@x402/next": patch
---

Fixed bundled Next.js builds logging a bazaar load failure when the bazaar extension is already registered. Those pre-registered setups no longer get the startup schema check from a runtime import.
