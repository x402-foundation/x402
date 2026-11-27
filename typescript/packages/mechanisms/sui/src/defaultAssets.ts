import { normalizeStructTag } from "@mysten/sui/utils";
import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
} from "@x402/core/types";
import {
  SUI_MAINNET_CAIP2,
  SUI_TESTNET_CAIP2,
  USDC_DECIMALS,
  USDC_MAINNET,
  USDC_TESTNET,
} from "./constants";

export type SuiDefaultAsset = DefaultAsset;

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<SuiDefaultAsset> = {
  [SUI_MAINNET_CAIP2]: [{ asset: USDC_MAINNET, decimals: USDC_DECIMALS, symbol: "USDC" }],
  [SUI_TESTNET_CAIP2]: [{ asset: USDC_TESTNET, decimals: USDC_DECIMALS, symbol: "USDC" }],
};

/**
 * Look up a default asset by network and optional ticker.
 *
 * @param network - CAIP-2 network
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<SuiDefaultAsset> = (network, symbol?) => {
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
 * Reverse lookup by coin type and network. Coin types are compared after
 * `normalizeStructTag`, so short or differently-cased addresses still match.
 *
 * @param asset - Coin type from payment requirements
 * @param network - CAIP-2 network
 * @returns Matching entry, or undefined (also for a malformed coin type)
 */
export const findDefaultAsset: FindDefaultAsset<SuiDefaultAsset> = (asset, network) => {
  const assets = DEFAULT_ASSETS[network];
  if (!assets) {
    return undefined;
  }
  let normalized: string;
  try {
    normalized = normalizeStructTag(asset);
  } catch {
    return undefined;
  }
  return assets.find(entry => normalizeStructTag(entry.asset) === normalized);
};
