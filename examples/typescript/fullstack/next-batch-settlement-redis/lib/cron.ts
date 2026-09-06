import type { AutoSettlementContext, Channel } from "@x402/evm/batch-settlement/server";

import { channelManager } from "./server";

export interface ClaimCronOptions {
  maxClaimsPerBatch?: number;
  idleSecs?: number;
  selectClaimChannels?: (
    channels: Channel[],
    context: AutoSettlementContext,
  ) => Channel[] | Promise<Channel[]>;
}

export type ClaimAndSettleCronOptions = ClaimCronOptions;

export interface ClaimCronSummary {
  claimBatches: number;
  vouchers: number;
  claimTransactions: string[];
}

export interface SettleCronSummary {
  settleTransaction: string;
}

export interface ClaimAndSettleCronSummary {
  claimBatches: number;
  vouchers: number;
  claimTransactions: string[];
  settleTransaction?: string;
}

/**
 * Claims pending vouchers in cron-friendly batches.
 *
 * @param opts - Optional cron execution settings.
 * @param opts.maxClaimsPerBatch - Max vouchers per facilitator claim transaction.
 * @returns Compact claim summary.
 */
export async function runClaimCron(opts?: ClaimCronOptions): Promise<ClaimCronSummary> {
  const claims = await channelManager.claim({
    ...opts,
    maxClaimsPerBatch: opts?.maxClaimsPerBatch ?? 100,
  });

  return {
    claimBatches: claims.length,
    vouchers: claims.reduce((total, claim) => total + claim.vouchers, 0),
    claimTransactions: claims.map(claim => claim.transaction),
  };
}

/**
 * Settles already-claimed funds to the receiver.
 *
 * @returns Compact settle summary.
 */
export async function runSettleCron(): Promise<SettleCronSummary> {
  const settle = await channelManager.settle();

  return {
    settleTransaction: settle.transaction,
  };
}

/**
 * Claims pending vouchers and settles them in one cron-friendly operation.
 *
 * @param opts - Optional cron execution settings.
 * @param opts.maxClaimsPerBatch - Max vouchers per facilitator claim transaction.
 * @returns Compact claim-and-settle summary.
 */
export async function runClaimAndSettleCron(
  opts?: ClaimAndSettleCronOptions,
): Promise<ClaimAndSettleCronSummary> {
  const { claims, settle } = await channelManager.claimAndSettle({
    ...opts,
    maxClaimsPerBatch: opts?.maxClaimsPerBatch ?? 100,
  });

  return {
    claimBatches: claims.length,
    vouchers: claims.reduce((total, claim) => total + claim.vouchers, 0),
    claimTransactions: claims.map(claim => claim.transaction),
    ...(settle ? { settleTransaction: settle.transaction } : {}),
  };
}
