import { getAddress, hashTypedData } from "viem";
import { BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_DOMAIN, channelConfigTypes } from "./constants";
import type { ChannelConfig } from "./types";
import { getEvmChainId } from "../utils";

/**
 * Computes the chain-bound channel id from a {@link ChannelConfig} struct.
 *
 * @param config - The immutable channel configuration.
 * @param networkOrChainId - CAIP-2 network identifier or numeric EVM chain id.
 * @returns The `bytes32` channel id as a hex string.
 */
export function computeChannelId(
  config: ChannelConfig,
  networkOrChainId: string | number,
): `0x${string}` {
  const chainId =
    typeof networkOrChainId === "number" ? networkOrChainId : getEvmChainId(networkOrChainId);
  return hashTypedData({
    domain: getBatchSettlementEip712Domain(chainId),
    types: channelConfigTypes,
    primaryType: "ChannelConfig",
    message: {
      payer: config.payer,
      payerAuthorizer: config.payerAuthorizer,
      receiver: config.receiver,
      receiverAuthorizer: config.receiverAuthorizer,
      token: config.token,
      withdrawDelay: config.withdrawDelay,
      salt: config.salt,
    },
  });
}

/**
 * Returns the full EIP-712 domain for the batch-settlement contract on the given chain.
 *
 * @param chainId - Numeric EVM chain id.
 * @returns EIP-712 domain with `name`, `version`, `chainId`, and checksummed `verifyingContract`.
 */
export function getBatchSettlementEip712Domain(chainId: number) {
  return {
    ...BATCH_SETTLEMENT_DOMAIN,
    chainId,
    verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS),
  } as const;
}
