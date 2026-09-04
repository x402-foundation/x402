import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
} from "@x402/core/types";
import {
  STARKNET_MAINNET_CAIP2,
  STARKNET_SEPOLIA_CAIP2,
  USDC_MAINNET,
  USDC_SEPOLIA,
} from "./constants";
import { feltEquals } from "./utils";

export type StarknetDefaultAsset = DefaultAsset;

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<StarknetDefaultAsset> = {
  [STARKNET_MAINNET_CAIP2]: [{ asset: USDC_MAINNET, decimals: 6, symbol: "USDC" }],
  [STARKNET_SEPOLIA_CAIP2]: [{ asset: USDC_SEPOLIA, decimals: 6, symbol: "USDC" }],
};

/**
 * Look up a default asset by network and optional ticker.
 *
 * @param network - CAIP-2 network
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<StarknetDefaultAsset> = (network, symbol?) => {
  const assets = DEFAULT_ASSETS[network];
  if (!assets || assets.length === 0) {
    throw new Error(`No default asset configured for network ${network}`);
  }
  if (!symbol) {
    return assets[0];
  }
  const normalized = symbol.toUpperCase();
  const match = assets.find(entry => entry.symbol.toUpperCase() === normalized);
  if (!match) {
    throw new Error(`No ${symbol} default asset configured for network ${network}`);
  }
  return match;
};

/**
 * Reverse lookup by asset address and network. Addresses are compared as felts,
 * not strings: a Starknet address has no canonical padding or case, so
 * `0x0512...` and `0x512...` name the same token contract.
 *
 * @param asset - Token contract address from payment requirements
 * @param network - CAIP-2 network
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<StarknetDefaultAsset> = (asset, network) => {
  const assets = DEFAULT_ASSETS[network];
  if (!assets) {
    return undefined;
  }
  return assets.find(entry => feltEquals(entry.asset, asset));
};
