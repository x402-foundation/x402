import { AlgorandClient } from "@algorandfoundation/algokit-utils/algorand-client";
import type { AlgodClient } from "@algorandfoundation/algokit-utils/algod-client";
import { ALGORAND_NETWORK_REFS } from "../../paywallUtils";

/**
 * Gets an AlgorandClient for the given network.
 * Uses AlgorandClient convenience methods which provide built-in AlgoNode defaults.
 *
 * @param network - The network to get the client for (CAIP-2 format: algorand:reference)
 * @returns An AlgorandClient instance
 */
export function getAlgorandClient(network: string): AlgorandClient {
  if (!network.startsWith("algorand:")) {
    throw new Error(
      `Invalid network format. Expected CAIP-2 format (algorand:reference), got: ${network}`,
    );
  }

  const ref = network.split(":")[1];
  const isTestnet = ref === ALGORAND_NETWORK_REFS.TESTNET;

  return isTestnet ? AlgorandClient.testNet() : AlgorandClient.mainNet();
}

/**
 * Gets the Algod client for the given network.
 * Thin wrapper around getAlgorandClient for backward compatibility.
 *
 * @param network - The network to get the Algod client for (CAIP-2 format: algorand:reference)
 * @param url - Optional URL override (ignored when using AlgorandClient defaults)
 * @returns The Algod client for the given network
 */
export function getAlgodClient(network: string, url?: string): AlgodClient {
  if (url) {
    // When a custom URL is provided, create a custom AlgorandClient
    const client = AlgorandClient.fromConfig({
      algodConfig: { server: url },
    });
    return client.client.algod;
  }
  return getAlgorandClient(network).client.algod;
}

/**
 * USDC ASA IDs for Algorand networks
 */
export const USDC_ASA_IDS: Record<string, string> = {
  [ALGORAND_NETWORK_REFS.MAINNET]: "31566704",
  [ALGORAND_NETWORK_REFS.TESTNET]: "10458941",
};

/**
 * Gets the USDC ASA ID for the given network reference.
 *
 * @param networkRef - The network reference (genesis hash).
 * @returns The USDC ASA ID or undefined if not found.
 */
export function getUsdcAsaId(networkRef: string): string | undefined {
  return USDC_ASA_IDS[networkRef];
}
