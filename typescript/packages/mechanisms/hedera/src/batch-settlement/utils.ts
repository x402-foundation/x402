import { getAddress, hashTypedData } from "viem";
import {
  BATCH_SETTLEMENT_DOMAIN,
  channelConfigTypes,
  getBatchSettlementDeployment,
} from "./constants";
import { ErrChannelIdMismatch, ErrInvalidChannelId } from "./errors";
import type { ChannelConfig } from "./types";
import { getHederaChainId } from "./addresses";

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
 * @throws When `channelId` is not a canonical `bytes32` string.
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
 * @param network - CAIP-2 Hedera network identifier.
 * @returns An error code when the id is malformed or does not match the config, else `undefined`.
 */
export function channelIdBindingError(
  config: ChannelConfig,
  claimedChannelId: string,
  network: string,
): string | undefined {
  if (!isCanonicalChannelId(claimedChannelId)) return ErrInvalidChannelId;
  if (computeChannelId(config, network).toLowerCase() !== claimedChannelId.toLowerCase()) {
    return ErrChannelIdMismatch;
  }
  return undefined;
}

/**
 * Computes the chain-bound channel id from a {@link ChannelConfig} struct, matching the
 * contract's `getChannelId(config)` for the network's deployment.
 *
 * @param config - The immutable channel configuration.
 * @param network - CAIP-2 Hedera network identifier.
 * @returns The `bytes32` channel id as a hex string.
 */
export function computeChannelId(config: ChannelConfig, network: string): `0x${string}` {
  return hashTypedData({
    domain: getBatchSettlementEip712Domain(network),
    types: channelConfigTypes,
    primaryType: "ChannelConfig",
    message: {
      payer: getAddress(config.payer),
      payerAuthorizer: getAddress(config.payerAuthorizer),
      receiver: getAddress(config.receiver),
      receiverAuthorizer: getAddress(config.receiverAuthorizer),
      token: getAddress(config.token),
      withdrawDelay: config.withdrawDelay,
      salt: config.salt,
    },
  });
}

/**
 * Returns the full EIP-712 domain for the batch-settlement escrow deployed on `network`.
 *
 * @param network - CAIP-2 Hedera network identifier.
 * @returns EIP-712 domain with `name`, `version`, `chainId`, and checksummed `verifyingContract`.
 */
export function getBatchSettlementEip712Domain(network: string) {
  return {
    ...BATCH_SETTLEMENT_DOMAIN,
    chainId: getHederaChainId(network),
    verifyingContract: getAddress(getBatchSettlementDeployment(network).settlement),
  } as const;
}
