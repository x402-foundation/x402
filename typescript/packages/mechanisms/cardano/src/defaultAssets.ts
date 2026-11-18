import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
} from "@x402/core/types";
import {
  CARDANO_MAINNET_CAIP2,
  CARDANO_PREPROD_CAIP2,
  normalizeCardanoNetwork,
  USDM_DEFAULT_DECIMALS,
  USDM_MAINNET_ASSET,
  USDM_PREPROD_ASSET,
} from "./constants";

export type CardanoDefaultAsset = DefaultAsset;

/**
 * Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default.
 * Preview has no USDM deployment and therefore no default; `lovelace` is not
 * USD-pegged and must be priced with an explicit `AssetAmount`.
 */
export const DEFAULT_ASSETS: DefaultAssetTable<CardanoDefaultAsset> = {
  [CARDANO_MAINNET_CAIP2]: [
    { asset: USDM_MAINNET_ASSET, decimals: USDM_DEFAULT_DECIMALS, symbol: "USDM" },
  ],
  [CARDANO_PREPROD_CAIP2]: [
    { asset: USDM_PREPROD_ASSET, decimals: USDM_DEFAULT_DECIMALS, symbol: "USDM" },
  ],
};

/**
 * Look up a default asset by network (CAIP-2 or CIP-34 alias) and optional ticker.
 *
 * @param network - Cardano network identifier
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<CardanoDefaultAsset> = (network, symbol?) => {
  const assets = DEFAULT_ASSETS[normalizeCardanoNetwork(network)];
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
 * Reverse lookup by asset unit (`policyId.assetNameHex`) and network.
 *
 * @param asset - Asset unit from payment requirements
 * @param network - Cardano network identifier (CAIP-2 or CIP-34 alias)
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<CardanoDefaultAsset> = (asset, network) => {
  const assets = DEFAULT_ASSETS[normalizeCardanoNetwork(network)];
  if (!assets) {
    return undefined;
  }
  const normalized = asset.toLowerCase();
  return assets.find(entry => entry.asset.toLowerCase() === normalized);
};
