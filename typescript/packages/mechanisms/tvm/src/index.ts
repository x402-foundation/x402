/**
 * @module @x402/tvm - x402 Payment Protocol TVM (TON) Implementation
 *
 * This module provides the TVM-specific implementation of the x402 payment protocol,
 * using gasless USDT transfers on TON via TONAPI relay.
 */

// Exact scheme client
export { ExactTvmScheme } from "./exact";

// Signers
export { toClientTvmSigner, toFacilitatorTvmSigner } from "./signer";
export type { ClientTvmSigner, FacilitatorTvmSigner } from "./signer";

// Types
export type { TvmPaymentPayload, SignedW5Message } from "./types";

// Constants
export {
  TVM_MAINNET,
  TVM_TESTNET,
  USDT_MASTER,
  SCHEME_EXACT,
  JETTON_TRANSFER_OP,
  W5R1_CODE_HASH,
  SUPPORTED_NETWORKS,
} from "./constants";

// Utils
export { normalizeTonAddress, priceToNano } from "./utils";
