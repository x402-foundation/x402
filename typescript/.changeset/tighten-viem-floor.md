---
"@x402/evm": patch
"@x402/extensions": patch
"@x402/express": patch
"@x402/fetch": patch
"@x402/paywall": patch
"@x402/mcp": patch
---

chore: tighten viem dependency floor to ^2.48.11

Raises the viem floor in every `@x402/*` package.json that lists viem as a
direct dep so future `pnpm install` re-resolutions cannot regress below
this version. Fixes the incomplete tightening from #2013.
