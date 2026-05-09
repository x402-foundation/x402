---
"@x402/core": minor
"@x402/extensions": minor
---

Added Bazaar service metadata fields (`serviceName`, `tags`, `iconUrl`) on `ResourceInfo`, plus `isValidServiceName` / `sanitizeTags` / `isValidIconUrl` / `sanitizeResourceServiceMetadata` helpers in `@x402/extensions/bazaar` that `extractDiscoveryInfo` now applies with soft-drop semantics. Fields are optional and additive — providers that omit them produce byte-identical 402 bodies.
