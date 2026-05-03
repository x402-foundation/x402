# x402 Python SDK Changelog

<!-- towncrier release notes start -->

## [2.9.0] - 2026-04-27

### Added

- Added `extensions` parameter to MCP payment wrapper config and `declare_mcp_discovery_extension` helper so paid MCP tools can declare Bazaar discovery metadata and appear in `/discovery/resources`. ([#2087](https://github.com/x402-foundation/x402/pull/2087))


## [2.8.0] - 2026-04-17

### Added

- Add Arbitrum One (chain ID 42161) and Arbitrum Sepolia (chain ID 421614) support with USDC as the default stablecoin ([#1877](https://github.com/x402-foundation/x402/pull/1877))
- Add `upto` scheme support for Python SDK, including EVM client, server, and facilitator implementations with partial settlement support ([#2023](https://github.com/x402-foundation/x402/pull/2023))


## [2.7.0] - 2026-04-13

### Added

- Add optional `extra.memo` support to SVM exact scheme. When present, the client uses the seller-provided memo as Memo instruction data instead of a random nonce, and the facilitator verifies the memo content matches. ([#1682](https://github.com/x402-foundation/x402/pull/1682))


## [2.6.0] - 2026-04-02

### Fixed

- Fixed author attribution to reference x402 Foundation instead of Coinbase ([#123](https://github.com/x402-foundation/x402/pull/123))
- Fixed race condition in lazy facilitator initialization for FastAPI and Flask middleware under concurrent requests. ([#1584](https://github.com/x402-foundation/x402/pull/1584))
- Fix extra: null incompatibility between python facilitator and TS zod schema ([#1762](https://github.com/x402-foundation/x402/pull/1762))

### Added

- Add Mezo Testnet (chain ID 31611) support with mUSD as the default stablecoin ([#mezo-testnet-default-asset](https://github.com/x402-foundation/x402/pull/mezo-testnet-default-asset))
- Add Polygon mainnet (chain ID 137) support with USDC as the default stablecoin ([#polygon-support](https://github.com/x402-foundation/x402/pull/polygon-support))
- Add Stable mainnet (chain ID 988) support with USDT0 as the default stablecoin ([#stable-support](https://github.com/x402-foundation/x402/pull/stable-support))
- Add Stable testnet (chain ID 2201) support with USDT0 as the default stablecoin ([#stable-testnet-support](https://github.com/x402-foundation/x402/pull/stable-testnet-support))
- Added dynamic route support to the Bazaar discovery extension — servers can now declare ``[param]`` route segments that consolidate to a single catalog entry per route template, with automatic ``pathParams`` enrichment and ``:param``-style ``routeTemplate`` in discovery output. ([#424](https://github.com/x402-foundation/x402/pull/424))


## [2.5.0] - 2026-03-19

### Fixed

- Fixed Python HTTP middleware to return `502` instead of `500` when the facilitator responds with invalid JSON or schema-invalid data. ([#545](https://github.com/x402-foundation/x402/pull/545))

### Added

- Added Permit2 support to the Python SDK exact EVM mechanism with full TS/Go parity. The client routes to Permit2 (`PermitWitnessTransferFrom`) when `assetTransferMethod == "permit2"` in payment requirements extra, and the facilitator verifies and settles via the `x402ExactPermit2Proxy` contract. Includes `eip2612GasSponsoring` and `erc20ApprovalGasSponsoring` extension support for gasless Permit2 approval flows, universal signature verification via `signer.verify_typed_data` (EOA + EIP-1271 + ERC-6492), and `settleWithPermit` settlement path. Added E2E `/protected-permit2`, `/protected-permit2-eip2612`, and `/protected-permit2-erc20` endpoints to Flask server, and updated httpx client for cross-language Permit2 testing. ([#689](https://github.com/x402-foundation/x402/pull/689))


## [2.4.0] - 2026-03-16

### Fixed

- Fixed paywall config injection targeting </body> causing SVG parse errors in the browser ([#1550](https://github.com/x402-foundation/x402/pull/1550))

### Added

- Simulate transaction in verify and (optional) settle; Added multicall utility for efficient rpc calls; Fixed undeployed smart wallet handling to prevent facilitator grieving and account for implementation dependent verifyTypedData; Enforce strict amount equality per spec in evm exact; Fix extra field passthrough in resource configs ([#1474](https://github.com/x402-foundation/x402/pull/1474))


## [2.3.0] - 2026-03-06

### Fixed

- Add in-memory SettlementCache to prevent duplicate SVM transaction settlement during on-chain confirmation window ([#svm-duplicate-settlement](https://github.com/x402-foundation/x402/pull/svm-duplicate-settlement))
- Added serialize_by_alias=True to BaseX402Model so model_dump_json() produces spec-compliant camelCase by default ([#1120](https://github.com/x402-foundation/x402/pull/1120))
- Auto-wrap eth_account LocalAccount in EthAccountSigner when passed to ExactEvmScheme or ExactEvmSchemeV1 ([#1121](https://github.com/x402-foundation/x402/pull/1121))
- Added assetTransferMethod and supportsEip2612 flag to defaultAssets ([#1359](https://github.com/x402-foundation/x402/pull/1359))
- Added dynamic function for servers to generate custom response for settlement failures defaulting to empty ([#1430](https://github.com/x402-foundation/x402/pull/1430))

### Added

- Separated v1 legacy network name resolution from v2 CAIP-2 resolution; get_evm_chain_id now only accepts eip155:CHAIN_ID format, v1 code uses evm.v1.utils ([#split-v1-v2-networks](https://github.com/x402-foundation/x402/pull/split-v1-v2-networks))


## [2.2.0] - 2026-02-20

### Fixed

- Fixed SVM V1 client transaction signing to use `VersionedTransaction.populate()` with explicit signature slots, matching the V2 approach and fixing "not enough signers" errors. ([#v1-svm-signers](https://github.com/x402-foundation/x402/pull/v1-svm-signers))
- Added payment-identifier extension for tracking and validating payment identifiers ([#1111](https://github.com/x402-foundation/x402/pull/1111))

### Added

- Upgraded facilitator extension registration from string keys to FacilitatorExtension dataclass. Added FacilitatorContext passed through SchemeNetworkFacilitator.verify/settle for mechanism access to extension capabilities. ([#facilitator-extension-objects](https://github.com/x402-foundation/x402/pull/facilitator-extension-objects))
- Increased EVM validAfter buffer from 30 seconds to 10 minutes for consistency with TypeScript SDK. ([#validafter-buffer](https://github.com/x402-foundation/x402/pull/validafter-buffer))


## [2.1.0] - 2026-02-11

### Added

- Add MegaETH mainnet (chain ID 4326) support with USDM as the default stablecoin ([#megaeth-support](https://github.com/x402-foundation/x402/pull/megaeth-support))
- Added memo instruction with random nonce to SVM transactions to ensure uniqueness and prevent duplicate transaction attacks ([#1048](https://github.com/x402-foundation/x402/pull/1048))
- Added MCP transport integration for x402 payment protocol ([#1131](https://github.com/x402-foundation/x402/pull/1131))


## 2.0.0
- Implements x402 2.0.0 for the Python SDK.

## 1.0.0
- Implements x402 1.0.0 for the Python SDK.
