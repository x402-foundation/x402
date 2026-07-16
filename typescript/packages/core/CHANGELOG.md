# @x402/core Changelog

## 2.18.0

### Patch Changes

- [a3ad102](https://github.com/x402-foundation/x402/commit/a3ad102): Fixed cross-SDK MCP interop: optional `PaymentRequired`/`ResourceInfo`/`PaymentPayload` wire fields serialized as explicit `null` by the Python and Go SDKs are now accepted and normalized to `undefined` instead of failing validation. The MCP client routes both result and error extraction through `parsePaymentRequired`, so 402 responses from other implementations reliably trigger auto-payment. ([#2774](https://github.com/x402-foundation/x402/pull/2774)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.17.0

### Minor Changes

- [266b19d](https://github.com/x402-foundation/x402/commit/266b19d): Added an optional `validateFacilitatorSupport` hook to `SchemeNetworkServer` and wired it into `x402ResourceServer.initialize()`. After supported kinds are loaded, each registered scheme that the facilitator actually supports is asked to validate the advertised capabilities against its own configuration; any reported problems are aggregated and thrown so misconfigurations fail fast at server startup, not just on the first protected request. ([#2700](https://github.com/x402-foundation/x402/pull/2700)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.16.0

### Minor Changes

- [59ac597](https://github.com/x402-foundation/x402/commit/59ac597): Added a dynamicInfoFields capability so an extension can mark certain info fields (nonces, timestamps) as regenerated per PaymentRequired response. Those fields are then excluded from the client-echo validatio (extension_echo_mismatch), while all other fields stay strictly compared. Wired into the offer-receipt (["offers"]) and sign-in-with-x (["nonce", "issuedAt", "expirationTime"]) extensions. ([#2653](https://github.com/x402-foundation/x402/pull/2653)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.15.0

### Minor Changes

- [bfa580e](https://github.com/x402-foundation/x402/commit/bfa580e): Add transport-agnostic `parsePaymentResult` and simplify the parsed result to `HTTPResourceResponse` (`{ status, body, header }`), where `header` is the decoded `SettleResponse` (from `PAYMENT-RESPONSE`) or `PaymentRequired` (from `PAYMENT-REQUIRED`, whose `error` carries the server's failure reason). This lets clients surface server-delivered payment errors without branching. ([#2558](https://github.com/x402-foundation/x402/pull/2558)) - Thanks [@phdargen](https://github.com/phdargen)!

### Patch Changes

- [3a60816](https://github.com/x402-foundation/x402/commit/3a60816): Harden wildcard route and network pattern matching. ([#2541](https://github.com/x402-foundation/x402/pull/2541)) - Thanks [@skyc1e](https://github.com/skyc1e)!
- [7539e93](https://github.com/x402-foundation/x402/commit/7539e93): Fixed client extension echo merging to preserve server-declared extension fields while adding client-provided extension data ([#2561](https://github.com/x402-foundation/x402/pull/2561)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.14.0

### Minor Changes

- be788e0: Thread Bazaar service metadata from HTTP `RouteConfig` and MCP `PaymentWrapperConfig` into `PaymentRequired.resource`, and extend bazaar facilitator discovery/catalog types so verified payments persist description, MIME type, service metadata, and echoed extension payloads.
- 0af31dd: Added startup-time JSON-schema validation for bazaar discovery extensions in middleware packages; Removed shallow bazaar validation from core in favor of full schema validation using the extensions package validator

## 2.13.0

### Minor Changes

- 49ea054: Add extension hook adapters for client and HTTP flows
- ad08a9a: Preserve %2F/%5C in normalizePath so encoded path separators can no longer hide segment boundaries from :param route regexes, closing a paywall bypass on requests like /api/report/a%2Fb.
- 5fca9f3: Allow paymentPayload.accepted.extra to include additive client fields, while all server-declared fields still have to match
- 95f2094: Replace the dynamic fallback paywall HTML (used when @x402/paywall is not installed) with a static template, eliminating reflected XSS surface from interpolated request URLs and config values.

## 2.12.0

### Minor Changes

- 608034f: Added Bazaar service metadata fields (`serviceName`, `tags`, `iconUrl`) on `ResourceInfo`, plus `isValidServiceName` / `sanitizeTags` / `isValidIconUrl` / `sanitizeResourceServiceMetadata` helpers in `@x402/extensions/bazaar` that `extractDiscoveryInfo` now applies with soft-drop semantics. Fields are optional and additive — providers that omit them produce byte-identical 402 bodies.
- 45d7d19: - Extended scheme surface with optional schemeHooks
  - Added skip primitives to verify/route/settle for custom flows
  - Added VerifyResponse / SettleResponse extra
  - Added onPaymentResponse client hook and processPaymentResult utility
- d235050: Log the `EXTENSION-RESPONSES` header from facilitator verify/settle responses. The HTTP facilitator client decodes the header and logs allowlisted fields (`status`, `rejectedReason`, `reason`, `code`) without attaching data to `VerifyResponse` or `SettleResponse`.

## 2.11.0

### Minor Changes

- a051f48: Enables `ResourceServerExtension` to register resource-server verify/settle hooks, and enforces extension mutation policy: `enrichPaymentRequiredResponse` may only change `payTo` / `amount` / `asset` when those baseline values are vacant; `scheme` / `network` / `maxTimeoutSeconds` and baseline `extra` entries are immutable. `enrichSettlementResponse` may not rewrite facilitator core fields (`success`, `transaction`, `network`, etc.). Lifecycle hook contexts are typed as read-only for core protocol fields.
- dc04108: Fixed a bug affecting USD prices with 7+ decimal places of precision (e.g. `$0.0000001` or smaller).

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
