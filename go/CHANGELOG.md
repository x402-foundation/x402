## v2.25.0 - 2026-09-04
### Added
- Add an optional facilitator-delegated receiver-authorizer mode to SVM `upto`. The facilitator may advertise `receiverAuthorizer` in `/supported`; a server that omits `ReceiverAuthorizerSigner` delegates voucher signing, and the facilitator signs after correlating the claim settle to the same authenticated caller that opened the channel. ([#3347](https://github.com/x402-foundation/x402/pull/3347)) - Thanks [@PhilBot402](https://github.com/PhilBot402) and [@phdargen](https://github.com/phdargen)!
- EVM exact facilitator verify can start the onchain transfer simulation concurrently with signature classification, removing one RPC round trip. Opt in with ExactEvmSchemeConfig.EnableParallelVerifySimulation (or VerifyPermit2Options.EnableParallelSimulation for direct VerifyPermit2 callers); it covers EIP-3009 and the Permit2 standard settle path. Off by default, since the tradeoff is one wasted eth_call per payment rejected on signature grounds. ([#3355](https://github.com/x402-foundation/x402/pull/3355)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
### Changed
- Speed up EVM exact and upto facilitator verify by overlapping the asset-contract GetCode with signature checks and reusing VerifyUniversalSignature's bytecode result via ERC6492SignatureData.CodeDeployed instead of a second payer GetCode ([#3312](https://github.com/x402-foundation/x402/pull/3312)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
- Exit the process when eager facilitator sync fails with a permanent capability or route-configuration error, instead of staying up until the first paid request. Transient facilitator timeouts remain retryable. ([#3347](https://github.com/x402-foundation/x402/pull/3347)) - Thanks [@PhilBot402](https://github.com/PhilBot402) and [@phdargen](https://github.com/phdargen)!
- 'EVM facilitators now cache a positive asset-contract check for 15 minutes instead of issuing a fresh eth_getCode on the payment token for every payment. Only positive results are cached, so a token observed mid-deployment still recovers on the next request. Breaking: evm.ValidateAssetIsContract takes a network argument, which scopes the cache so entries cannot collide across chains.' ([#3355](https://github.com/x402-foundation/x402/pull/3355)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
- EVM exact settle's ERC-6492 branch now reads payer deployment from the verify it already awaited rather than issuing a second eth_getCode. Both reads happen within one settle call and before any deploy transaction, so this is not the post-deploy re-read that races RPC state propagation. Settle consequently no longer emits invalid_exact_evm_failed_to_check_deployment. ([#3355](https://github.com/x402-foundation/x402/pull/3355)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
- SVM upto facilitator channel-account re-reads now back off linearly (200/400/600/800/1000ms across 6 reads) rather than doubling (200/400/800/1600ms across 5 reads). Replica lag behind a confirmed open is a small multiple of Solana's slot time, so the same 3.0s budget now buys one more read and caps any single wait at 1s. Config.ChannelReadMaxAttempts and Config.ChannelReadBackoffStep make it configurable. ([#3355](https://github.com/x402-foundation/x402/pull/3355)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
- Update commerce-payments v1.1 auth-capture deployment addresses (AuthCaptureEscrow, EIP-3009 token collector, Permit2 token collector, and OperatorRefundCollector) to the current canonical CREATE2 set on Base; v1.0 addresses are unchanged
### Fixed
- Prevented overflow when resolving large percentage settlement overrides. ([#2962](https://github.com/x402-foundation/x402/pull/2962)) - Thanks [@wnjoon](https://github.com/wnjoon)!
- Bounded buffered HTTP response bodies in Go payment, facilitator, and Bazaar clients (1 MiB for control-plane responses, 4 MiB for Bazaar discovery). ([#2973](https://github.com/x402-foundation/x402/pull/2973)) - Thanks [@wnjoon](https://github.com/wnjoon)!
- fixed Golang SDK EIP-3009 client not using paymentRequirements.maxTimeoutSeconds for validBefore ([#3282](https://github.com/x402-foundation/x402/pull/3282)) - Thanks [@Tehsapper](https://github.com/Tehsapper)!
- Expose EXTENSION-RESPONSES data to resource servers without forwarding it to buyers. ([#3301](https://github.com/x402-foundation/x402/pull/3301)) - Thanks [@wnjoon](https://github.com/wnjoon)!
- Reject undeclared or mismatched builder-code app attribution in Go resource servers and ignore payload app attribution outside v2 facilitator contexts. ([#3302](https://github.com/x402-foundation/x402/pull/3302)) - Thanks [@wnjoon](https://github.com/wnjoon)!
- Stop false-positive bazaar startup warnings for pre-enrichment HTTP extensions by injecting a synthetic method from the route pattern (or body/query inference) before JSON-schema validation, matching TypeScript middleware behavior ([#3308](https://github.com/x402-foundation/x402/pull/3308)) - Thanks [@phdargen](https://github.com/phdargen)!

## v2.24.0 - 2026-08-27
### Added
- Add Ethereum mainnet (eip155:1) and Avalanche C-Chain (eip155:43114) native USDC as default stablecoins ([#3241](https://github.com/x402-foundation/x402/pull/3241)) - Thanks [@phdargen](https://github.com/phdargen) and [@cursoragent](https://github.com/cursoragent)!
- Add Go auth-capture client with ERC-3009 and Permit2 collect payload signing ([#3283](https://github.com/x402-foundation/x402/pull/3283)) - Thanks [@phdargen](https://github.com/phdargen)!
- Add Sei mainnet (chain ID 1329) and Sei Testnet (chain ID 1328) with native USDC as the default stablecoin ([#3227](https://github.com/x402-foundation/x402/pull/3227)) - Thanks [@alexander-sei](https://github.com/alexander-sei)!
- Add simulation-based smart wallet verification to the SVM exact facilitator, behind Config.EnableSmartWalletVerification ([#3263](https://github.com/x402-foundation/x402/pull/3263)) - Thanks [@phdargen](https://github.com/phdargen)!
- Declare `upfront` payment flow support on EVM and SVM `exact` server schemes. `authorization` remains the default; servers opt in per route via `accepts.extra.paymentFlow`. ([#3240](https://github.com/x402-foundation/x402/pull/3240)) - Thanks [@phdargen](https://github.com/phdargen)!
### Changed
- Verify SVM exact payments with local Ed25519 signature checks instead of a fee-payer signing round trip; FacilitatorSvmSigner.SimulateTransaction now runs with sigVerify off, and NewExactSvmScheme takes an optional Config ([#3263](https://github.com/x402-foundation/x402/pull/3263)) - Thanks [@phdargen](https://github.com/phdargen)!
- Route SVM upto facilitator RPC through the signer instead of scheme Config.RPC/RPCURL — claim settlement simulates before send, deposit composite sim uses a placeholder blockhash with replaceRecentBlockhash, and claim overlaps channel read with blockhash prefetch ([#3274](https://github.com/x402-foundation/x402/pull/3274)) - Thanks [@phdargen](https://github.com/phdargen)!
- SVM `GetNetworkConfig` and `NetworkConfig` now hold transport endpoints only (RPC/WS). Default assets stay in `default_assets.go`. EVM bundled network config remains removed; use `GetDefaultAsset` and `GetEvmChainId`. ([#3241](https://github.com/x402-foundation/x402/pull/3241)) - Thanks [@phdargen](https://github.com/phdargen) and [@cursoragent](https://github.com/cursoragent)!
### Fixed
- Stop persisting untrusted batch-settlement channelState from PAYMENT-RESPONSE. Successful payment responses update local storage from previous state plus capped chargedAmount and any client-signed deposit, except when a present extra chargedCumulativeAmount does not equal that next cumulative — then the charge write is skipped. Onchain snapshot diffs and a missing extra cumulative do not block the write. Refunds cap the signed amount to the locally refundable balance. Failed settlements leave local state unchanged. A disagreeing server is handled by existing corrective recovery. ([#3251](https://github.com/x402-foundation/x402/pull/3251)) - Thanks [@phdargen](https://github.com/phdargen)!
- Align SVM exact Path 1 with TypeScript — accept 3–7 instructions and require exact transfer amount equality ([#3263](https://github.com/x402-foundation/x402/pull/3263)) - Thanks [@phdargen](https://github.com/phdargen)!

## v2.23.0 - 2026-08-18
### Added
- Add the SVM `upto` scheme (client, server, facilitator) for usage-based billing on Solana, backed by hand-written payment-channels program bindings in mechanisms/svm/paymentchannels. The client escrows a maximum in an onchain channel, the server signs a voucher for the metered amount, and the facilitator sponsors fees/rent, co-signs and broadcasts the open, settles the claim, and reclaims channel rent through RentCleanupManager over a pluggable ChannelStorage. Cleanup runs on a short interval from storage while the optional getProgramAccounts recovery sweep (Discover) runs on its own longer interval, and both prefer an injected *rpc.Client over the configured RPC URL so operators can route sends through their own instrumented transport ([#3141](https://github.com/x402-foundation/x402/pull/3141)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe) and [@cursoragent](https://github.com/cursoragent), [@claude](https://github.com/claude)!
- Add an SVM stablecoin registry (USDC, USDT, USDG, PYUSD, CASH) with mint, token-program, and precision lookups. The SVM `upto` server resolves a trailing price symbol (for example "1.50 PYUSD") to that stablecoin's mint and advertises the token program its mint requires, and the facilitator infers the same token program when a challenge omits `extra.tokenProgram`, so Token-2022 stablecoins work without extra configuration ([#3141](https://github.com/x402-foundation/x402/pull/3141)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe) and [@cursoragent](https://github.com/cursoragent), [@claude](https://github.com/claude)!
- Add client spend controls (default-asset allowlist and $1 USD cap) and EVM/SVM default-asset tables so USD-pegged tokens are recognized for caps and money strings. ([#3156](https://github.com/x402-foundation/x402/pull/3156)) - Thanks [@phdargen](https://github.com/phdargen) and [@cursoragent](https://github.com/cursoragent)!
### Changed
- Add a `settlement_pending` error reason for the `exact`, `upto`, and `batch-settlement` EVM schemes (v2 only; v1 is unaffected). A receipt-wait failure after a settle/claim/deposit/refund transaction broadcast (e.g. an RPC error or timeout) now returns `settlement_pending` with the broadcast transaction hash and network instead of the previous terminal error, since the transaction may still confirm on chain — callers relying on the old terminal error reason for this case should switch to handling `settlement_pending`. Settlement now also validates the broadcast transaction hash before waiting on it, so a signer that reports success without a usable hash fails terminally rather than reporting `settlement_pending` without a hash to reconcile against. An ERC-20-approval-gas-sponsoring extension signer that fails to broadcast a valid settlement transaction hash for `exact`/`upto` Permit2 settlement now reports `erc20_approval_broadcast_failed` (previously the internal-only sentinel `erc20_approval_tx_failed` could leak through as the error reason). The HTTP resource server now unwraps a `SettleError` returned by Settle instead of flattening it into `err.Error()`, so the structured error reason, payer, network, and transaction hash reach the caller and the `PAYMENT-RESPONSE` header. ([#3083](https://github.com/x402-foundation/x402/pull/3083)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe) and [@ethanoroshiba](https://github.com/ethanoroshiba), [@claude](https://github.com/claude), [@cursoragent](https://github.com/cursoragent)!
- Require ATM-keyed paymentFlows (and DefaultAssetTransferMethod) on every SchemeNetworkServer. Core resolves ATM/flow from the table, rejects unsupported combinations, and always signals non-authorization paymentFlow on the 402 wire. All schemes currently declare authorization only ([#3115](https://github.com/x402-foundation/x402/pull/3115)) - Thanks [@phdargen](https://github.com/phdargen)!
- Validate unsupported paymentFlow / assetTransferMethod at HTTP server Initialize and MCP NewPaymentWrapper when the scheme is registered; return a generic internal error from HTTP and MCP wrappers for unexpected failures; and bring MCP PaymentWrapper to HTTP-equivalent cancel/settleOnCancel, SkipHandler, CreatePaymentRequiredResponse, and extension-gated verify/settle with failure-path payment-response in _meta. Fixed SVM exact #3094 parity (dynamic recentBlockhash/lastValidBlockHeight extras, settlement-cache drop on send/confirm failure) and MCP match/validate parity (match post-enrichment accepts, extension_echo_mismatch before verify). MCP OnAfterExecution now runs on handler IsError results; hook-abort 402s omit the payment payload; GetPaymentFlow errors when no scheme is registered. ([#3115](https://github.com/x402-foundation/x402/pull/3115)) - Thanks [@phdargen](https://github.com/phdargen)!
- ParseMoney and MoneyParser now use decimal strings instead of float64; amounts too small for the asset decimals truncate to "0" instead of erroring. ([#3156](https://github.com/x402-foundation/x402/pull/3156)) - Thanks [@phdargen](https://github.com/phdargen) and [@cursoragent](https://github.com/cursoragent)!
### Fixed
- Correct Monad USDC EIP-712 domain name to "USDC" in the v1 legacy network table; v1-signed transferWithAuthorization payloads previously failed on-chain signature recovery ([#3153](https://github.com/x402-foundation/x402/pull/3153)) - Thanks [@Im-Madhur-Gupta](https://github.com/Im-Madhur-Gupta)!
- 'Harden the SVM upto facilitator and rent cleanup: clamp MaxReclaimsPerTx to a batch size proven to serialize under Solana''s packet limit, reject a non-string `extra.tokenProgram` hint instead of silently falling back to the registry, and reuse `solana.ComputeBudget` instead of a duplicated program ID constant' ([#3141](https://github.com/x402-foundation/x402/pull/3141)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe) and [@cursoragent](https://github.com/cursoragent), [@claude](https://github.com/claude)!

## v2.22.0 - 2026-08-11
### Fixed
- 'Match payment-gated routes on the escaped request path so percent-encoded separators cannot bypass the payment gate: the Echo, Gin, and net/http middlewares now pass URL.EscapedPath() instead of the decoded URL.Path, normalizePath decodes one segment at a time (re-escaping any decoded / or \) instead of decoding the whole path twice, and a trailing /* route pattern now also matches its bare prefix' ([#3044](https://github.com/x402-foundation/x402/pull/3044)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
- 'Compile route patterns with the (?s) flag so wildcard-derived `.*?` matches a line feed: normalizePath decodes %0A to a raw LF inside a segment, and without (?s) a wildcard route missed such a path while routers still dispatched it to the protected handler, skipping payment verification (Go counterpart of the TypeScript #3036 and Python #3055 dotAll fixes)' ([#3100](https://github.com/x402-foundation/x402/pull/3100)) - Thanks [@hung-yueh](https://github.com/hung-yueh)!

## v2.21.0 - 2026-08-04
### Added
- Add Celo mainnet (chain ID 42220) and Celo Sepolia (chain ID 11142220) support with USDC as the default stablecoin ([#3025](https://github.com/x402-foundation/x402/pull/3025)) - Thanks [@GigaHierz](https://github.com/GigaHierz) and [@claude](https://github.com/claude)!
- Add Flare mainnet (chain ID 14) support with USD₮0 as the default stablecoin ([#3031](https://github.com/x402-foundation/x402/pull/3031)) - Thanks [@whawk46](https://github.com/whawk46)!
- builder-code s entries now use dedicated per-party reservations (MAX_CLIENT_SERVICE_CODES=5, MAX_SERVER_SERVICE_CODES=5, MAX_FACILITATOR_SERVICE_CODES=1, summing to MAX_SERVICE_CODES=11) instead of one shared cap, and BuilderCodeFacilitatorExtension gained a new ServiceCode field so the facilitator can append its own service code at settlement ([#3027](https://github.com/x402-foundation/x402/pull/3027)) - Thanks [@ethanoroshiba](https://github.com/ethanoroshiba)!
### Fixed
- Add Cache-Control no-store to 402/412 PAYMENT-REQUIRED responses and private (merged with handler directives) on 200 PAYMENT-RESPONSE responses to prevent shared caches from storing payment signaling headers - Thanks [@Sertug17](https://github.com/Sertug17)!
- Verify matching ERC-20 Transfer logs when Go exact/eip3009 settlement receipts include logs ([#2727](https://github.com/x402-foundation/x402/pull/2727)) - Thanks [@wnjoon](https://github.com/wnjoon)!
- Registered client extensions now always receive EnrichPaymentPayload, regardless of whether the resource server advertised the extension key in PaymentRequired.Extensions. Server declarations continue to govern field preservation via merge and echo validation. Extensions that require a server declaration must no-op internally when the server did not advertise them. ([#2994](https://github.com/x402-foundation/x402/pull/2994)) - Thanks [@phdargen](https://github.com/phdargen)!
- Propagate payment response hook errors after corrective retries and close response bodies on hook failure. ([#3022](https://github.com/x402-foundation/x402/pull/3022)) - Thanks [@256dino](https://github.com/256dino)!
- Merge server and client builder-code s arrays during extension re-merge instead of dropping the client's (fully deduped, including duplicates within either side), treat echoed builder-code s specifically as additive (client-first, with scalar/array coercion) via a JSON round-trip that also handles non-[]interface{} slice types while other extensions' array fields keep exact echo matching, and let DeclareBuilderCodeExtension optionally declare service codes for the application itself ([#3027](https://github.com/x402-foundation/x402/pull/3027)) - Thanks [@ethanoroshiba](https://github.com/ethanoroshiba)!
- BuilderCodeFacilitatorExtension.BuildDataSuffix now returns an error for an invalid ServiceCode instead of silently omitting it, and ValidateExtensions now rejects a client echo whose builder-code s exceeds the combined client+server budget instead of accepting it and leaving truncation to the facilitator ([#3027](https://github.com/x402-foundation/x402/pull/3027)) - Thanks [@ethanoroshiba](https://github.com/ethanoroshiba)!
- Reject bazaar discovery extension schemas containing external "$ref"/"$id" values (anything other than a same-document "#" fragment) before validation, preventing an attacker-controlled schema from triggering an outbound HTTP request or local file read (SSRF/LFI, CWE-918) ([#3039](https://github.com/x402-foundation/x402/pull/3039)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!

## v2.20.0 - 2026-07-27
### Added
- Support server-provided recent blockhashes for Go SVM exact payment challenges ([#2731](https://github.com/x402-foundation/x402/pull/2731)) - Thanks [@wnjoon](https://github.com/wnjoon)!
### Changed
- 'Cap builder-code service codes (`s`) to five onchain entries at settlement. Facilitators now truncate excess valid codes, the server schema advertises `maxItems: 5`, and `MAX_SERVICE_CODES` is exported.' ([#2912](https://github.com/x402-foundation/x402/pull/2912)) - Thanks [@phdargen](https://github.com/phdargen)!
### Fixed
- Return a spec-compatible invalid_payload error for malformed PAYMENT-SIGNATURE headers in the Go HTTP server ([#2907](https://github.com/x402-foundation/x402/pull/2907)) - Thanks [@wnjoon](https://github.com/wnjoon)!
- Preserved one-shot request bodies across payment retries. ([#2914](https://github.com/x402-foundation/x402/pull/2914)) - Thanks [@wnjoon](https://github.com/wnjoon)!
- Propagated client storage errors during batch settlement and refunds. ([#2917](https://github.com/x402-foundation/x402/pull/2917)) - Thanks [@wnjoon](https://github.com/wnjoon)!
- Rejected small-order Ed25519 public keys in SIWx Solana signature verification. ([#2933](https://github.com/x402-foundation/x402/pull/2933)) - Thanks [@phdargen](https://github.com/phdargen)!

## v2.19.0 - 2026-07-17
### Changed
- SIWX validation and verification results now use IsValid, InvalidReason, InvalidMessage, and Payer instead of Valid, Error, and Address. Each failure includes a machine-readable invalid_siwx_* code aligned with the TypeScript SDK. ([#2889](https://github.com/x402-foundation/x402/pull/2889)) - Thanks [@phdargen](https://github.com/phdargen)!
- Require a configured `Origin` for SIWX server integration. Challenge issuance and proof validation now bind to this operator-defined public origin instead of deriving trust from request headers or per-route declaration fields. Pass `Origin` to `CreateResourceServerExtension()`; remove `Domain` and `ResourceURI` from `DeclareOptions`. ([#2859](https://github.com/x402-foundation/x402/pull/2859)) - Thanks [@phdargen](https://github.com/phdargen)!
### Fixed
- Fix unauthenticated path-traversal and pre-verification channel mutation in the batch-settlement server scheme, and widen AfterVerifyHook so hooks can abort with after_verify_aborted cancellation. Channel ids are validated to canonical bytes32 form before storage access; file paths stay within the storage root; reservation is deferred until after successful verify; recovered onVerifyFailure results now run after-verify hooks. ([#2863](https://github.com/x402-foundation/x402/pull/2863)) - Thanks [@phdargen](https://github.com/phdargen)!
- Fix batch-settlement SettleDeposit double-counting channel balance after a confirmed deposit by anchoring the optimistic balance to a pre-submit ReadChannelState and adding depositAmount once. ([#2881](https://github.com/x402-foundation/x402/pull/2881)) - Thanks [@phdargen](https://github.com/phdargen)!
- Fix batch-settlement VerifyDeposit returning projected balance+deposit in verify extra before the deposit is mined, aligning with TS/Python so AfterVerifyHook does not cache unconfirmed escrow. ([#2883](https://github.com/x402-foundation/x402/pull/2883)) - Thanks [@phdargen](https://github.com/phdargen)!

## v2.18.0 - 2026-07-10
### Added
- Add Igra mainnet (eip155:38833) default stablecoin USDC via Permit2 ([#2800](https://github.com/x402-foundation/x402/pull/2800)) - Thanks [@emdin](https://github.com/emdin)!
### Fixed
- MCP payment matching now selects the advertised `accepts` entry matching the payment payload instead of always using the first entry, so cross-SDK MCP flows advertising multiple requirements no longer fail when the payer selects a non-first option. ([#2774](https://github.com/x402-foundation/x402/pull/2774)) - Thanks [@phdargen](https://github.com/phdargen)!

## v2.17.0 - 2026-06-26
### Added
- Expanded wallet compatibility so payments verify and settle consistently across plain EOAs, deployed smart accounts (ERC-4337 / ERC-7579), counterfactual ERC-6492 wallets, and ERC-7702-delegated EOAs. Pre-verification now mirrors on-chain signature checking, so a payment that passes verify is the same one that succeeds at settle. Added counterfactual ERC-6492 support to the exact and batch-settlement flows — the wallet is deployed and its signature validated together during verify — gated by a new EIP6492AllowedFactories allowlist you set on the facilitator scheme config. Also added a wallet-compatibility guide documenting which wallet and scheme combinations are supported. ([#2658](https://github.com/x402-foundation/x402/pull/2658)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe) and [@cursoragent](https://github.com/cursoragent)!
### Changed
- Made the batch-settlement facilitator `authorizerSigner` optional: when omitted, no `receiverAuthorizer` is advertised in `/supported` and claim/refund settlement returns `ErrAuthorizerNotConfigured` if the payload carries no authorizer signature. Added a `FacilitatorSupportValidator` hook so the resource server fails fast at `Initialize()` when a scheme delegates the receiver-authorizer role but the facilitator advertises none. ([#2706](https://github.com/x402-foundation/x402/pull/2706)) - Thanks [@phdargen](https://github.com/phdargen)!

## v2.16.0 - 2026-06-19
### Added
- Add Go sign-in-with-x server and client support, including SIWX storage, auth hooks, EVM EIP-191 signing and verification, HTTP auth retry, TS-compatible profile, weather, and joke examples, and interoperability fixes for SIWE empty statements, net/http 402 JSON responses, and TS server payment payload extension echo validation ([#2485](https://github.com/x402-foundation/x402/pull/2485)) - Thanks [@wnjoon](https://github.com/wnjoon)!
- Adds SIWX support for undeployed EIP-6492 and SVM ([#2669](https://github.com/x402-foundation/x402/pull/2669)) - Thanks [@phdargen](https://github.com/phdargen)!
### Fixed
- Added a dynamicInfoFields capability so an extension can mark certain info fields (nonces, timestamps) as regenerated per PaymentRequired response. Those fields are then excluded from the client-echo validatio (extension_echo_mismatch), while all other fields stay strictly compared. ([#2653](https://github.com/x402-foundation/x402/pull/2653)) - Thanks [@phdargen](https://github.com/phdargen)!

## v2.15.0 - 2026-06-12
### Added
- Add Mezo mainnet (chain ID 31612) support with mUSD as the default stablecoin ([#2590](https://github.com/x402-foundation/x402/pull/2590)) - Thanks [@ryanRfox](https://github.com/ryanRfox)!
- Add XDC Network mainnet (chain ID 50) and Apothem testnet (chain ID 51) support with USDC as the default stablecoin ([#2597](https://github.com/x402-foundation/x402/pull/2597)) - Thanks [@AnilChinchawale](https://github.com/AnilChinchawale)!
- Core and EVM plumbing for the ERC-8021 builder-code extension. The client now deep-merges extensions while preserving server-declared fields and re-merges them after client enrichment; the resource server validates client-echoed extension info and rejects mismatches with extension_echo_mismatch. The FacilitatorEvmSigner.WriteContract method gains a dataSuffix parameter, and the base evm package adds data-suffix helpers (ResolveDataSuffix, AppendDataSuffix) plus the BuilderCodeFacilitatorExtension interface, threaded through all EVM settle paths (exact EIP-3009 incl. V1, permit2/EIP-2612, upto, and batch-settlement) so a registered facilitator extension can append an ERC-8021 calldata suffix to settlement transactions. ([#2575](https://github.com/x402-foundation/x402/pull/2575)) - Thanks [@phdargen](https://github.com/phdargen)!
- builder-code extension now supports multiple service codes (`s`). NewBuilderCodeClientExtension accepts one or more codes (variadic), BuilderCodeExtensionData.S is now a []string, and the facilitator/CBOR encode and parse paths keep every valid entry so layered clients (e.g. an MCP middleware) can attribute multiple participants onchain. ([#2606](https://github.com/x402-foundation/x402/pull/2606)) - Thanks [@phdargen](https://github.com/phdargen)!
### Changed
- Set EVM and batch-settlement authorization validAfter to 0, use maxTimeoutSeconds for validBefore/deadlines, and raise the default resource server maxTimeoutSeconds from 60 to 300 to reduce onchain timing failures when payloads are queued or block timestamps lag. ([#2601](https://github.com/x402-foundation/x402/pull/2601)) - Thanks [@phdargen](https://github.com/phdargen)!
### Fixed
- EVM facilitator verify now rejects payments whose asset address has no bytecode (EOA). Calling any function on an EOA via eth_call silently returns empty data without reverting, causing on-chain simulation to pass and the subsequent settlement to land as a no-op with no Transfer event emitted. The fix calls eth_getCode on the asset address early in verifyEIP3009, VerifyPermit2, and VerifyUptoPermit2; any address with no bytecode is rejected with asset_not_deployed_contract. ([#2554](https://github.com/x402-foundation/x402/pull/2554)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!
- Cache SVM mint metadata in exact clients to avoid repeated mint account RPC lookups. ([#2456](https://github.com/x402-foundation/x402/pull/2456)) - Thanks [@wnjoon](https://github.com/wnjoon)!

## v2.14.0 - 2026-05-29
### Fixed
- Update module path to `github.com/x402-foundation/x402/go/v2` so consumers can resolve tagged releases (e.g. `go get github.com/x402-foundation/x402/go/v2@latest`) instead of pseudo-versions.

## v2.13.0 - 2026-05-29
### Added
- Added startup-time bazaar extension validation in Gin, Echo, and net/http middleware using JSON-schema validation from the bazaar extension package
### Fixed
- Fix security bug where a facilitator HTTP-200 response with `isValid:false` was not treated as a hard gate failure — `VerifyPaymentWithExtensions` now returns a `*VerifyError` when the facilitator explicitly rejects a payment, preventing any structurally well-formed payment header from bypassing the protected handler
- **[Breaking for facilitator implementers using ERC-4337 smart wallet deployment]** Fixed ERC-6492 factory call injection vulnerability in EVM exact settlement (v1 and v2) and simplified the configuration API. The `DeployERC4337WithEIP6492` bool field has been removed from `ExactEvmSchemeConfig` and `ExactEvmSchemeV1Config`. `EIP6492AllowedFactories []string` is now the sole gate: settlement deploys an undeployed smart wallet if and only if its factory address is present in the allowlist (case-insensitive). An empty or nil list disables the feature entirely and returns `eip6492_factory_not_allowed`. Facilitators previously using `DeployERC4337WithEIP6492: true` must remove that field and populate `EIP6492AllowedFactories` with every factory address they trust.
- Fixed SVM exact facilitator deduplication to key on the transaction message hash rather than the full signed-transaction bytes, preventing an attacker from bypassing the cache by randomizing the mutable fee-payer signature slot.
- Thread Bazaar service metadata from HTTP `RouteConfig` and MCP `PaymentWrapperConfig` into `PaymentRequired.resource`, and extend bazaar facilitator discovery

## v2.12.0 - 2026-05-22
### Added
- Add HPP mainnet (chain ID 190415) and HPP Sepolia (chain ID 181228) support with USDC.e (Bridged USDC) as the default stablecoin
- Add ADI Chain (chain ID 36900) support with USDC.e as the default stablecoin
- Add a curated testnet faucet map to the paywall plus PaywallConfig.FaucetURLs (per-chain override keyed by CAIP-2). Unmapped chains render "No faucet configured." instead of a fallback link.
- Added checks for 0 amount to settle/refund for batch-settlement
### Fixed
- unwrap ERC-6492 signatures for exact/upto permit2 flows and batch-settlement

## v2.11.0 - 2026-05-11
### Added
- Add Radius Network (chain ID 723487) and Radius Testnet (chain ID 72344) support with SBC as the default stablecoin
- Log the EXTENSION-RESPONSES header from facilitator verify/settle responses; the HTTP facilitator client decodes the header and logs allowlisted fields (status, rejectedReason, reason, code) without attaching data to VerifyResponse or SettleResponse
- Bazaar service metadata fields (`serviceName`, `tags`, `iconUrl`) on `types.ResourceInfo`, plus `isValidServiceName` / `sanitizeTags` / `isValidIconUrl` / `sanitizeResourceServiceMetadata` helpers in `extensions/bazaar` that facilitator extraction now applies with soft-drop semantics.
- Added batch-settlement evm mechanism

## v2.10.0 - 2026-04-27
### Fixed
- MCP payload extraction failing with no method set

## v2.9.0 - 2026-04-13
### Added
- Add optional `extra.memo` support to SVM exact scheme for seller-defined payment references

## v2.8.0 - 2026-04-02
### Added
- Add Arbitrum One (chain ID 42161) and Arbitrum Sepolid (chain ID 421614) support with USDC as the default stablecoin
- Add Mezo Testnet (chain ID 31611) support with mUSD as the default stablecoin
- Add Polygon mainnet (chain ID 137) support with USDC as the default stablecoin
- Add Stable mainnet (chain ID 988) support with USDT0 as the default stablecoin
- Add Stable testnet (chain ID 2201) support with USDT0 as the default stablecoin
- Add net/http standard library adapter for x402 payment middleware (http/nethttp package)
- Add Echo framework middleware adapter for x402 payment handling in go/http/echo package
- Add upto EVM payment scheme with client, facilitator, and server support for permit2-based partial settlement on EVM chains
### Changed
- Updated x402UptoPermit2Proxy canonical address to 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002, deployed with deterministic bytecode for reproducible cross-chain CREATE2 addresses
- Migrated project from coinbase/x402 to x402-foundation/x402 organization
### Fixed
- Fix gin streaming content leak and echo panic on flush 

## v2.7.0 - 2026-03-23
### Changed
- Changed Bazaar discovery extension to support dynamic route patterns. EnrichDeclaration now
translates [param] route segments to :param-style routeTemplate and populates pathParams with
concrete values from each request. The EnrichExtensions call in go/http/server.go, previously
disabled (commented out) in all prior Go releases, is now active: ALL existing Go routes that
declare extensions will have their extensions enriched at request time. Added RouteTemplate field
to DiscoveryExtension so callers can read it without a type assertion.

## v2.6.0 - 2026-03-17
### Added
- Added simulation to permit2 verify and (optional) settle
### Changed
- Replaced SendRawApprovalAndSettle with a generic SendTransactions signer method that accepts an array of transaction requests (pre-signed or unsigned intents). Closed fail-open verification paths, aligned Permit2 amount check to exact match, and improved client extension fallback error handling
- Simulate transaction in verify and (optional) settle; Added multicall utility for efficient rpc calls; Fixed undeployed smart wallet handling
### Fixed
- Fixed paywall config injection targeting `</body>` causing SVG parse errors in the browser

## v2.5.0 - 2026-03-06
### Added
- Add route configuration validation during Initialize() to catch scheme/facilitator mismatches at startup
- Added assetTransferMethod and supportsEip2612 flag to defaultAssets
- Added `onProtectedRequest` hook to HTTP resource server
- Add WithBazaar facilitator client decorator for querying /discovery/resources endpoint from bazaar in go
- Added dynamic function for servers to generate custom response for settlement failures defaulting to empty
- Add in-memory SettlementCache to prevent duplicate SVM transaction settlement during on-chain confirmation window
### Changed
- Separated v1 legacy network name resolution from v2 CAIP-2 resolution; v1 code now uses evm/v1 package, shared utils only accept eip155:CHAIN_ID format
- GetSupported retries up to 3 times with exponential backoff on 429 rate limit responses
- Add pluggable PaywallProvider interface for custom paywall HTML generation with PaywallBuilder pattern

## 2.4.1 - 2026-02-25
### Fixed
- Fixed changelog generation to include version extension and eliminate trailing dots which prevent go from importing

## v2.4.0 - 2026-02-25
### Changed
- Update Permit2 witness struct (remove extra field), contract addresses, and error names for post-audit x402 proxy contracts on Base Sepolia
- Pre-compile constant regex patterns in http server for better performance
### Fixed
- preserve query params in paywall redirect

## v2.3.0 - 2026-02-20
### Added
- Added payment-identifier extension — Enables idempotent payment requests.
### Changed
- Increased EVM validAfter buffer from 30 seconds to 10 minutes for consistency with TypeScript SDK
- Upgraded facilitator extension registration from string keys to FacilitatorExtension objects. Added FacilitatorContext to SchemeNetworkFacilitator functions
### Fixed
- Add validAfter and validBefore timing validation to EIP-3009 verification in the Go facilitator SDK

## 2.2.0 - 2026-02-11
### Added
- Added MCP transport integration for x402 payment protocol
- Add MegaETH mainnet (chain ID 4326) support with USDM as the default stablecoin
- Added memo instruction with random nonce to SVM transactions to ensure uniqueness and prevent duplicate transaction attacks

## 2.1.0 - 2026-01-09
### Added
- Fixed interopability bug
- Added extensions support

## 2.0.0 - 2025-10-12
### Added
- Implements x402 v2 for the Go SDK.

## 1.0.0 - 2025-09-12
### Added
- Implements x402 v1 for the Go SDK.

