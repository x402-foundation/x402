import { Address } from "@ton/core";
import { SUPPORTED_NETWORKS, USDT_DECIMALS } from "./constants";

/**
 * Normalize a TON address to raw format (0:hex).
 * Accepts both raw format and user-friendly (bounceable/non-bounceable) format.
 */
export function normalizeTonAddress(address: string): string {
  const parsed = Address.parse(address);
  return parsed.toRawString();
}

/**
 * Convert a human-readable USD price to nano-units for USDT (6 decimals).
 *
 * @param price - USD price string (e.g. "$0.01", "0.01", "1.50")
 * @returns Amount in smallest token unit as bigint
 */
export function priceToNano(price: string): bigint {
  const cleaned = price.replace(/^\$/, "").trim();
  const amount = parseFloat(cleaned);
  if (isNaN(amount)) {
    throw new Error(`Invalid price format: ${price}`);
  }
  return BigInt(Math.round(amount * 10 ** USDT_DECIMALS));
}

/**
 * Check if a network identifier is a supported TVM network.
 */
export function isValidTvmNetwork(network: string): boolean {
  return SUPPORTED_NETWORKS.has(network);
}

/**
 * Determine if a network is testnet.
 */
export function isTvmTestnet(network: string): boolean {
  return network === "tvm:-3";
}
