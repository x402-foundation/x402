---
'@x402/core': patch
---

Replace the dynamic fallback paywall HTML (used when @x402/paywall is not installed) with a static template, eliminating reflected XSS surface from interpolated request URLs and config values.
