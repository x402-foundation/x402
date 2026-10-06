import { AccountId, ContractId, TokenId } from "@hiero-ledger/sdk";
import { getAddress, isAddress } from "viem";
import { HEDERA_CHAIN_IDS } from "./constants";
import { HEDERA_ENTITY_ID_REGEX } from "../constants";
import { fetchJson } from "../preflight";

/**
 * Returns the EVM chain id Hedera exposes as `block.chainid` for a CAIP-2 network.
 *
 * @param network - `hedera:mainnet` or `hedera:testnet`.
 * @returns 295 or 296.
 */
export function getHederaChainId(network: string): number {
  const chainId = HEDERA_CHAIN_IDS[network];
  if (chainId === undefined) {
    throw new Error(`Unsupported Hedera network: ${network}`);
  }
  return chainId;
}

/**
 * Normalizes a 40-hex-digit string (with or without `0x`) to a checksummed address.
 *
 * @param hex - Raw hex address.
 * @returns Checksummed `0x` address.
 */
function toChecksummed(hex: string): `0x${string}` {
  const withPrefix = hex.startsWith("0x") ? hex : `0x${hex}`;
  return getAddress(withPrefix);
}

/**
 * Long-zero EVM address of a Hedera entity id (`shard.realm.num`).
 *
 * @param entityId - Hedera account / token / contract id (`0.0.x`).
 * @returns The long-zero address (`0x000...num`).
 */
export function entityIdToLongZeroAddress(entityId: string): `0x${string}` {
  if (!HEDERA_ENTITY_ID_REGEX.test(entityId)) {
    throw new Error(`Invalid Hedera entity id: ${entityId}`);
  }
  return toChecksummed(AccountId.fromString(entityId).toEvmAddress());
}

/**
 * Long-zero EVM address of an HTS token id.
 *
 * @param tokenId - HTS token id (`0.0.x`).
 * @returns The token's EVM address.
 */
export function tokenIdToEvmAddress(tokenId: string): `0x${string}` {
  if (!HEDERA_ENTITY_ID_REGEX.test(tokenId)) {
    throw new Error(`Invalid Hedera token id: ${tokenId}`);
  }
  return toChecksummed(TokenId.fromString(tokenId).toEvmAddress());
}

/**
 * True when `address` is a long-zero address (first 12 bytes zero).
 *
 * @param address - EVM address.
 * @returns Whether the address encodes a Hedera entity number directly.
 */
export function isLongZeroAddress(address: string): boolean {
  if (!isAddress(address)) return false;
  return address.slice(2, 26).toLowerCase() === "000000000000000000000000";
}

/**
 * Converts a long-zero address back to a Hedera entity id.
 *
 * @param address - Long-zero EVM address.
 * @param shard - Shard number (default 0).
 * @param realm - Realm number (default 0).
 * @returns Entity id string (`shard.realm.num`).
 */
export function longZeroAddressToEntityId(address: string, shard = 0, realm = 0): string {
  if (!isLongZeroAddress(address)) {
    throw new Error(`Not a long-zero address: ${address}`);
  }
  const num = BigInt(`0x${address.slice(26)}`);
  return `${shard}.${realm}.${num.toString()}`;
}

/**
 * Resolves the `ContractId` for a contract EVM address (long-zero or alias).
 *
 * @param address - Contract EVM address.
 * @returns Hiero SDK `ContractId`.
 */
export function contractIdFromEvmAddress(address: string): ContractId {
  if (isLongZeroAddress(address)) {
    return ContractId.fromString(longZeroAddressToEntityId(address));
  }
  return ContractId.fromEvmAddress(0, 0, address.replace(/^0x/, ""));
}

/** Subset of the Mirror Node `/accounts/{id}` response used for address resolution. */
export type MirrorAccountSummary = {
  account: string;
  evm_address: string | null;
  key: { _type: string; key: string } | null;
  max_automatic_token_associations: number;
};

/**
 * Resolves the canonical EVM address of a Hedera account as the network sees it: the EVM alias
 * for ECDSA-alias accounts, otherwise the long-zero address.
 *
 * @param mirrorBaseUrl - Mirror Node REST base URL.
 * @param accountId - Account id (`0.0.x`) or EVM address.
 * @returns Checksummed EVM address.
 */
export async function resolveAccountEvmAddress(
  mirrorBaseUrl: string,
  accountId: string,
): Promise<`0x${string}`> {
  const account = await fetchJson<MirrorAccountSummary>(
    `${mirrorBaseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}`,
  );
  if (account.evm_address) {
    return toChecksummed(account.evm_address);
  }
  return entityIdToLongZeroAddress(account.account);
}

/**
 * Case-insensitive address equality.
 *
 * @param a - First address.
 * @param b - Second address.
 * @returns Whether both refer to the same 20-byte address.
 */
export function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Resolves the `payTo` of payment requirements to the receiver EVM address committed in the
 * channel config: the long-zero address of a Hedera account id, or the address itself.
 *
 * @param payTo - `0.0.x` account id or EVM address.
 * @returns Checksummed receiver address, or `undefined` when unparsable.
 */
export function resolveReceiverAddress(payTo: string): `0x${string}` | undefined {
  if (HEDERA_ENTITY_ID_REGEX.test(payTo)) return entityIdToLongZeroAddress(payTo);
  if (isAddress(payTo)) return getAddress(payTo);
  return undefined;
}

/**
 * Resolves the `asset` of payment requirements to the token EVM address.
 *
 * @param asset - HTS token id (`0.0.x`) or EVM address.
 * @returns Checksummed token address, or `undefined` when unparsable.
 */
export function resolveTokenAddress(asset: string): `0x${string}` | undefined {
  if (HEDERA_ENTITY_ID_REGEX.test(asset)) return tokenIdToEvmAddress(asset);
  if (isAddress(asset)) return getAddress(asset);
  return undefined;
}

/**
 * Resolves the HTS token id (`0.0.x`) for Mirror Node queries from either form.
 *
 * @param asset - HTS token id or long-zero token address.
 * @returns Token id, or `undefined` when the address is not long-zero.
 */
export function resolveTokenId(asset: string): string | undefined {
  if (HEDERA_ENTITY_ID_REGEX.test(asset)) return asset;
  if (isLongZeroAddress(asset)) return longZeroAddressToEntityId(asset);
  return undefined;
}
