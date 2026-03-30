# x402 Python SDK Changelog

<!-- towncrier release notes start -->

## [2.5.0] - 2026-03-19

### Fixed

- Fixed Python HTTP middleware to return `502` instead of `500` when the facilitator responds with invalid JSON or schema-invalid data. ([#545](https://github.com/coinbase/x402/pull/545))

### Added

- Added Permit2 support to the Python SDK exact EVM mechanism with full TS/Go parity. The client routes to Permit2 (`PermitWitnessTransferFrom`) when `assetTransferMethod == "permit2"` in payment requirements extra, and the facilitator verifies and settles via the `x402ExactPermit2Proxy` contract. Includes `eip2612GasSponsoring` and `erc20ApprovalGasSponsoring` extension support for gasless Permit2 approval flows, universal signature verification via `signer.verify_typed_data` (EOA + EIP-1271 + ERC-6492), and `settleWithPermit` settlement path. Added E2E `/protected-permit2`, `/protected-permit2-eip2612`, and `/protected-permit2-erc20` endpoints to Flask server, and updated httpx client for cross-language Permit2 testing. ([#689](https://github.com/coinbase/x402/pull/689))


## [2.4.0] - 2026-03-16

### Fixed

- Fixed paywall config injection targeting </body> causing SVG parse errors in the browser ([#1550](https://github.com/coinbase/x402/pull/1550))

### Added

- Simulate transaction in verify and (optional) settle; Added multicall utility for efficient rpc calls; Fixed undeployed smart wallet handling to prevent facilitator grieving and account for implementation dependent verifyTypedData; Enforce strict amount equality per spec in evm exact; Fix extra field passthrough in resource configs ([#1474](https://github.com/coinbase/x402/pull/1474))


## [2.3.0] - 2026-03-06

### Fixed

- Add in-memory SettlementCache to prevent duplicate SVM transaction settlement during on-chain confirmation window ([#svm-duplicate-settlement](https://github.com/coinbase/x402/pull/svm-duplicate-settlement))
- Added serialize_by_alias=True to BaseX402Model so model_dump_json() produces spec-compliant camelCase by default ([#1120](https://github.com/coinbase/x402/pull/1120))
- Auto-wrap eth_account LocalAccount in EthAccountSigner when passed to ExactEvmScheme or ExactEvmSchemeV1 ([#1121](https://github.com/coinbase/x402/pull/1121))
- Added assetTransferMethod and supportsEip2612 flag to defaultAssets ([#1359](https://github.com/coinbase/x402/pull/1359))
- Added dynamic function for servers to generate custom response for settlement failures defaulting to empty ([#1430](https://github.com/coinbase/x402/pull/1430))

### Added

- Separated v1 legacy network name resolution from v2 CAIP-2 resolution; get_evm_chain_id now only accepts eip155:CHAIN_ID format, v1 code uses evm.v1.utils ([#split-v1-v2-networks](https://github.com/coinbase/x402/pull/split-v1-v2-networks))


## [2.2.0] - 2026-02-20

### Fixed

- Fixed SVM V1 client transaction signing to use `VersionedTransaction.populate()` with explicit signature slots, matching the V2 approach and fixing "not enough signers" errors. ([#v1-svm-signers](https://github.com/coinbase/x402/pull/v1-svm-signers))
- Added payment-identifier extension for tracking and validating payment identifiers ([#1111](https://github.com/coinbase/x402/pull/1111))

### Added

- Upgraded facilitator extension registration from string keys to FacilitatorExtension dataclass. Added FacilitatorContext passed through SchemeNetworkFacilitator.verify/settle for mechanism access to extension capabilities. ([#facilitator-extension-objects](https://github.com/coinbase/x402/pull/facilitator-extension-objects))
- Increased EVM validAfter buffer from 30 seconds to 10 minutes for consistency with TypeScript SDK. ([#validafter-buffer](https://github.com/coinbase/x402/pull/validafter-buffer))


## [2.1.0] - 2026-02-11

### Added

- Add MegaETH mainnet (chain ID 4326) support with USDM as the default stablecoin ([#megaeth-support](https://github.com/coinbase/x402/pull/megaeth-support))
- Added memo instruction with random nonce to SVM transactions to ensure uniqueness and prevent duplicate transaction attacks ([#1048](https://github.com/coinbase/x402/pull/1048))
- Added MCP transport integration for x402 payment protocol ([#1131](https://github.com/coinbase/x402/pull/1131))


## 2.0.0
- Implements x402 2.0.0 for the Python SDK.

## 1.0.0
- Implements x402 1.0.0 for the Python SDK.
