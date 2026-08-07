# @x402/near

## 2.21.0

### Minor Changes

- Updated dependencies [e805616](https://github.com/x402-foundation/x402/commit/e805616)
- Updated dependencies [e335d4f](https://github.com/x402-foundation/x402/commit/e335d4f)
- Updated dependencies [183b270](https://github.com/x402-foundation/x402/commit/183b270)
- Updated dependencies [ee1b148](https://github.com/x402-foundation/x402/commit/ee1b148)
- Updated dependencies [e805616](https://github.com/x402-foundation/x402/commit/e805616)
- Updated dependencies [5192e50](https://github.com/x402-foundation/x402/commit/5192e50)
  - @x402/core@2.21.0

## 2.20.0

### Minor Changes

- Updated dependencies [4453a92](https://github.com/x402-foundation/x402/commit/4453a92)
  - @x402/core@2.20.0

## 2.19.0

### Minor Changes

- Updated dependencies [c72cfee](https://github.com/x402-foundation/x402/commit/c72cfee)
  - @x402/core@2.19.0

## 2.18.0

### Minor Changes

- Updated dependencies [a3ad102](https://github.com/x402-foundation/x402/commit/a3ad102)
  - @x402/core@2.18.0

## 2.17.0

- [b892aef](https://github.com/x402-foundation/x402/commit/b892aef): Add the NEAR `exact` scheme reference implementation (TypeScript), following `specs/schemes/exact/scheme_exact_near.md`. Includes spec-compliant client/facilitator/server schemes with NEP-366 `SignedDelegate` signing and verification (ed25519 + secp256k1), the deterministic `maxTimeoutSeconds` → `max_block_height` mapping, on-chain `view_access_key` nonce and access-key permission checks (§5/§8), chain-state preflight via `view_account`/`ft_balance_of`/`storage_balance_of` (§9), receipt-waiting settlement (§7), an in-memory duplicate-settlement cache (§10), reference NEAR JSON-RPC signer implementations. ([#2663](https://github.com/x402-foundation/x402/pull/2663)) - Thanks [@mikedotexe](https://github.com/mikedotexe)!
