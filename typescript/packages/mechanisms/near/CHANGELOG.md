# @x402/near

## 2.18.0

### Minor Changes

- Updated dependencies [a3ad102](https://github.com/x402-foundation/x402/commit/a3ad102)
  - @x402/core@2.18.0

## 2.17.0

- [b892aef](https://github.com/x402-foundation/x402/commit/b892aef): Add the NEAR `exact` scheme reference implementation (TypeScript), following `specs/schemes/exact/scheme_exact_near.md`. Includes spec-compliant client/facilitator/server schemes with NEP-366 `SignedDelegate` signing and verification (ed25519 + secp256k1), the deterministic `maxTimeoutSeconds` → `max_block_height` mapping, on-chain `view_access_key` nonce and access-key permission checks (§5/§8), chain-state preflight via `view_account`/`ft_balance_of`/`storage_balance_of` (§9), receipt-waiting settlement (§7), an in-memory duplicate-settlement cache (§10), reference NEAR JSON-RPC signer implementations. ([#2663](https://github.com/x402-foundation/x402/pull/2663)) - Thanks [@mikedotexe](https://github.com/mikedotexe)!