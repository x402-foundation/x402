---
"@x402/next": patch
---

Fixed Next.js builds failing with `ERR_MODULE_NOT_FOUND` for `@x402/extensions/bazaar` when Bazaar routes use either a pre-registered or automatically registered extension. The bazaar extension is lazily imported without `webpackIgnore` so the bundler traces `@x402/extensions`. Startup validation always runs for routes that declare Bazaar.
