---
"@x402/core": patch
"@x402/paywall": patch
---

Fixed `@x402/paywall` auto-detection. Browser 402 responses served the static fallback page even when `@x402/paywall` was installed, because core called a `getPaywallHtml` export that v2 removed (and used `require`, which ESM builds don't have). Core now imports `@x402/paywall` at request time when no paywall provider is registered, and renders its EVM, Solana or Algorand paywall when the route's first payment option is an `exact` payment on one of those networks. Other routes keep the static page.

`@x402/paywall` now escapes `<` in the values it writes into the paywall page's inline script, so a string containing `</script>` in the payment requirements or paywall config stays inside the script data.
