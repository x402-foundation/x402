# x402 Python SDK Changelog

<!-- towncrier release notes start -->

## [2.15.0] - 2026-07-10

### Fixed

- Fixed Flask middleware skipping settlement on 3xx responses, allowing paid content behind redirects to be delivered without onchain payment. ([#2826](https://github.com/x402-foundation/x402/pull/2826)) - Thanks [@phdargen](https://github.com/phdargen)!
- Fixed `flask_payment_middleware_from_config`, which raised `TypeError` at construction because it built the async `x402ResourceServer` for the sync Flask middleware; it now uses `x402ResourceServerSync`. ([#2810](https://github.com/x402-foundation/x402/pull/2810)) - Thanks [@kakedashi3](https://github.com/kakedashi3)!
- Fixed cross-SDK MCP interop: the FastMCP payment wrapper now verifies and settles against the advertised `accepts` entry that matches the payment payload instead of always using the first entry, and omits `None` optional fields from serialized `PaymentRequired` results so stricter clients accept them. ([#2774](https://github.com/x402-foundation/x402/pull/2774)) - Thanks [@phdargen](https://github.com/phdargen)!

### Added

- Add Igra mainnet (eip155:38833) default stablecoin USDC via Permit2 ([#2800](https://github.com/x402-foundation/x402/pull/2800)) - Thanks [@emdin](https://github.com/emdin)!
- Added the `builder-code` extension for onchain payment attribution. Also added the enabling core capabilities: client re-merge preserving server-declared extension fields, server-side extension echo validation (with opt-in dynamic `info` fields), and EVM `data_suffix` plumbing threaded through settlement. Marked the `sign-in-with-x` extension's `nonce`, `issuedAt`, and `expirationTime` as dynamic `info` fields so regenerated challenges pass echo validation. ([#2795](https://github.com/x402-foundation/x402/pull/2795)) - Thanks [@phdargen](https://github.com/phdargen)!


## [2.14.0] - 2026-06-26

### Added

- Expanded wallet compatibility so payments verify and settle consistently across plain EOAs, deployed smart accounts (ERC-4337 / ERC-7579), counterfactual ERC-6492 wallets, and ERC-7702-delegated EOAs. Pre-verification now mirrors on-chain signature checking, so a payment that passes `verify` is the same one that succeeds at `settle`. Added counterfactual ERC-6492 support to the `exact` and `batch-settlement` flows — the wallet is deployed and its signature validated together during `verify` — gated by a new `eip6492_allowed_factories` allowlist you set on the facilitator scheme config. Also added a wallet-compatibility guide documenting which wallet and scheme combinations are supported. ([#2658](https://github.com/x402-foundation/x402/pull/2658)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe) and [@cursoragent](https://github.com/cursoragent)!
- Made the batch-settlement facilitator's receiver-authorizer signer optional: when omitted, the facilitator no longer advertises a `receiverAuthorizer` in `/supported`, and claim/refund execution returns `invalid_batch_settlement_evm_authorizer_not_configured` instead of auto-signing when a payload omits its authorizer signature. Added a fail-fast startup check on the resource server: a batch-settlement server with no `receiver_authorizer_signer` configured now raises during `initialize()` when the facilitator advertises no usable `receiverAuthorizer`. ([#2706](https://github.com/x402-foundation/x402/pull/2706)) - Thanks [@phdargen](https://github.com/phdargen)!


## [2.13.1] - 2026-06-19

### Fixed

- Cache SVM exact client mint metadata to avoid repeated mint RPC fetches. ([#2629](https://github.com/x402-foundation/x402/pull/2629)) - Thanks [@wnjoon](https://github.com/wnjoon)!


## [2.13.0] - 2026-06-12

### Fixed

- Fixed a bug where EVM facilitator verify accepted payments whose asset address was an EOA. Calling any function on an EOA via ``eth_call`` silently returns empty data without reverting, causing on-chain simulation to pass and the subsequent settlement to land as a no-op with no ``Transfer`` event emitted. The fix checks ``eth_getCode`` on the asset address early in the verify path for all EVM payment schemes (EIP-3009, Permit2 exact, Permit2 upto); any address with no bytecode is rejected with ``asset_not_deployed_contract``. ([#2554](https://github.com/x402-foundation/x402/pull/2554)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
- Run Python payment creation failure hooks when after-payment hooks raise. ([#2540](https://github.com/x402-foundation/x402/pull/2540)) - Thanks [@skyc1e](https://github.com/skyc1e)!
- Set EVM authorization ``validAfter`` to 0 to reduce onchain timing failures when payloads are queued or block timestamps lag behind client clocks. ([#2601](https://github.com/x402-foundation/x402/pull/2601)) - Thanks [@phdargen](https://github.com/phdargen)!

### Added

- Add Mezo mainnet (chain ID 31612) support with mUSD as the default stablecoin ([#2590](https://github.com/x402-foundation/x402/pull/2590)) - Thanks [@ryanRfox](https://github.com/ryanRfox)!
- Add XDC Network mainnet (chain ID 50) and Apothem testnet (chain ID 51) support with USDC as the default stablecoin ([#2597](https://github.com/x402-foundation/x402/pull/2597)) - Thanks [@AnilChinchawale](https://github.com/AnilChinchawale)!


## [2.12.0] - 2026-05-29

### Fixed

- Export documented Python MCP client factory helpers from ``x402.mcp``. ([#export-mcp-client-factories](https://github.com/x402-foundation/x402/pull/export-mcp-client-factories))
- Preserve existing FastMCP ``CallToolResult`` metadata when attaching x402 payment responses. ([#preserve-fastmcp-result-meta](https://github.com/x402-foundation/x402/pull/preserve-fastmcp-result-meta))
- Fixed SVM exact facilitator deduplication to key on the transaction message hash rather than the full signed-transaction bytes, preventing an attacker from bypassing the cache by randomizing the mutable fee-payer signature slot. ([#2482](https://github.com/x402-foundation/x402/pull/2482))
- Thread Bazaar service metadata from HTTP `RouteConfig` and MCP `PaymentWrapperConfig` into `PaymentRequired.resource`, and extend bazaar facilitator discovery/catalog types so verified payments persist description, MIME type, service metadata, and echoed extension payloads. ([#2496](https://github.com/x402-foundation/x402/pull/2496))
- **[Breaking for facilitator implementers using ERC-4337 smart wallet deployment]** Fixed ERC-6492 factory call injection vulnerability in EVM exact settlement (v1 and v2) and simplified the configuration API. The `deploy_erc4337_with_eip6492` boolean field has been removed from `ExactEvmSchemeConfig` and `ExactEvmSchemeV1Config`. `eip6492_allowed_factories: list[str]` is now the sole gate: settlement deploys an undeployed smart wallet if and only if its factory address is present in the allowlist (case-insensitive). An empty or omitted list disables the feature entirely and returns `eip6492_factory_not_allowed`. Facilitators previously using `deploy_erc4337_with_eip6492=True` must remove that parameter and populate `eip6492_allowed_factories` with every factory address they trust.

### Added

- Thread bazaar service metadata fields (`service_name`, `tags`, `icon_url`) from `RouteConfig` through to `ResourceInfo`. The wire-format schema fields landed in #2200 but the server-side `RouteConfig` had no way to populate them — servers wanting rich Bazaar listings had to bypass the SDK. This wires the missing plumbing. ([#route-config-service-metadata](https://github.com/x402-foundation/x402/pull/route-config-service-metadata))
- Added startup-time JSON-schema validation for bazaar discovery extensions in FastAPI and Flask middleware ([#671](https://github.com/x402-foundation/x402/pull/671))

### Misc

- Add unit tests for `sign_eip2612_permit` in the EIP-2612 gas sponsoring extension covering nonce read, EIP-712 domain/types/message construction, and return shape (mirrors the `sign_erc20_approval_transaction` test pattern). ([#python-eip2612-permit-signing-tests](https://github.com/x402-foundation/x402/pull/python-eip2612-permit-signing-tests))


## [2.11.0] - 2026-05-22

### Fixed

- unwrap ERC-6492 signatures for permit2 flows ([#2352](https://github.com/x402-foundation/x402/pull/2352))

### Added

- Add HPP mainnet (chain ID 190415) and HPP Sepolia (chain ID 181228) support with USDC.e (Bridged USDC) as the default stablecoin ([#add-hpp-chains-default-stablecoin](https://github.com/x402-foundation/x402/pull/add-hpp-chains-default-stablecoin))
- Add ADI Chain (chain ID 36900) support with USDC.e as the default stablecoin ([#adi-chain](https://github.com/x402-foundation/x402/pull/adi-chain))
- Added `batch-settlement-evm` scheme: an EVM payment-channel mechanism that batches multiple requests off-chain using cumulative vouchers and submits a single on-chain claim instead of one transaction per payment. Includes `BatchSettlementEvmScheme` for client and server, `BatchSettlementEvmFacilitator` for on-chain deposit, claim, and cooperative refund execution, and `BatchSettlementChannelManager` with auto-claim/settle scheduling and `FileChannelStorage` for persistent server-side channel state. ([#batch-settlement-evm](https://github.com/x402-foundation/x402/pull/batch-settlement-evm))
- Added a curated testnet faucet map to the paywall plus `PaywallConfig.faucet_urls` (per-chain override keyed by CAIP-2). Unmapped chains render "No faucet configured." instead of a fallback link. Available via `PaywallBuilder.with_config(faucet_urls=...)`. ([#2160](https://github.com/x402-foundation/x402/pull/2160))
- Added missing lifecycle hooks and extension/scheme-level adapter pattern ([#2388](https://github.com/x402-foundation/x402/pull/2388))
- Added siwx extension ([#2393](https://github.com/x402-foundation/x402/pull/2393))


## [2.10.0] - 2026-05-13

### Added

- Add Radius Network (chain ID 723487) and Radius Testnet (chain ID 72344) support with SBC as the default stablecoin ([#radius-network-default-asset](https://github.com/x402-foundation/x402/pull/radius-network-default-asset))
- Added the TVM exact-payment mechanism to the Python SDK, including client, server, facilitator, and example coverage for TON testnet/mainnet flows. ([#tvm-python-sdk](https://github.com/x402-foundation/x402/pull/tvm-python-sdk))
- Added Bazaar service metadata fields (`service_name`, `tags`, `icon_url`) on `ResourceInfo`, plus `_is_valid_service_name` / `_sanitize_tags` / `_is_valid_icon_url` / `_sanitize_resource_service_metadata` helpers in `x402.extensions.bazaar.facilitator` that `extract_discovery_info` now applies with soft-drop semantics. ([#150](https://github.com/x402-foundation/x402/pull/150))
- Log the `EXTENSION-RESPONSES` header from facilitator verify/settle responses. The HTTP facilitator client decodes the header and logs allowlisted fields (`status`, `rejectedReason`, `reason`, `code`) without attaching data to `VerifyResponse` or `SettleResponse`. ([#2161](https://github.com/x402-foundation/x402/pull/2161))

### Misc

- Expose `DEFAULT_MAX_FEE_PER_GAS` and `DEFAULT_MAX_PRIORITY_FEE_PER_GAS` from `x402.mechanisms.evm.constants` and use them as the fallback when fee estimation is unavailable in `sign_erc20_approval_transaction`. Mirrors the TypeScript SDK's named constants; numeric defaults (1 gwei / 0.1 gwei) are unchanged. ([#erc20-approval-default-gas-fees](https://github.com/x402-foundation/x402/pull/erc20-approval-default-gas-fees))


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
