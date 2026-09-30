import { getAddress, hashTypedData } from "viem";
import { BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_DOMAIN, channelConfigTypes } from "./constants";
import { ErrChannelIdMismatch, ErrInvalidChannelId } from "./errors";
import type { ChannelConfig } from "./types";
import { getEvmChainId } from "../utils";

/** Canonical `bytes32` channel id: `0x` followed by exactly 64 hex digits. */
const CHANNEL_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Narrows an untrusted value to a canonical `bytes32` channel id string.
 *
 * @param value - The value to test.
 * @returns `true` when `value` is a `0x`-prefixed 64-hex-digit string.
 */
export function isCanonicalChannelId(value: unknown): value is `0x${string}` {
  return typeof value === "string" && CHANNEL_ID_RE.test(value);
}

/**
 * Validates canonical `bytes32` form and normalizes to lowercase.
 *
 * @param channelId - Untrusted channel identifier from a request payload.
 * @returns The lowercased channel id.
 * @throws When `channelId` is not a canonical `bytes32` string. The message is generic
 *   so untrusted input is never echoed into logs.
 */
export function normalizeChannelId(channelId: string): `0x${string}` {
  if (!isCanonicalChannelId(channelId)) {
    throw new Error(ErrInvalidChannelId);
  }
  return channelId.toLowerCase() as `0x${string}`;
}

/**
 * Binds a claimed channel id to a channel config and network.
 *
 * @param config - The immutable channel configuration from the payload.
 * @param claimedChannelId - The channel id the client claims the config resolves to.
 * @param networkOrChainId - CAIP-2 network identifier or numeric EVM chain id.
 * @returns An error code when the id is malformed or does not match the config, else `undefined`.
 */
export function channelIdBindingError(
  config: ChannelConfig,
  claimedChannelId: string,
  networkOrChainId: string | number,
): string | undefined {
  if (!isCanonicalChannelId(claimedChannelId)) return ErrInvalidChannelId;
  if (computeChannelId(config, networkOrChainId).toLowerCase() !== claimedChannelId.toLowerCase()) {
    return ErrChannelIdMismatch;
  }
  return undefined;
}

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
