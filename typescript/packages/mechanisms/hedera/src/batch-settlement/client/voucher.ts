import { hashTypedData } from "viem";
import type { ClientHederaBatchSigner } from "../signer";
import { voucherTypes } from "../constants";
import type { BatchSettlementVoucherFields } from "../types";
import { getBatchSettlementEip712Domain } from "../utils";

/**
 * Signs a cumulative voucher with the client's Hedera account key.
 *
 * The voucher authorises the receiver to claim up to `maxClaimableAmount` from the channel
 * identified by `channelId`. The signature is a raw account signature (ED25519 or ECDSA) over
 * the EIP-712 `Voucher` digest under the escrow's domain, as verified on-chain through the
 * Hedera Account Service.
 *
 * @param signer - Client signer used to produce the raw signature.
 * @param channelId - Identifier of the payment channel (see `computeChannelId`).
 * @param maxClaimableAmount - Cumulative ceiling the receiver may claim (decimal string in token units).
 * @param network - CAIP-2 Hedera network identifier.
 * @returns Signed voucher fields ready to be included in a payment payload.
 */
export async function signVoucher(
  signer: ClientHederaBatchSigner,
  channelId: `0x${string}`,
  maxClaimableAmount: string,
  network: string,
): Promise<BatchSettlementVoucherFields> {
  const digest = hashTypedData({
    domain: getBatchSettlementEip712Domain(network),
    types: voucherTypes,
    primaryType: "Voucher",
    message: {
      channelId,
      maxClaimableAmount: BigInt(maxClaimableAmount),
    },
  });
  const signature = await signer.signDigest(digest);
  return { channelId, maxClaimableAmount, signature };
}
