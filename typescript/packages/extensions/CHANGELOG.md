# @x402/extensions Changelog

## 2.21.0

### Minor Changes

- [e805616](https://github.com/x402-foundation/x402/commit/e805616): `builder-code` `s` entries now use dedicated, non-overlapping reservations per party instead of one shared cap: `MAX_CLIENT_SERVICE_CODES` (5) for `BuilderCodeClientExtension`, `MAX_SERVER_SERVICE_CODES` (5) for `declareBuilderCodeExtension`, and a new `MAX_FACILITATOR_SERVICE_CODES` (1) reservation for `BuilderCodeFacilitatorExtension`'s new `serviceCode` config option. `MAX_SERVICE_CODES` is now the sum of the three (11) and is enforced by the facilitator as a defensive backstop, so a compliant client and server can no longer have their entries silently dropped by each other. The resource server's extension echo validation also now rejects a client echo whose `s` exceeds the combined client+server budget outright, instead of accepting it and leaving truncation to the facilitator. ([#3027](https://github.com/x402-foundation/x402/pull/3027)) - Thanks [@ethanoroshiba](https://github.com/ethanoroshiba)!
- Updated dependencies [e805616](https://github.com/x402-foundation/x402/commit/e805616)
- Updated dependencies [e335d4f](https://github.com/x402-foundation/x402/commit/e335d4f)
- Updated dependencies [183b270](https://github.com/x402-foundation/x402/commit/183b270)
- Updated dependencies [ee1b148](https://github.com/x402-foundation/x402/commit/ee1b148)
- Updated dependencies [e805616](https://github.com/x402-foundation/x402/commit/e805616)
- Updated dependencies [5192e50](https://github.com/x402-foundation/x402/commit/5192e50)
  - @x402/core@2.21.0

### Patch Changes

- [e805616](https://github.com/x402-foundation/x402/commit/e805616): `declareBuilderCodeExtension` accepts an optional service code(s) argument so a resource server can attribute its own dependencies (e.g. a server-side SDK) via builder-code `s`. `BuilderCodeClientExtension` and `declareBuilderCodeExtension` now both reject more than `MAX_SERVICE_CODES` codes. ([#3027](https://github.com/x402-foundation/x402/pull/3027)) - Thanks [@ethanoroshiba](https://github.com/ethanoroshiba)!
- [6b04d5e](https://github.com/x402-foundation/x402/commit/6b04d5e): Reject bazaar discovery extension schemas containing external "$ref"/"$id" values (anything other than a same-document "#" fragment) before validation, preventing an attacker-controlled schema from triggering an outbound HTTP request or local file read (SSRF/LFI, CWE-918) ([#3039](https://github.com/x402-foundation/x402/pull/3039)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!

## 2.20.0

### Minor Changes

- Updated dependencies [4453a92](https://github.com/x402-foundation/x402/commit/4453a92)
  - @x402/core@2.20.0

### Patch Changes

- [b7bfa69](https://github.com/x402-foundation/x402/commit/b7bfa69): Cap builder-code service codes (`s`) to 5 entries. ([#2912](https://github.com/x402-foundation/x402/pull/2912)) - Thanks [@phdargen](https://github.com/phdargen)!
- [32464a2](https://github.com/x402-foundation/x402/commit/32464a2): Rejected small-order Ed25519 public keys in SIWx Solana signature verification. ([#2933](https://github.com/x402-foundation/x402/pull/2933)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.19.0

### Minor Changes

- [21b0745](https://github.com/x402-foundation/x402/commit/21b0745): Require a configured `origin` for SIWX server integration. Challenge issuance and proof validation now bind to this operator-defined public origin instead of deriving trust from request headers, route resources, or per-route declaration fields. **Migration:** pass `origin` when creating the resource server extension or request hook: `typescript createSIWxResourceServerExtension({ storage, origin: "https://api.example.com", }); ` Remove `domain` and `resourceUri` from `declareSIWxExtension()` — configure the public origin once at the server level. Behind TLS-terminating reverse proxies, set `origin` to the browser-visible URL (for example `https://api.example.com`), not the upstream listener address. ([#2859](https://github.com/x402-foundation/x402/pull/2859)) - Thanks [@phdargen](https://github.com/phdargen)!
- [c1f2d90](https://github.com/x402-foundation/x402/commit/c1f2d90): Reshaped `SIWxValidationResult` and `SIWxVerifyResult` into discriminated unions aligned with the facilitator verify response: `{ isValid: true } | { isValid: false; invalidReason; invalidMessage }` (verify success includes `payer`), where `invalidReason` is a stable spec-documented `invalid_siwx_*` code, replacing the previous `{ valid, error }` shapes. Also fixed `verifySIWxSignature` rejecting on malformed CAIP-2 chainIds; it now resolves with a failure result as documented. ([#2888](https://github.com/x402-foundation/x402/pull/2888)) - Thanks [@phdargen](https://github.com/phdargen) and [@vraspar](https://github.com/vraspar)!
- Updated dependencies [c72cfee](https://github.com/x402-foundation/x402/commit/c72cfee)
  - @x402/core@2.19.0

## 2.18.0

### Minor Changes

- Updated dependencies [a3ad102](https://github.com/x402-foundation/x402/commit/a3ad102)
  - @x402/core@2.18.0

## 2.17.0

### Minor Changes

- Updated dependencies [266b19d](https://github.com/x402-foundation/x402/commit/266b19d)
  - @x402/core@2.17.0

## 2.16.0

### Minor Changes

- [59ac597](https://github.com/x402-foundation/x402/commit/59ac597): Added a dynamicInfoFields capability so an extension can mark certain info fields (nonces, timestamps) as regenerated per PaymentRequired response. Those fields are then excluded from the client-echo validatio (extension_echo_mismatch), while all other fields stay strictly compared. Wired into the offer-receipt (["offers"]) and sign-in-with-x (["nonce", "issuedAt", "expirationTime"]) extensions. ([#2653](https://github.com/x402-foundation/x402/pull/2653)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies [59ac597](https://github.com/x402-foundation/x402/commit/59ac597)
  - @x402/core@2.16.0

## 2.15.0

### Minor Changes

- [ae0bf9b](https://github.com/x402-foundation/x402/commit/ae0bf9b): builder-code: accept and encode multiple service codes (`s`). The client extension now accepts a string or an array of codes, and the facilitator/CBOR layers encode and parse every valid entry, so layered clients (e.g. an MCP middleware) can attribute multiple participants onchain. ([#2606](https://github.com/x402-foundation/x402/pull/2606)) - Thanks [@phdargen](https://github.com/phdargen)!
- [6acb8fc](https://github.com/x402-foundation/x402/commit/6acb8fc): Implemented builder-code extension ([#2329](https://github.com/x402-foundation/x402/pull/2329)) - Thanks [@0xClouds](https://github.com/0xClouds) and [@pk-coinbase](https://github.com/pk-coinbase), [@phdargen](https://github.com/phdargen)!
- Updated dependencies [bfa580e](https://github.com/x402-foundation/x402/commit/bfa580e)
- Updated dependencies [3a60816](https://github.com/x402-foundation/x402/commit/3a60816)
- Updated dependencies [7539e93](https://github.com/x402-foundation/x402/commit/7539e93)
  - @x402/core@2.15.0

### Patch Changes

- [7539e93](https://github.com/x402-foundation/x402/commit/7539e93): Fixed client extension echo merging to preserve server-declared extension fields while adding client-provided extension data ([#2561](https://github.com/x402-foundation/x402/pull/2561)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.14.0

### Minor Changes

- be788e0: Thread Bazaar service metadata from HTTP `RouteConfig` and MCP `PaymentWrapperConfig` into `PaymentRequired.resource`, and extend bazaar facilitator discovery/catalog types so verified payments persist description, MIME type, service metadata, and echoed extension payloads.
- Updated dependencies [be788e0]
- Updated dependencies [0af31dd]
  - @x402/core@2.14.0

## 2.13.0

### Minor Changes

- 49ea054: Use extension hook adapters and auto-register hooks in SIWX extension
- Updated dependencies [ad08a9a]
- Updated dependencies [5fca9f3]
- Updated dependencies [95f2094]
- Updated dependencies [49ea054]
  - @x402/core@2.13.0

## 2.12.0

### Minor Changes

- 608034f: Added Bazaar service metadata fields (`serviceName`, `tags`, `iconUrl`) on `ResourceInfo`, plus `isValidServiceName` / `sanitizeTags` / `isValidIconUrl` / `sanitizeResourceServiceMetadata` helpers in `@x402/extensions/bazaar` that `extractDiscoveryInfo` now applies with soft-drop semantics. Fields are optional and additive — providers that omit them produce byte-identical 402 bodies.
- ee7c156: chore: tighten viem dependency floor to ^2.48.11

  Raises the viem floor in every `@x402/*` package.json that lists viem as a direct dep so future `pnpm install` re-resolutions cannot regress below this version. Fixes the incomplete tightening from #2013.

- Updated dependencies [608034f]
- Updated dependencies [d235050]
- Updated dependencies [45d7d19]
  - @x402/core@2.12.0

## 2.11.0

### Minor Changes

- Updated dependencies [a051f48]
- Updated dependencies [dc04108]
  - @x402/core@2.11.0

## 2.10.0

### Minor Changes

- 9424291: chore: bump viem lockfile to 2.47.12

  Updates the resolved viem version across all direct dependencies, adding chain definitions for Mezo Testnet, MegaETH, Stable, and Stable Testnet that were missing from previously locked versions.

- a4e4911: Migrate SIWE dependency from `siwe` (Spruce) to `@signinwithethereum/siwe` (Ethereum Identity Foundation). The new package is the official successor, supports viem natively as a peer dependency, and maintains the same `SiweMessage` API.
  - @x402/core@2.10.0

## 2.9.0

### Minor Changes

- 2250cae: Migrated project from coinbase/x402 to x402-foundation/x402 organization

### Patch Changes

- Updated dependencies [8cf3fca]
- Updated dependencies [c0e3969]
- Updated dependencies [2250cae]
- Updated dependencies [d352574]
  - @x402/core@2.9.0

## 2.8.0

### Minor Changes

- 4f2f4f3: Added auth-only route support in createSIWxRequestHook via accepts: [] detection
- 067f297: Added dynamic route support to the Bazaar discovery extension — servers can now declare `[param]` route segments that consolidate to a single catalog entry per route template, with automatic `pathParams` enrichment and `:param`-style `routeTemplate` in discovery output.

### Patch Changes

- Updated dependencies [067f297]
- Updated dependencies [4c1e44f]
- Updated dependencies [5135fab]
  - @x402/core@2.8.0

## 2.7.0

### Minor Changes

- 8b731cb: Replaced `sendRawApprovalAndSettle` with a generic `sendTransactions` signer method that accepts an array of pre-signed serialized transactions or unsigned call intents. The signer owns execution strategy (sequential, batched, or atomic bundling). Closed fail-open verification paths, aligned Permit2 amount check to exact match, and added `signerForNetwork` to the extensions package.
- f2bbb5c: Added offer-receipt extension to enable signed offers and receipts in x402 payment flows

### Patch Changes

- 34d2442: Removed dependencie on node’s crypto module
- Updated dependencies [8931cb3]
  - @x402/core@2.7.0

## 2.6.0

### Minor Changes

- Updated dependencies
  - @x402/core@2.6.0

## 2.5.0

### Minor Changes

- 7fe268f: Implemented the erc20 approval gas sponsorship extension

### Patch Changes

- 1ab1c86: Guard against undefined `resource` in SIWX settle hook to prevent runtime crash when `PaymentPayload.resource` is absent
- Updated dependencies [96a9db0]
- Updated dependencies [d0a2b11]
- Updated dependencies
  - @x402/core@2.5.0

## 2.4.0

### Minor Changes

- 018181b: Implement EIP-2612 gasless Permit2 approval extension

  - Added `eip2612GasSponsoring` extension types, resource service declaration, and facilitator validation utilities

- 664285e: Add MCP tool discovery support to the bazaar extension system

### Patch Changes

- 3fb55d7: Upgraded facilitator extension registration from string keys to FacilitatorExtension objects. Added FacilitatorContext threaded through SchemeNetworkFacilitator.verify/settle for mechanism access to extension capabilities
- Updated dependencies [57a5488]
- Updated dependencies [018181b]
- Updated dependencies [3fb55d7]
  - @x402/core@2.4.0

## 2.3.1

### Patch Changes

- f93fc09: Added solanakit support for siwx
- Updated dependencies [9ec9f15]
  - @x402/core@2.3.1

## 2.3.0

### Minor Changes

- fe42994: Added Sign-In-With-X (SIWX) extension for wallet-based authentication. Clients can prove previous payment by signing a message, avoiding re-payment. Supports EVM and Solana signature schemes with multi-chain support, lifecycle hooks for servers and clients, and optional nonce tracking for replay protection.
- 51b8445: Added payment-identifier extension for tracking and validating payment identifiers

### Patch Changes

- Updated dependencies [51b8445]
- Updated dependencies [51b8445]
  - @x402/core@2.3.0

## 2.0.0

- Implements x402 2.0.0 for the TypeScript SDK.

## 1.0.0

- Implements x402 1.0.0 for the TypeScript SDK.
