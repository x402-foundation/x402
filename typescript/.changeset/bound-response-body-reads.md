---
"@x402/core": patch
"@x402/extensions": patch
---

Bound the response bodies buffered by facilitator and Bazaar discovery clients: 1 MiB for control-plane responses (verify, settle, supported) and 4 MiB for discovery pages. A larger body throws `ResponseBodyTooLargeError` and cancels the stream instead of buffering the rest. Ports the Go behavior from #2973 to TypeScript.
