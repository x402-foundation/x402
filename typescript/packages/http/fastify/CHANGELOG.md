# @x402/fastify

## 2.29.0

### Minor Changes

- Updated dependencies [636f585](https://github.com/x402-foundation/x402/commit/636f585)
- Updated dependencies [c1212ca](https://github.com/x402-foundation/x402/commit/c1212ca)
- Updated dependencies [87a9877](https://github.com/x402-foundation/x402/commit/87a9877)
- Updated dependencies [b70da0d](https://github.com/x402-foundation/x402/commit/b70da0d)
- Updated dependencies [76f2f28](https://github.com/x402-foundation/x402/commit/76f2f28)
- Updated dependencies [1566e13](https://github.com/x402-foundation/x402/commit/1566e13)
- Updated dependencies [732c181](https://github.com/x402-foundation/x402/commit/732c181)
- Updated dependencies [8c2b431](https://github.com/x402-foundation/x402/commit/8c2b431)
- Updated dependencies [deeb1f4](https://github.com/x402-foundation/x402/commit/deeb1f4)
- Updated dependencies [3525075](https://github.com/x402-foundation/x402/commit/3525075)
- Updated dependencies [e95b066](https://github.com/x402-foundation/x402/commit/e95b066)
- Updated dependencies [3bd3c1d](https://github.com/x402-foundation/x402/commit/3bd3c1d)
- Updated dependencies [43aaecb](https://github.com/x402-foundation/x402/commit/43aaecb)
- Updated dependencies [a9772e5](https://github.com/x402-foundation/x402/commit/a9772e5)
- Updated dependencies [43aaecb](https://github.com/x402-foundation/x402/commit/43aaecb)
- Updated dependencies [bc31d3e](https://github.com/x402-foundation/x402/commit/bc31d3e)
- Updated dependencies [db2c98e](https://github.com/x402-foundation/x402/commit/db2c98e)
- Updated dependencies [7abd80f](https://github.com/x402-foundation/x402/commit/7abd80f)
- Updated dependencies [fa5eb06](https://github.com/x402-foundation/x402/commit/fa5eb06)
- Updated dependencies [374216b](https://github.com/x402-foundation/x402/commit/374216b)
- Updated dependencies [3ca54cb](https://github.com/x402-foundation/x402/commit/3ca54cb)
- Updated dependencies [b609bf5](https://github.com/x402-foundation/x402/commit/b609bf5)
- Updated dependencies [8065278](https://github.com/x402-foundation/x402/commit/8065278)
  - @x402/core@2.29.0
  - @x402/extensions@2.29.0
  - @x402/paywall@2.29.0

### Patch Changes

- [606ced0](https://github.com/x402-foundation/x402/commit/606ced0): Fixed a payment gate bypass in `@x402/fastify`: an HTTP/1.1 request using an absolute-form request-target (e.g. `GET https://attacker.com/protected-route HTTP/1.1`, per RFC 7230 §5.3.2) let `request.url` retain the scheme and authority, causing the route-matching regex to fail and skip payment verification, while Fastify's router (`find-my-way`) still stripped the prefix and dispatched to the protected handler. Path extraction in `FastifyAdapter.getPath()` and the `onRequest` hook now mirrors find-my-way's own stripping logic so the payment gate and the router always agree on the routed path. ([#3577](https://github.com/x402-foundation/x402/pull/3577)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
- [00900b3](https://github.com/x402-foundation/x402/commit/00900b3): Fixed protected Fastify routes hanging after buffered `reply.raw.end()` calls by resuming the response lifecycle. ([#3548](https://github.com/x402-foundation/x402/pull/3548)) - Thanks [@sunruize93-cmyk](https://github.com/sunruize93-cmyk)!
- [606ced0](https://github.com/x402-foundation/x402/commit/606ced0): The Fastify payment middleware now rejects, with `400 Bad Request`, any request whose target does not start with `/` (absolute-form such as `https://host/protected-route`, `HTTPS://…`, `https://host?x=/protected-route`, etc.) before route matching. The two `find-my-way` versions Fastify 5 allows (9.5–9.8 and 9.9+) resolve these targets to different paths, so the payment gate could disagree with the router and skip payment for a route the router still served. ([#3577](https://github.com/x402-foundation/x402/pull/3577)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
- [374216b](https://github.com/x402-foundation/x402/commit/374216b): Raise runtime and peer dependency floors so installs no longer resolve known-vulnerable releases of axios, express, hono, fastify, Next.js, the MCP SDK, ajv, and the Hedera SDK. ([#3981](https://github.com/x402-foundation/x402/pull/3981)) - Thanks [@phdargen](https://github.com/phdargen) and [@cursoragent](https://github.com/cursoragent)!

## 2.28.0

### Minor Changes

- Updated dependencies [dd89698](https://github.com/x402-foundation/x402/commit/dd89698)
  - @x402/paywall@2.28.0
  - @x402/core@2.28.0
  - @x402/extensions@2.28.0

## 2.27.0

### Minor Changes

- Updated dependencies [5d3a2b2](https://github.com/x402-foundation/x402/commit/5d3a2b2)
  - @x402/core@2.27.0
  - @x402/extensions@2.27.0
  - @x402/paywall@2.27.0

### Patch Changes

- [5d3a2b2](https://github.com/x402-foundation/x402/commit/5d3a2b2): HTTP resource servers now match protected routes against both the escaped request path and the framework's decoded routing view, requiring payment if either matches. A literal route such as `GET /api/premium` could previously be reached unpaid by encoding its path separator (`/api%2Fpremium`) when the adapter only consulted the escaped path while the framework dispatched on the decoded one. ([#3542](https://github.com/x402-foundation/x402/pull/3542)) - Thanks [@PhilBot402](https://github.com/PhilBot402) and [@phdargen](https://github.com/phdargen)!

## 2.26.0

### Minor Changes

- Updated dependencies [76fe973](https://github.com/x402-foundation/x402/commit/76fe973)
- Updated dependencies [8ae5ff6](https://github.com/x402-foundation/x402/commit/8ae5ff6)
  - @x402/core@2.26.0
  - @x402/extensions@2.26.0
  - @x402/paywall@2.26.0

## 2.25.0

### Minor Changes

- Updated dependencies [a140d2b](https://github.com/x402-foundation/x402/commit/a140d2b)
- Updated dependencies [1bc2ae8](https://github.com/x402-foundation/x402/commit/1bc2ae8)
- Updated dependencies [299b9bc](https://github.com/x402-foundation/x402/commit/299b9bc)
- Updated dependencies [bbcb974](https://github.com/x402-foundation/x402/commit/bbcb974)
  - @x402/extensions@2.25.0
  - @x402/core@2.25.0
  - @x402/paywall@2.25.0

### Patch Changes

- [299b9bc](https://github.com/x402-foundation/x402/commit/299b9bc): Exit the process when eager facilitator sync fails with a permanent capability or route-configuration error, instead of staying up until the first paid request. Transient facilitator timeouts remain retryable. ([#3346](https://github.com/x402-foundation/x402/pull/3346)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.24.0

### Minor Changes

- Updated dependencies [6557149](https://github.com/x402-foundation/x402/commit/6557149)
  - @x402/paywall@2.24.0
  - @x402/core@2.24.0
  - @x402/extensions@2.24.0

## 2.23.0

### Minor Changes

- Updated dependencies [79b6259](https://github.com/x402-foundation/x402/commit/79b6259)
- Updated dependencies [4f58723](https://github.com/x402-foundation/x402/commit/4f58723)
- Updated dependencies [ab1a31a](https://github.com/x402-foundation/x402/commit/ab1a31a)
- Updated dependencies [c2612d3](https://github.com/x402-foundation/x402/commit/c2612d3)
- Updated dependencies [656437e](https://github.com/x402-foundation/x402/commit/656437e)
  - @x402/core@2.23.0
  - @x402/paywall@2.23.0
  - @x402/extensions@2.23.0

## 2.22.0

### Minor Changes

- [db5da2e](https://github.com/x402-foundation/x402/commit/db5da2e): Validate unsupported `paymentFlow` / `assetTransferMethod` at HTTP server construction and MCP `createPaymentWrapper` when the scheme is registered, and return a generic internal error from HTTP adapters and MCP wrappers for unexpected failures instead of leaking internal error details to clients. ([#3053](https://github.com/x402-foundation/x402/pull/3053)) - Thanks [@phdargen](https://github.com/phdargen)!
- [db5da2e](https://github.com/x402-foundation/x402/commit/db5da2e): Require ATM-keyed `paymentFlows` (and `defaultAssetTransferMethod`) on every `SchemeNetworkServer`. Core resolves ATM/flow from the table, rejects unsupported combinations, and always signals non-`authorization` `paymentFlow` on the 402 wire. All schemes currently declare `authorization` only. ([#3053](https://github.com/x402-foundation/x402/pull/3053)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies [37412e7](https://github.com/x402-foundation/x402/commit/37412e7)
- Updated dependencies [db5da2e](https://github.com/x402-foundation/x402/commit/db5da2e)
- Updated dependencies [db5da2e](https://github.com/x402-foundation/x402/commit/db5da2e)
- Updated dependencies [1601942](https://github.com/x402-foundation/x402/commit/1601942)
  - @x402/core@2.22.0
  - @x402/extensions@2.22.0
  - @x402/paywall@2.22.0

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
