export { BatchSettlementEvmScheme } from "./scheme";
export type {
  BatchSettlementClientContext,
  BatchSettlementDepositPolicy,
  BatchSettlementDepositStrategy,
  BatchSettlementDepositStrategyContext,
  BatchSettlementDepositStrategyResult,
  BatchSettlementEvmSchemeOptions,
} from "./scheme";
export type { ClientChannelStorage } from "./storage";
export { InMemoryClientChannelStorage } from "./storage";
export { createBatchSettlementEIP3009DepositPayload } from "./eip3009";
export { signVoucher } from "./voucher";
export { refundChannel } from "./refund";
export type { RefundOptions } from "./refund";
export { createBatchSettlementClientHooks } from "./hooks";
export { computeChannelId, normalizeChannelSalt } from "../utils";
export type { ChannelSalt } from "../utils";
export {
  CHARGE_COUNTS_METADATA_KEY,
  chargeCountsMetadata,
  parseChargeCountsMetadata,
} from "../chargeCounts";
export type { ChargeCountsMetadata } from "../chargeCounts";
export { decodeClaimAttestation } from "../attestation";
export type { ClaimAttestation, ClaimAttestationRow } from "../attestation";

export {
  applyMaxDeposit,
  depositAmountForRequest,
  isBatchSettlementEvmSchemeOptions,
  maxDepositFromSpendCap,
  parseAnnouncedMinDeposit,
  resolveClientOptions,
  validateDepositPolicy,
} from "./config";
export type { ResolvedClientOptions } from "./config";

export {
  buildChannelConfig,
  getChannel,
  hasChannel,
  processPaymentResponse,
  readChannelBalanceAndTotalClaimed,
  recoverChannel,
  updateChannelAfterRefund,
  updateChannelFromSettle,
} from "./channel";
export type { BatchSettlementClientDeps, ChannelSettleLocal } from "./channel";

export {
  processCorrectivePaymentRequired,
  recoverFromOnChainState,
  recoverFromSignature,
} from "./recovery";
