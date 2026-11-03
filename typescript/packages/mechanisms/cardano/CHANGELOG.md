# @x402/cardano

## 2.29.0

### Minor Changes

- Updated dependencies [636f585](https://github.com/x402-foundation/x402/commit/636f585)
- Updated dependencies [76f2f28](https://github.com/x402-foundation/x402/commit/76f2f28)
- Updated dependencies [732c181](https://github.com/x402-foundation/x402/commit/732c181)
- Updated dependencies [8c2b431](https://github.com/x402-foundation/x402/commit/8c2b431)
- Updated dependencies [3525075](https://github.com/x402-foundation/x402/commit/3525075)
- Updated dependencies [e95b066](https://github.com/x402-foundation/x402/commit/e95b066)
- Updated dependencies [3bd3c1d](https://github.com/x402-foundation/x402/commit/3bd3c1d)
- Updated dependencies [bc31d3e](https://github.com/x402-foundation/x402/commit/bc31d3e)
- Updated dependencies [db2c98e](https://github.com/x402-foundation/x402/commit/db2c98e)
- Updated dependencies [7abd80f](https://github.com/x402-foundation/x402/commit/7abd80f)
- Updated dependencies [fa5eb06](https://github.com/x402-foundation/x402/commit/fa5eb06)
- Updated dependencies [3ca54cb](https://github.com/x402-foundation/x402/commit/3ca54cb)
- Updated dependencies [b609bf5](https://github.com/x402-foundation/x402/commit/b609bf5)
- Updated dependencies [8065278](https://github.com/x402-foundation/x402/commit/8065278)
  - @x402/core@2.29.0

### Patch Changes

- [d8e1e7b](https://github.com/x402-foundation/x402/commit/d8e1e7b): The reference facilitator signer now broadcasts the client's signed transaction byte-for-byte through the provider's raw-CBOR endpoint (Blockfrost `/tx/submit`, Koios `/submittx`). It previously decoded and re-encoded the transaction, which tags untagged Conway sets with 258; that changed the body hash, so valid payments built by cardano-cli and other wallets were rejected with `MissingVKeyWitnessesUTXOW`. ([#3674](https://github.com/x402-foundation/x402/pull/3674)) - Thanks [@let-the-dreamers-rise](https://github.com/let-the-dreamers-rise)!

## 2.28.0

### Minor Changes

- Updated dependencies
  - @x402/core@2.28.0

## 2.27.0

### Minor Changes

- Updated dependencies [5d3a2b2](https://github.com/x402-foundation/x402/commit/5d3a2b2)
  - @x402/core@2.27.0

## 2.26.0

- Implement x402 v2 protocol support for the Cardano mechanism (exact scheme).
