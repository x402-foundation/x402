# @x402/fastify

## 2.9.0

### Minor Changes

- bd42498: Added Fastify framework adapter for x402 payment middleware
- 2250cae: Migrated project from coinbase/x402 to x402-foundation/x402 organization

### Patch Changes

- a0ec8e6: Applied monkey-patch on reply.raw write operations and buffered response to prevent content leak from direct raw writes bypassing Fastify's onSend lifecycle
- Updated dependencies [8cf3fca]
- Updated dependencies [c0e3969]
- Updated dependencies [2250cae]
- Updated dependencies [d352574]
  - @x402/core@2.9.0
  - @x402/paywall@2.9.0
  - @x402/extensions@2.9.0
