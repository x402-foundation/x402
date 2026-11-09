import type { Network } from "@x402/core/types";
import { getDefaultResolver } from "@keetanetwork/anchor/config.js";
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { TokenPublicKeyString } from "@keetanetwork/keetanet-client/lib/account";
import { KEETA_MAINNET_CAIP2, KEETA_TESTNET_CAIP2 } from "./constants";

/**
 * Get the KTA token address for a network
 *
 * @param network - Network identifier (CAIP-2 format)
 * @returns KTA token address for the network
 */
export function getKTAAddress(network: Network): TokenPublicKeyString {
  const keetaNetwork = networkToKeetaNetwork(network);
  const { baseToken } = KeetaNet.lib.Account.generateBaseAddresses(
    KeetaNet.Client.Config.NetworkIDs[keetaNetwork],
  );
  return baseToken.publicKeyString.toString();
}

/**
 * KTA token addresses
 */
export const KTA_MAINNET_ADDRESS = getKTAAddress(KEETA_MAINNET_CAIP2);
export const KTA_TESTNET_ADDRESS = getKTAAddress(KEETA_TESTNET_CAIP2);

/**
 * Get the default USDC token address for a network
 *
 * @param network - Network identifier (CAIP-2 format)
 * @returns USDC token address for the network
 */
export async function getUsdcAddress(network: Network): Promise<string> {
  let keetaNetwork;
  try {
    keetaNetwork = networkToKeetaNetwork(network);
  } catch {
    throw new Error(`No USDC address configured for network: ${network}`);
  }

  const client = KeetaNet.UserClient.fromNetwork(keetaNetwork, null);

  let usdc;
  try {
    const resolver = getDefaultResolver(client);
    usdc = await resolver.lookupToken("$USDC");
  } finally {
    await client.destroy();
  }

  if (!usdc) {
    throw new Error(`$USDC not found for network: ${network}`);
  }

  return usdc.token;
}

/**
 * Convert a network identifier (CAIP-2 format) to a Keeta network identifier
 *
 * @param network - The network in CAIP-2 format
 * @returns The Keeta network identifier
 */
export function networkToKeetaNetwork(network: Network): "main" | "test" {
  switch (network) {
    case KEETA_MAINNET_CAIP2:
      return "main";
    case KEETA_TESTNET_CAIP2:
      return "test";
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}

/**
 * Validate that an asset address is a valid token address.
 *
 * @param asset - The asset address to validate
 * @returns True if the asset is a valid token address, false otherwise
 */
export function validateTokenAsset(asset: string): boolean {
  let token: InstanceType<typeof KeetaNet.lib.Account>;
  try {
    token = KeetaNet.lib.Account.fromPublicKeyString(asset);
  } catch {
    return false;
  }

  return token.isToken();
}

/**
 * A cache of Keeta UserClients to keep only one UserClient per network and address combination.
 * This avoids creating new instances every time a network operation is performed to remove
 * the initialization overhead of always requesting the current reps.
 * It's especially helpful when signing multiple blocks in rapid succession.
 */
export class KeetaUserClientCache {
  private cache = new Map<string, InstanceType<typeof KeetaNet.UserClient>>();

  /**
   * Retrieves a KeetaNet UserClient instance for the given network and account.
   * Creates a new UserClient instance if one does not exist for the given network and account.
   *
   * @param account - The account address to use for the UserClient.
   * @param network - The network to retrieve the UserClient for.
   * @returns A Promise that resolves to the UserClient instance.
   */
  get(
    account: InstanceType<typeof KeetaNet.lib.Account>,
    network: Network,
  ): InstanceType<typeof KeetaNet.UserClient> {
    const key = `${network.toString()}:${account.publicKeyString.toString()}`;
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const keetaNetwork = networkToKeetaNetwork(network);

    if (!account.isAccount()) {
      throw new Error("Account must be an account");
    }

    if (!account.hasPrivateKey) {
      throw new Error("Keeta account with private key is required");
    }

    const client = KeetaNet.UserClient.fromNetwork(keetaNetwork, account);

    this.cache.set(key, client);

    return client;
  }

  /**
   * Destroy this instance and clean up all resources.
   */
  async destroy(): Promise<void> {
    await Promise.all(Array.from(this.cache.values()).map(client => client.destroy()));
    this.cache.clear();
  }
}
