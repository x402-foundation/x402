---
"@x402/next": patch
---

Fixed Next.js builds failing with `ERR_MODULE_NOT_FOUND` for `@x402/extensions/bazaar` when Bazaar routes use either a pre-registered or automatically registered extension. The bazaar extension is lazily imported without `webpackIgnore` so the bundler traces `@x402/extensions`. Startup validation runs from that import for routes that declare Bazaar, including pre-registered extensions. ([#3976](https://github.com/x402-foundation/x402/pull/3976)) - Thanks [@PhilBot402](https://github.com/PhilBot402) and [@phdargen](https://github.com/phdargen)!
