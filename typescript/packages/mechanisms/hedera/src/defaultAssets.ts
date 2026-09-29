import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
} from "@x402/core/types";
import {
  HEDERA_MAINNET_CAIP2,
  HEDERA_MAINNET_USDC,
  HEDERA_TESTNET_CAIP2,
  HEDERA_TESTNET_USDC,
  HEDERA_USDC_DECIMALS,
} from "./constants";

export type HederaDefaultAsset = DefaultAsset;

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<HederaDefaultAsset> = {
  [HEDERA_MAINNET_CAIP2]: [
    { asset: HEDERA_MAINNET_USDC, decimals: HEDERA_USDC_DECIMALS, symbol: "USDC" },
  ],
  [HEDERA_TESTNET_CAIP2]: [
    { asset: HEDERA_TESTNET_USDC, decimals: HEDERA_USDC_DECIMALS, symbol: "USDC" },
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
export const getDefaultAsset: GetDefaultAsset<HederaDefaultAsset> = (network, symbol?) => {
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
 * @param asset - HTS token id from payment requirements
 * @param network - CAIP-2 network
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<HederaDefaultAsset> = (asset, network) => {
  const assets = DEFAULT_ASSETS[network];
  if (!assets) {
    return undefined;
  }
  return assets.find(entry => entry.asset === asset);
};
