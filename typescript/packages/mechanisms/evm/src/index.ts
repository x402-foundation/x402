/**
 * @module @x402/evm - x402 Payment Protocol EVM Implementation
 *
 * This module provides the EVM-specific implementation of the x402 payment protocol.
 */

// Exact scheme client
export { ExactEvmScheme } from "./exact";
export {
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
  erc20AllowanceAbi,
  type Permit2AllowanceParams,
} from "./exact/client";

// Signers
export { toClientEvmSigner, toFacilitatorEvmSigner } from "./signer";
export type { ClientEvmSigner, FacilitatorEvmSigner } from "./signer";

// Types
export type {
  AssetTransferMethod,
  ExactEIP3009Payload,
  ExactPermit2Payload,
  ExactEvmPayloadV1,
  ExactEvmPayloadV2,
  Permit2Witness,
  Permit2Authorization,
} from "./types";
export { isPermit2Payload, isEIP3009Payload } from "./types";

// Upto scheme client
export { UptoEvmScheme } from "./upto";

// Upto types
export type { UptoPermit2Payload, UptoPermit2Witness, UptoPermit2Authorization } from "./types";
export { isUptoPermit2Payload } from "./types";

// Batch-settlement scheme client
export { BatchSettlementEvmScheme } from "./batch-settlement";

// Batch-settlement types
export type {
  AuthorizerSigner,
  ChannelConfig,
  ChannelState,
  BatchSettlementDepositPayload,
  BatchSettlementVoucherPayload,
  BatchSettlementRefundPayload,
  BatchSettlementVoucherFields,
  BatchSettlementErc3009Authorization,
  BatchSettlementClaimPayload,
  BatchSettlementEnrichedRefundPayload,
  BatchSettlementVoucherClaim,
  BatchSettlementPayload,
  BatchSettlementSettlePayload,
  BatchSettlementFacilitatorSettlePayload,
  BatchSettlementPaymentRequirementsExtra,
  BatchSettlementPaymentResponseExtra,
} from "./types";
export {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementClaimPayload,
  isBatchSettlementSettlePayload,
  isBatchSettlementEnrichedRefundPayload,
} from "./types";

// Batch-settlement constants
export {
  BATCH_SETTLEMENT_ADDRESS,
  BATCH_SETTLEMENT_SCHEME,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  BATCH_SETTLEMENT_DOMAIN,
  voucherTypes,
  refundTypes,
  claimBatchTypes,
} from "./batch-settlement/constants";

// Default stablecoins (USD string pricing → token address per chain)
export { getDefaultAsset } from "./shared/defaultAssets";
export type { DefaultAssetInfo, ExactDefaultAssetInfo } from "./shared/defaultAssets";

// Extension helpers (client + facilitator)
export { BUILDER_CODE_KEY, resolveDataSuffix, appendDataSuffix } from "./shared/extensions";
export type { DataSuffixContext, BuilderCodeFacilitatorExtension } from "./shared/extensions";

// ERC-7702 detection utilities (diagnostic — not used in routing).
// Verification is code-routed via {@link verifyTypedDataSignature}; 7702 is just
// "address has code" and routes to EIP-1271 like any other contract.
export { isERC7702Delegation, getERC7702DelegateAddress } from "./shared/erc7702";

// Strict signature verification primitive. Use this instead of
// `signer.verifyTypedData` (or viem's `publicClient.verifyTypedData`) inside a
// facilitator — those have an ECDSA fallback when EIP-1271 returns failure
// that diverges from on-chain SignatureChecker semantics for any address with
// code (most visibly ERC-7702 EOAs whose delegate rejects raw owner ECDSA).
export {
  verifyTypedDataSignature,
  verifyHashSignature,
  verifyHashSignatureWithCode,
  classifyErc6492Payer,
} from "./shared/verifySignature";
export type { Erc6492Classification } from "./shared/verifySignature";

// Constants
export {
  PERMIT2_ADDRESS,
  x402ExactPermit2ProxyAddress,
  x402UptoPermit2ProxyAddress,
  permit2WitnessTypes,
  uptoPermit2WitnessTypes,
  authorizationTypes,
  eip3009ABI,
  x402ExactPermit2ProxyABI,
  x402UptoPermit2ProxyABI,
} from "./constants";

// Default-asset registry (network → token metadata)
export { DEFAULT_STABLECOINS } from "./shared/defaultAssets";

// AuthCapture scheme
export { AuthCaptureEvmScheme } from "./auth-capture";

// AuthCapture types
export type {
  AuthCaptureExtra,
  AuthCapturePayload,
  Eip3009Payload as AuthCaptureEip3009Payload,
  PaymentInfoStruct as AuthCapturePaymentInfo,
  Permit2Payload as AuthCapturePermit2Payload,
} from "./auth-capture/types";
export { isAuthCaptureExtra, isAuthCapturePayload } from "./auth-capture/types";

// AuthCapture constants
export {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  AUTH_CAPTURE_SCHEME,
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
  PERMIT2_TOKEN_COLLECTOR_ADDRESS,
} from "./auth-capture/constants";
