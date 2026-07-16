# @x402/fastify

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
