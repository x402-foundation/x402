import { Address, beginCell } from "@ton/core";
import {
  SUPPORTED_NETWORKS,
  TVM_MAINNET,
  TVM_TESTNET,
  USDT_DECIMALS,
  USDT_MAINNET_MINTER,
  USDT_TESTNET_MINTER,
} from "./constants";

/**
 * Normalize a TON address to raw format (0:hex).
 * Accepts both raw format and user-friendly (bounceable/non-bounceable) format.
 *
 * @param address
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
  return parseDecimalAmount(
    price.replace(/^\$/, "").replace(/\s*(USD|USDT)\s*$/i, ""),
    USDT_DECIMALS,
  );
}

/**
 * Check if a network identifier is a supported TVM network.
 *
 * @param network
 */
export function isValidTvmNetwork(network: string): boolean {
  return SUPPORTED_NETWORKS.has(network);
}

/**
 * Determine if a network is testnet.
 *
 * @param network
 */
export function isTvmTestnet(network: string): boolean {
  return network === "tvm:-3";
}

export function getDefaultAsset(network: string): string {
  if (network === TVM_MAINNET) return USDT_MAINNET_MINTER;
  if (network === TVM_TESTNET) return USDT_TESTNET_MINTER;
  throw new Error(
    `No default stablecoin configured for network ${network}; specify an explicit asset`,
  );
}

export function parseDecimalAmount(value: string | number, decimals: number): bigint {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Invalid amount: ${value}`);
  }

  const [whole, fraction = ""] = text.split(".");
  const atomic = `${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`.replace(/^0+/, "");
  return BigInt(atomic || "0");
}

export function makeZeroBitCellBoc(): string {
  return beginCell().storeBit(0).endCell().toBoc().toString("base64");
}
