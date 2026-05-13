import { ClientEvmSigner } from "../../signer";
import { voucherTypes } from "../constants";
import { BatchSettlementVoucherFields } from "../types";
import { getEvmChainId } from "../../utils";
import { getBatchSettlementEip712Domain } from "../utils";

/**
 * Signs a cumulative voucher using the client's wallet.
 *
 * The voucher authorises the receiver to claim up to `maxClaimableAmount` from the
 * channel identified by `channelId`.  The signature covers the EIP-712 `Voucher` struct
 * under the batched domain.
 *
 * @param signer - Client wallet used to produce the EIP-712 signature.
 * @param channelId - Identifier of the payment channel (`keccak256(abi.encode(ChannelConfig))`).
 * @param maxClaimableAmount - Cumulative ceiling the receiver may claim (decimal string in token units).
 * @param network - CAIP-2 network identifier (e.g. `eip155:84532`).
 * @returns Signed voucher fields ready to be included in a payment payload.
 */
export async function signVoucher(
  signer: ClientEvmSigner,
  channelId: `0x${string}`,
  maxClaimableAmount: string,
  network: string,
): Promise<BatchSettlementVoucherFields> {
  const chainId = getEvmChainId(network);

  const signature = await signer.signTypedData({
    domain: getBatchSettlementEip712Domain(chainId),
    types: voucherTypes,
    primaryType: "Voucher",
    message: {
      channelId,
      maxClaimableAmount: BigInt(maxClaimableAmount),
    },
  });

  return {
    channelId,
    maxClaimableAmount,
    signature,
  };
}
