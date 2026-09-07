/**
 * @module @x402/canton - x402 Payment Protocol Canton Network Implementation.
 *
 * The `exact` scheme on Canton: the payer signs a CIP-56 token-standard
 * `TransferFactory_Transfer` and carries it INLINE in the payment payload; any
 * facilitator relays it in one transaction. Canton Coin and any CIP-56 registry
 * token (e.g. USDCx) share the exact wire shape and differ only by
 * `extra.instrumentId.admin`.
 *
 * Ledger access goes through the `ClientCantonSigner` / `FacilitatorCantonSigner`
 * interfaces. The package ships concrete implementations —
 * `toClientCantonSigner` / `toFacilitatorCantonSigner`, built on the bundled JSON
 * Ledger API + Scan clients and the official `@canton-network/core-tx-visualizer`
 * hashing — and an integrator may also inject their own. Facilitator operational
 * concerns (rate-limits, attribution, workers) stay in the deployment, not here.
 */

// Injected ledger-access interfaces + config.
export type {
  ClientCantonSigner,
  FacilitatorCantonSigner,
  CantonSchemeConfig,
  PreapprovalView,
  ExecuteResult,
} from "./signer.js";

// Canton types.
export { isCantonNetwork } from "./types.js";
export type {
  CantonNetwork,
  CantonTransferMethod,
  CantonInlinePayload,
  CantonPaymentRequirementsExtra,
  CantonErrorCode,
} from "./types.js";

// Constants + default assets.
export * from "./constants.js";
export { CANTON_COIN_ASSET, findDefaultAsset } from "./defaultAssets.js";

// Payload codec + verify-before-sign (also usable standalone).
export {
  encodeInlinePaymentPayload,
  decodeInlinePaymentPayload,
  InlinePayloadError,
} from "./inline-payload.js";
export {
  assertPreparedTransferMatches,
  PreparedTransferMismatchError,
  decodePrepared,
  extractTransfer,
} from "./prepared-transfer.js";
export { wireAmountToLedgerDecimal } from "./amount.js";

// Scheme classes (also available via the ./exact/* subpath exports).
export { ExactCantonScheme as ExactCantonClientScheme } from "./exact/client/scheme.js";
export { ExactCantonScheme as ExactCantonServerScheme } from "./exact/server/scheme.js";
export { ExactCantonScheme as ExactCantonFacilitatorScheme } from "./exact/facilitator/scheme.js";

// Concrete ledger-backed signers (participant JSON Ledger API + Scan + official
// core-tx-visualizer hashing). An integrator may inject their own instead.
export { toClientCantonSigner, toFacilitatorCantonSigner } from "./signer-factory.js";
export type {
  CantonLedgerConfig,
  ClientCantonSignerConfig,
  FacilitatorCantonSignerConfig,
} from "./signer-factory.js";
