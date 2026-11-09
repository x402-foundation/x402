import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
} from "@x402/core/types";
import { DEFAULT_TOKEN_DECIMALS, NEAR_MAINNET_CAIP2, NEAR_TESTNET_CAIP2 } from "./constants";

export type NearDefaultAsset = DefaultAsset;

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<NearDefaultAsset> = {
  [NEAR_MAINNET_CAIP2]: [
    {
      asset: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      decimals: DEFAULT_TOKEN_DECIMALS,
      symbol: "USDC",
    },
  ],
  [NEAR_TESTNET_CAIP2]: [
    {
      asset: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
      decimals: DEFAULT_TOKEN_DECIMALS,
      symbol: "USDC",
    },
  ],
};

/**
 * Look up a default asset by network and optional ticker.
 *
 * @param network - CAIP-2 network
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<NearDefaultAsset> = (network, symbol?) => {
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
 * Reverse lookup by asset id and network.
 *
 * @param asset - NEP-141 contract from payment requirements
 * @param network - CAIP-2 network
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<NearDefaultAsset> = (asset, network) => {
  const assets = DEFAULT_ASSETS[network];
  if (!assets) {
    return undefined;
  }
  const normalized = asset.toLowerCase();
  return assets.find(entry => entry.asset.toLowerCase() === normalized);
};
