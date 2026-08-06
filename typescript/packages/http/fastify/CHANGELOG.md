# @x402/fastify

## 2.21.0

### Minor Changes

- Updated dependencies [242d6e9](https://github.com/x402-foundation/x402/commit/242d6e9)
- Updated dependencies [e805616](https://github.com/x402-foundation/x402/commit/e805616)
- Updated dependencies [e805616](https://github.com/x402-foundation/x402/commit/e805616)
- Updated dependencies [e335d4f](https://github.com/x402-foundation/x402/commit/e335d4f)
- Updated dependencies [183b270](https://github.com/x402-foundation/x402/commit/183b270)
- Updated dependencies [6b04d5e](https://github.com/x402-foundation/x402/commit/6b04d5e)
- Updated dependencies [ee1b148](https://github.com/x402-foundation/x402/commit/ee1b148)
- Updated dependencies [e805616](https://github.com/x402-foundation/x402/commit/e805616)
- Updated dependencies [5192e50](https://github.com/x402-foundation/x402/commit/5192e50)
  - @x402/paywall@2.21.0
  - @x402/extensions@2.21.0
  - @x402/core@2.21.0

### Patch Changes

- [183b270](https://github.com/x402-foundation/x402/commit/183b270): Add a configurable per-request timeout to `HTTPFacilitatorClient` (`FacilitatorConfig.timeoutMs`, default 30s, matching the Go and Python facilitator clients; must be a positive integer of at most 2^31 - 1 milliseconds). `verify()`, `settle()`, and each `getSupported()` attempt now reject with a typed `FacilitatorTimeoutError` — a `FacilitatorResponseError` subclass the HTTP middlewares already surface as a 502 — instead of hanging indefinitely when a facilitator accepts a connection but never completes the response. A `settle()` timeout is indeterminate: the facilitator may still have completed the settlement. The Hono, Express, Fastify, and Next middlewares now attach a rejection handler to the eagerly created facilitator initialization promise, so an initialization failure before the first protected request no longer surfaces as an unhandled rejection; the first protected request still observes the failure and retries initialization. ([#2974](https://github.com/x402-foundation/x402/pull/2974)) - Thanks [@notorious-d-e-v](https://github.com/notorious-d-e-v)!
- [ee1b148](https://github.com/x402-foundation/x402/commit/ee1b148): Set Cache-Control on x402 HTTP payment responses: `no-store` on 402/412 PAYMENT-REQUIRED and settlement failures, and merge `private` on 200 PAYMENT-RESPONSE success so shared caches cannot store user-specific settlement metadata. ([#2990](https://github.com/x402-foundation/x402/pull/2990)) - Thanks [@phdargen](https://github.com/phdargen)!
- [5192e50](https://github.com/x402-foundation/x402/commit/5192e50): Fixed a payment bypass on wildcard (`*`) route patterns: the compiled route regex used `.*?` without the dotAll flag, so a percent-encoded ECMAScript line terminator (e.g. `%E2%80%A8`, `%0A`, `%0D`) surviving path normalization would fail to match, causing `requiresPayment()` to return `false` and the middleware to skip payment verification and settlement entirely. The route regex now compiles with the dotAll flag so wildcard segments match any character, including line terminators. ([#3036](https://github.com/x402-foundation/x402/pull/3036)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!

## 2.20.0

### Minor Changes

- Updated dependencies [b7bfa69](https://github.com/x402-foundation/x402/commit/b7bfa69)
- Updated dependencies [4453a92](https://github.com/x402-foundation/x402/commit/4453a92)
- Updated dependencies [32464a2](https://github.com/x402-foundation/x402/commit/32464a2)
  - @x402/extensions@2.20.0
  - @x402/core@2.20.0
  - @x402/paywall@2.20.0

## 2.19.0

### Minor Changes

- Updated dependencies [c72cfee](https://github.com/x402-foundation/x402/commit/c72cfee)
- Updated dependencies [21b0745](https://github.com/x402-foundation/x402/commit/21b0745)
- Updated dependencies [c1f2d90](https://github.com/x402-foundation/x402/commit/c1f2d90)
  - @x402/core@2.19.0
  - @x402/extensions@2.19.0
  - @x402/paywall@2.19.0

## 2.18.0

### Minor Changes

- Updated dependencies [a3ad102](https://github.com/x402-foundation/x402/commit/a3ad102)
  - @x402/core@2.18.0
  - @x402/extensions@2.18.0
  - @x402/paywall@2.18.0

## 2.17.0

### Minor Changes

- Updated dependencies [266b19d](https://github.com/x402-foundation/x402/commit/266b19d)
  - @x402/core@2.17.0
  - @x402/paywall@2.17.0
  - @x402/extensions@2.17.0

## 2.16.0

### Minor Changes

- Updated dependencies [59ac597](https://github.com/x402-foundation/x402/commit/59ac597)
  - @x402/core@2.16.0
  - @x402/extensions@2.16.0
  - @x402/paywall@2.16.0

## 2.15.0

### Minor Changes

- Updated dependencies [ae0bf9b](https://github.com/x402-foundation/x402/commit/ae0bf9b)
- Updated dependencies [bfa580e](https://github.com/x402-foundation/x402/commit/bfa580e)
- Updated dependencies [6acb8fc](https://github.com/x402-foundation/x402/commit/6acb8fc)
- Updated dependencies [3a60816](https://github.com/x402-foundation/x402/commit/3a60816)
- Updated dependencies [7539e93](https://github.com/x402-foundation/x402/commit/7539e93)
  - @x402/extensions@2.15.0
  - @x402/core@2.15.0
  - @x402/paywall@2.15.0

### Patch Changes

- [4ddba37](https://github.com/x402-foundation/x402/commit/4ddba37): Strip internal settlement-overrides header after settlement reads it, so its not exposed to the client ([#2556](https://github.com/x402-foundation/x402/pull/2556)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.14.0

### Minor Changes

- 0af31dd: Added startup-time JSON-schema validation for bazaar discovery extensions in middleware packages; Removed shallow bazaar validation from core in favor of full schema validation using the extensions package validator
- Updated dependencies [be788e0]
- Updated dependencies [0af31dd]
  - @x402/extensions@2.14.0
  - @x402/core@2.14.0
  - @x402/paywall@2.14.0

## 2.13.0

### Minor Changes

- Updated dependencies [49ea054]
- Updated dependencies [e35becf]
- Updated dependencies [ad08a9a]
- Updated dependencies [f3deb60]
- Updated dependencies [5fca9f3]
- Updated dependencies [95f2094]
- Updated dependencies [49ea054]
  - @x402/extensions@2.13.0
  - @x402/paywall@2.13.0
  - @x402/core@2.13.0

## 2.12.0

### Minor Changes

- 45d7d19: Added cancellationDispatcher for failed route handlers
- Updated dependencies [608034f]
- Updated dependencies [d235050]
- Updated dependencies [45d7d19]
- Updated dependencies [ee7c156]
  - @x402/core@2.12.0
  - @x402/extensions@2.12.0
  - @x402/paywall@2.12.0

## 2.11.0

### Minor Changes

- Updated dependencies [a051f48]
- Updated dependencies [032295b]
- Updated dependencies [dc04108]
- Updated dependencies [484030b]
  - @x402/core@2.11.0
  - @x402/paywall@2.11.0
  - @x402/extensions@2.11.0

## 2.10.1

### Patch Changes

- Fix `@x402/core` workspace resolution.

## 2.10.0

- Implements Fastify middleware
