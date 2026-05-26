import { Network, NetworkToNodeAPI } from "@aptos-labs/ts-sdk";

/**
 * CAIP-2 network identifier for Aptos Mainnet
 */
export const APTOS_MAINNET_CAIP2 = "aptos:1";

/**
 * CAIP-2 network identifier for Aptos Testnet
 */
export const APTOS_TESTNET_CAIP2 = "aptos:2";

/**
 * Regex pattern for validating Aptos addresses
 * Matches 64 hex characters with 0x prefix
 */
export const APTOS_ADDRESS_REGEX = /^0x[a-fA-F0-9]{64}$/;

/**
 * The primary fungible store transfer function
 */
export const TRANSFER_FUNCTION = "0x1::primary_fungible_store::transfer";

/**
 * Maximum gas amount allowed for sponsored transactions to prevent gas draining attacks.
 * The Aptos SDK defaults to 200000 for simple transactions, so we allow some headroom.
 */
export const MAX_GAS_AMOUNT = 500000n;

/**
 * Maps CAIP-2 network identifiers to Aptos chain IDs.
 *
 * @param network - The CAIP-2 network identifier (e.g., "aptos:1")
 * @returns The corresponding chain ID
 */
export function getAptosChainId(network: string): number {
  switch (network) {
    case APTOS_MAINNET_CAIP2:
      return 1;
    case APTOS_TESTNET_CAIP2:
      return 2;
    default:
      throw new Error(`Unsupported Aptos network: ${network}`);
  }
}

/**
 * Default USDC fungible asset metadata address on mainnet.
 */
export const USDC_MAINNET_FA = "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b";

/**
 * Default USDC fungible asset metadata address on testnet.
 */
export const USDC_TESTNET_FA = "0x69091fbab5f7d635ee7ac5098cf0c1efbe31d68fec0f2cd565e8d168daf52832";

/**
 * Maps CAIP-2 network identifiers to Aptos SDK Network enum.
 *
 * @param network - The CAIP-2 network identifier (e.g., "aptos:1")
 * @returns The corresponding Aptos SDK Network enum value
 */
export function getAptosNetwork(network: string): Network {
  switch (network) {
    case APTOS_MAINNET_CAIP2:
      return Network.MAINNET;
    case APTOS_TESTNET_CAIP2:
      return Network.TESTNET;
    default:
      throw new Error(`Unsupported Aptos network: ${network}`);
  }
}

/**
 * Gets the default RPC URL for the given Aptos network.
 *
 * @param network - The Aptos SDK Network enum value
 * @returns The default RPC URL for the network
 */
export function getAptosRpcUrl(network: Network): string {
  return NetworkToNodeAPI[network];
}
