import type { PaymentRequirements } from "@x402/core/types";
import type { Channel } from "../../payment-channels/generated/accounts/channel";
import { buildDistributeInstruction, type ServerInstruction } from "../../payment-channels/onchain";
import { FULL_SPLIT_BPS } from "../constants";
import type { BatchTerms } from "./types";

/**
 * Build the distribution instruction used by both normal settlement and sealing.
 *
 * @param channelId - Channel to distribute
 * @param channel - Confirmed channel account
 * @param terms - Resolved payment terms
 * @param requirements - Accepted resource payment requirements
 * @returns Distribution instruction for the resource recipient
 */
export async function buildBatchDistributeInstruction(
  channelId: string,
  channel: Channel,
  terms: BatchTerms,
  requirements: PaymentRequirements,
): Promise<ServerInstruction> {
  return buildDistributeInstruction({
    channelId,
    mint: channel.mint,
    network: requirements.network,
    payee: channel.payee,
    payer: channel.payer,
    rentPayer: channel.rentPayer,
    splits: [{ bps: FULL_SPLIT_BPS, recipient: requirements.payTo }],
    tokenProgram: terms.tokenProgram,
  });
}
