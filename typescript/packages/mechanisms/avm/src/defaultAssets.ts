import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
  Network,
} from "@x402/core/types";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_DECIMALS,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from "./constants";
import { normalizeAlgorandNetwork } from "./utils";

export type AvmDefaultAsset = DefaultAsset;

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<AvmDefaultAsset> = {
  [ALGORAND_MAINNET_CAIP2]: [
    { asset: USDC_MAINNET_ASA_ID, decimals: USDC_DECIMALS, symbol: "USDC" },
  ],
  [ALGORAND_TESTNET_CAIP2]: [
    { asset: USDC_TESTNET_ASA_ID, decimals: USDC_DECIMALS, symbol: "USDC" },
  ],
};

/**
 * Map Algorand network id to a {@link DEFAULT_ASSETS} key.
 *
 * @param network - CAIP-2 or legacy Algorand network id
 * @returns Normalized CAIP-2 network key
 */
function resolveNetworkKey(network: Network): string {
  return normalizeAlgorandNetwork(network);
}

/**
 * Look up a default asset by network and optional ticker.
 *
 * @param network - CAIP-2 network
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<AvmDefaultAsset> = (network, symbol?) => {
  const key = resolveNetworkKey(network);
  const assets = DEFAULT_ASSETS[key];
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
 * @param asset - ASA id from payment requirements
 * @param network - CAIP-2 network
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<AvmDefaultAsset> = (asset, network) => {
  const key = resolveNetworkKey(network);
  const assets = DEFAULT_ASSETS[key];
  if (!assets) {
    return undefined;
  }
  return assets.find(entry => entry.asset === asset);
};
