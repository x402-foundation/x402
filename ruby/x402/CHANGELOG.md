# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial implementation of x402 Ruby SDK
- Core components: Client, ResourceServer, Facilitator
- EVM mechanism with EIP-3009 and EIP-712 support
  - Networks: Ethereum, Base, Polygon, Avalanche, MegaETH
  - Private key signer implementation
- SVM mechanism with basic Solana support
  - Networks: Solana mainnet, devnet, testnet
  - Ed25519 signer implementation
- HTTP layer with Faraday client
- Rack middleware for universal web framework integration
- Policy system for client (prefer_network, prefer_scheme, max_amount)
- Lifecycle hooks for all operations (before/after/on_failure)
- Type-safe schemas with dry-struct and automatic camelCase JSON serialization
- Comprehensive test suite (unit and integration tests)
- Complete documentation (README, CLIENT.md, SERVER.md, FACILITATOR.md, CONTRIBUTING.md)

### Dependencies
- Core: dry-struct (~> 1.6), dry-types (~> 1.7), faraday (~> 2.0)
- Optional EVM: eth (~> 0.5)
- Optional SVM: base58, ed25519
- Optional Web: rack (~> 3.0)

## [0.1.0] - TBD

Initial release.

[Unreleased]: https://github.com/x402/x402/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/x402/x402/releases/tag/v0.1.0
