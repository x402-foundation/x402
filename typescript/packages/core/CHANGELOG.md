# @x402/core Changelog

## 2.10.0

### Minor Changes

- Bumped to align version with dependent packages

## 2.9.0

### Minor Changes

- 2250cae: Migrated project from coinbase/x402 to x402-foundation/x402 organization
- d352574: Add SettlementOverrides support for partial settlement (upto scheme). Route handlers can call setSettlementOverrides() to settle less than the authorized maximum, enabling usage-based billing.

### Patch Changes

- 8cf3fca: Export all hook types and hook context interfaces from the server entry point
- c0e3969: Fixed HTTPFacilitatorClient not following 308 redirects from facilitator endpoints. Normalized base URL to strip trailing slashes and explicitly set `redirect: "follow"` on all fetch calls for cross-runtime compatibility.

## 2.8.0

### Minor Changes

- 067f297: Added `routePattern` to `HTTPRequestContext` and `pattern` to `CompiledRoute` to thread the matched route pattern through to server extensions, enabling dynamic route support in discovery extensions.
- 4c1e44f: Treat malformed facilitator success payloads as upstream facilitator errors and return 502 responses from framework middleware instead of flattening them into payment failures.
- 5135fab: Accept null in extra and extension fields

## 2.7.0

### Minor Changes

- 8931cb3: Added support for Express-style `:param` dynamic route parameters in route matching. Routes like `/api/users/:id` and `/api/chapters/:seriesId/:chapterId` now match correctly alongside the existing `[param]` (Next.js) and `*` (wildcard) patterns.

## 2.6.0

### Minor Changes

- f41baed: Added `x402Version` field to `VerifyRequest`, `SettleRequest`, `VerifyRequestV1`, and `SettleRequestV1` types to match what all SDK implementations already send in facilitator request bodies.
- aeef1bf: Added dynamic function for servers to generate custom response for settlement failures defaulting to empty
- 2564781: Include PAYMENT-RESPONSE header on settlement failure responses
- b341973: Remove duplicate server-local `ResourceInfo` interface; use the wire-format `ResourceInfo` from `types/payments.ts` directly throughout the server module.
- 29fe09a: Make ResourceInfo.description, ResourceInfo.mimeType, and PaymentPayload.resource optional to match v2 spec

## 2.5.0

### Minor Changes

- Bumped to align version with dependent packages (@x402/evm, @x402/extensions)

### Patch Changes

- 96a9db0: Fix extra field passthrough in buildPaymentRequirementsFromOptions for custom schemes
- d0a2b11: Added transport context to enrichSettleResponse and enrichPaymentRequiredResponse hooks

## 2.4.0

### Minor Changes

- 57a5488: Add Aptos blockchain support to x402 payment protocol

  - Introduces new `@x402/aptos` package with full client, server, and facilitator scheme implementations
  - Supports exact payment mechanism for Aptos using native APT and fungible assets
  - Includes sponsored transaction support where facilitator pays gas fees
  - Provides `registerExactAptosScheme` helpers for easy client and server integration
  - Adds Aptos network constants for mainnet and testnet
  - Updates core types to support Aptos-specific payment flows

- 018181b: Implement EIP-2612 gasless Permit2 approval extension

  - Added extension enrichment hooks to `x402Client`, enabling scheme clients to inject extension data (e.g. EIP-2612 permits) into payment payloads when the server advertises support

### Patch Changes

- 3fb55d7: Upgraded facilitator extension registration from string keys to FacilitatorExtension objects. Added FacilitatorContext threaded through SchemeNetworkFacilitator.verify/settle for mechanism access to extension capabilities

## 2.3.1

### Patch Changes

- 9ec9f15: Loosened zod optional any types to be nullable for Python interopability

## 2.3.0

### Minor Changes

- 51b8445: Added new hooks on clients & servers to improve extension extensibility
- 51b8445: Added new zod exports for type validation

## 2.0.0

- Implements x402 2.0.0 for the TypeScript SDK.

## 1.0.0

- Implements x402 1.0.0 for the TypeScript SDK.
