import { Horizon, rpc } from "@stellar/stellar-sdk";
import {
  convertToTokenAmount as coreConvertToTokenAmount,
  numberToDecimalString,
} from "@x402/core/utils";
import {
  DEFAULT_PUBNET_HORIZON_URL,
  DEFAULT_TESTNET_HORIZON_URL,
  DEFAULT_TESTNET_RPC_URL,
  DEFAULT_TOKEN_DECIMALS,
  STELLAR_ASSET_ADDRESS_REGEX,
  STELLAR_DESTINATION_ADDRESS_REGEX,
  STELLAR_NETWORK_TO_PASSPHRASE,
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from "./constants";
import type { Network } from "@x402/core/types";

export const DEFAULT_ESTIMATED_LEDGER_SECONDS = 5;
const HORIZON_LEDGERS_SAMPLE_SIZE = 20;

/**
 * Configuration for RPC client connections
 */
export interface RpcConfig {
  /** Custom RPC URL to use instead of defaults */
  url?: string;
}

/**
 * Checks if a network is a Stellar network
 *
 * @param network - The CAIP-2 network identifier
 * @returns `true` if the network is a Stellar network, `false` otherwise
 */
export function isStellarNetwork(network: Network): boolean {
  return STELLAR_NETWORK_TO_PASSPHRASE.has(network);
}

/**
 * Validates a Stellar destination address (G-account, C-account, or M-account)
 *
 * @param address - Stellar destination address to validate
 * @returns `true` if the address is valid, `false` otherwise
 */
export function validateStellarDestinationAddress(address: string): boolean {
  return STELLAR_DESTINATION_ADDRESS_REGEX.test(address);
}

/**
 * Validates a Stellar asset/contract address (C-account only)
 *
 * @param address - Stellar asset address to validate
 * @returns `true` if the address is valid, `false` otherwise
 */
export function validateStellarAssetAddress(address: string): boolean {
  return STELLAR_ASSET_ADDRESS_REGEX.test(address);
}

/**
 * Gets the network passphrase for a given Stellar network
 *
 * @param network - The CAIP-2 network identifier
 * @returns The network passphrase string
 * @throws {Error} If the network is not a known Stellar network
 */
export function getNetworkPassphrase(network: Network): string {
  const networkPassphrase = STELLAR_NETWORK_TO_PASSPHRASE.get(network);
  if (!networkPassphrase) {
    throw new Error(`Unknown Stellar network: ${network}`);
  }
  return networkPassphrase;
}

/**
 * Gets the RPC URL for a given Stellar network
 *
 * @param network - The CAIP-2 network identifier
 * @param rpcConfig - Optional RPC configuration with custom URL
 * @returns The RPC URL string
 * @throws {Error} If the network is unknown or mainnet RPC URL is not provided
 */
export function getRpcUrl(network: Network, rpcConfig?: RpcConfig): string {
  const customRpcUrl = rpcConfig?.url;
  switch (network) {
    case STELLAR_TESTNET_CAIP2:
      return customRpcUrl || DEFAULT_TESTNET_RPC_URL;
    case STELLAR_PUBNET_CAIP2:
      if (!customRpcUrl) {
        throw new Error(
          "Stellar mainnet requires a non-empty rpcUrl. For a list of RPC providers, see https://developers.stellar.org/docs/data/apis/rpc/providers#publicly-accessible-apis",
        );
      }
      return customRpcUrl;
    default:
      throw new Error(`Unknown Stellar network: ${network}`);
  }
}

/**
 * Creates a Soroban RPC client for the given network
 *
 * @param network - The CAIP-2 network identifier
 * @param rpcConfig - Optional RPC configuration with custom URL
 * @returns A configured Soroban RPC Server instance
 * @throws {Error} If the network is not a valid Stellar network
 */
export function getRpcClient(network: Network, rpcConfig?: RpcConfig): rpc.Server {
  const rpcUrl = getRpcUrl(network, rpcConfig);
  return new rpc.Server(rpcUrl, {
    allowHttp: network === STELLAR_TESTNET_CAIP2, // Allow HTTP for testnet
  });
}

/**
 * Creates a Horizon SDK client for the given network.
 *
 * @param network - The CAIP-2 network identifier
 * @returns A configured Horizon.Server instance
 * @throws {Error} If the network is unknown
 */
export function getHorizonClient(network: Network): Horizon.Server {
  switch (network) {
    case STELLAR_TESTNET_CAIP2:
      return new Horizon.Server(DEFAULT_TESTNET_HORIZON_URL);
    case STELLAR_PUBNET_CAIP2:
      return new Horizon.Server(DEFAULT_PUBNET_HORIZON_URL);
    default:
      throw new Error(`Unknown Stellar network: ${network}`);
  }
}

/**
 * Estimates ledger close time by fetching the most recent ledgers from Horizon.
 *
 * Uses the Horizon SDK's ledger query builder which is significantly faster
 * than the Soroban RPC `getLedgers` method for this purpose.
 *
 * @param network - The CAIP-2 network identifier
 * @returns Estimated seconds per ledger, or DEFAULT_ESTIMATED_LEDGER_SECONDS (5) on error
 */
export async function getEstimatedLedgerCloseTimeSeconds(network: Network): Promise<number> {
  try {
    const horizon = getHorizonClient(network);
    const page = await horizon.ledgers().limit(HORIZON_LEDGERS_SAMPLE_SIZE).order("desc").call();
    const records = page.records;
    if (!records || records.length < 2) return DEFAULT_ESTIMATED_LEDGER_SECONDS;

    const newestTs = new Date(records[0].closed_at).getTime() / 1000;
    const oldestTs = new Date(records[records.length - 1].closed_at).getTime() / 1000;
    const intervals = records.length - 1;
    return Math.ceil((newestTs - oldestTs) / intervals);
  } catch {
    return DEFAULT_ESTIMATED_LEDGER_SECONDS;
  }
}

/**
 * Gets the default USDC contract address for a network
 *
 * @param network - The CAIP-2 network identifier
 * @returns The USDC contract address for the network
 * @throws {Error} If the network doesn't have a configured USDC address
 */
export function getUsdcAddress(network: Network): string {
  switch (network) {
    case STELLAR_PUBNET_CAIP2:
      return USDC_PUBNET_ADDRESS;
    case STELLAR_TESTNET_CAIP2:
      return USDC_TESTNET_ADDRESS;
    default:
      throw new Error(`No USDC address configured for network: ${network}`);
  }
}

export { numberToDecimalString };

/**
 * Converts a decimal amount to token smallest units.
 * Wraps the core utility with Stellar's default of 7 decimal places.
 *
 * @param decimalAmount - The decimal amount as a string
 * @param decimals - Number of decimal places for the token (default: 7 for Stellar USDC)
 * @returns The amount in smallest units as a string
 */
export function convertToTokenAmount(
  decimalAmount: string,
  decimals: number = DEFAULT_TOKEN_DECIMALS,
): string {
  return coreConvertToTokenAmount(decimalAmount, decimals);
}
