export { BatchSettlementHederaScheme } from "./scheme";
export type {
  BatchSettlementClientContext,
  BatchSettlementDepositPolicy,
  BatchSettlementDepositStrategy,
  BatchSettlementDepositStrategyContext,
  BatchSettlementDepositStrategyResult,
  BatchSettlementHederaSchemeOptions,
} from "./scheme";
export type { ClientChannelStorage } from "./storage";
export { InMemoryClientChannelStorage } from "./storage";
export {
  createBatchSettlementHederaAllowanceDepositPayload,
  createDepositNonce,
} from "./hederaAllowance";
export { approveHtsAllowance, ensureHtsAllowance, readHtsAllowance } from "./allowance";
export type { ApproveHtsAllowanceOptions } from "./allowance";
export { signVoucher } from "./voucher";
export { refundChannel } from "./refund";
export type { RefundOptions } from "./refund";
export { createBatchSettlementClientHooks } from "./hooks";
export { computeChannelId } from "../utils";

export {
  applyMaxDeposit,
  depositAmountForRequest,
  isBatchSettlementHederaSchemeOptions,
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
