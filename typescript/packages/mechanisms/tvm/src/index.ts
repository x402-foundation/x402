/**
 * @module @x402/tvm - x402 Payment Protocol TVM (TON) Implementation
 *
 * This module provides the TVM-specific implementation of the x402 payment protocol,
 * using self-relay USDT transfers on TON via facilitator service.
 */

// Exact scheme client
export { ExactTvmScheme } from "./exact";

// Signers
export { toClientTvmSigner } from "./signer";
export type { ClientTvmSigner } from "./signer";

// Types
export type { TvmPaymentPayload } from "./types";

// Constants
export {
  TVM_MAINNET,
  TVM_TESTNET,
  USDT_MASTER,
  SCHEME_EXACT,
  JETTON_TRANSFER_OP,
  W5R1_CODE_HASH,
  SUPPORTED_NETWORKS,
  INTERNAL_SIGNED_OP,
  EXTERNAL_SIGNED_OP,
  SEND_MSG_OP,
} from "./constants";

// Utils
export { normalizeTonAddress, priceToNano } from "./utils";
