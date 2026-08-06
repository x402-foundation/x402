/**
 * @module @x402/tvm - x402 Payment Protocol TVM (TON) Implementation
 *
 * This module provides the TVM-specific implementation of the x402 payment protocol,
 * using W5R1 signed Jetton transfers relayed by a native facilitator.
 */

// Exact scheme client
export { ExactTvmScheme } from "./exact";

// Signers
export {
  FacilitatorHighloadV3Signer,
  HighloadV3Config,
  toClientTvmSigner,
  toFacilitatorTvmSigner,
} from "./signer";
export type {
  ClientTvmSigner,
  ClientTvmSignerOptions,
  FacilitatorTvmSigner,
  HighloadV3ConfigOptions,
} from "./signer";

// Types
export type {
  ExactTvmPayload,
  ParsedJettonTransfer,
  ParsedTvmSettlement,
  TvmAccountState,
  TvmJettonWalletData,
  TvmPaymentPayload,
  TvmRelayRequest,
  W5InitData,
} from "./types";

export { SettlementCache } from "./settlement-cache";
export { createTvmProviderClient, TonapiRestClient, ToncenterRestClient } from "./provider";
export type { TvmProviderClient, TvmProviderName } from "./provider";

// Constants
export {
  TVM_MAINNET,
  TVM_TESTNET,
  USDT_MASTER,
  USDT_MAINNET_MINTER,
  USDT_TESTNET_MINTER,
  SCHEME_EXACT,
  JETTON_TRANSFER_OP,
  W5R1_CODE_HASH,
  SUPPORTED_NETWORKS,
  INTERNAL_SIGNED_OP,
  EXTERNAL_SIGNED_OP,
  SEND_MSG_OP,
  TVM_PROVIDER_TONAPI,
  TVM_PROVIDER_TONCENTER,
} from "./constants";

// Utils
export { getDefaultAsset, normalizeTonAddress, priceToNano } from "./utils";
