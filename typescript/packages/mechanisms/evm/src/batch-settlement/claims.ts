import type { Network } from "@x402/core/types";
import type { BatchSettlementVoucherClaim } from "./types";
import { computeChannelId } from "./utils";
import type { Channel, ChannelStorage } from "./storage/channel";

export type SelectClaimableVouchersOptions = {
  now?: number;
  idleSecs?: number;
};

/**
 * Collects vouchers that are eligible for onchain claiming.
 *
 * A voucher is claimable when its `chargedCumulativeAmount` exceeds what has
 * already been claimed onchain. An optional idle filter skips sessions that
 * received a request within the last `idleSecs` seconds. Input order is preserved.
 *
 * @param channels - Channel records to inspect.
 * @param opts - Optional wall-clock and idle filter.
 * @returns Claimable voucher payloads.
 */
export function selectClaimableVouchers(
  channels: Channel[],
  opts?: SelectClaimableVouchersOptions,
): BatchSettlementVoucherClaim[] {
  const now = opts?.now ?? Date.now();
  const claims: BatchSettlementVoucherClaim[] = [];

  for (const c of channels) {
    if (BigInt(c.chargedCumulativeAmount) <= BigInt(c.totalClaimed)) {
      continue;
    }
    if (opts?.idleSecs !== undefined) {
      const idleMs = now - c.lastRequestTimestamp;
      if (idleMs < opts.idleSecs * 1000) {
        continue;
      }
    }
    claims.push({
      voucher: {
        channel: c.channelConfig,
        maxClaimableAmount: c.signedMaxClaimable,
      },
      signature: c.signature as `0x${string}`,
      totalClaimed: c.chargedCumulativeAmount,
    });
  }

  return claims;
}

/**
 * Updates session records after a successful claim so claim selection no longer
 * returns already-claimed vouchers.
 *
 * The callback is authoritative: it re-checks row presence and the claimed
 * watermark, so a claim that did not advance `totalClaimed` costs one no-op
 * update rather than a pre-read on every claim.
 *
 * @param storage - Durable channel store.
 * @param claims - Voucher claims included in the submitted settlement transaction.
 * @param network - CAIP-2 network used to recompute channel ids.
 */
export async function applyClaimedTotals<T extends Channel = Channel>(
  storage: ChannelStorage<T>,
  claims: BatchSettlementVoucherClaim[],
  network: Network,
): Promise<void> {
  for (const claim of claims) {
    const channelId = computeChannelId(claim.voucher.channel, network);
    const claimedAmount = BigInt(claim.totalClaimed);
    await storage.updateChannel(channelId, current => {
      if (!current || claimedAmount <= BigInt(current.totalClaimed)) {
        return current;
      }
      return {
        ...current,
        totalClaimed: claimedAmount.toString(),
      };
    });
  }
}
